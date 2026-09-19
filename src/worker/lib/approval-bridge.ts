// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * worker 侧的审批往返桥。
 *
 * 形态与 `HostBridge`（宿主能力）完全一致：worker 发请求、阻塞，由主进程回
 * `approvalResult` 唤醒。主进程持有策略与用户界面，worker 只负责阻塞与执行结果。
 *
 * 为什么单列一个模块：它是 `entry.ts` 里自成一体的一段（发请求 + 等答复 + 超时），
 * 而 `entry.ts` 是体量闸的棘轮大户（`tests/size-guard.test.ts`），新逻辑必须压进新文件
 * （`AGENTS.md` §1.4）。搬的是「一个完整往返」，行为一字不改。
 *
 * 超时是**拦截**而不是放行——这是安全默认值：主进程失联时宁可拒绝执行。
 */
import { APPROVAL_TIMEOUT_MS } from "@shared/limits";
import type { WorkerMessage } from "@shared/worker-protocol";

/** 启用 COLT_APPROVAL_DEBUG=1 时输出审批链路日志（排查安全功能为何未生效时用） */
export function trace(message: string): void {
  if (process.env.COLT_APPROVAL_DEBUG === "1") {
    process.stderr.write(`[approval] ${message}\n`);
  }
}

interface Pending {
  resolve: (value: { approved: boolean; reason: string }) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalBridge {
  readonly #send: (message: WorkerMessage) => void;
  readonly #pending = new Map<string, Pending>();

  constructor(send: (message: WorkerMessage) => void) {
    this.#send = send;
  }

  /**
   * 发起一次审批并阻塞，直到主进程答复或超时。
   * `subagent` 在非空时带上——界面据此在阻塞卡上标出「来自 <子代理名>」。
   */
  request(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    subagent?: { id: string; name: string },
  ): Promise<{ approved: boolean; reason: string }> {
    let argsJson = "{}";
    try {
      argsJson = JSON.stringify(args ?? {});
    } catch {
      argsJson = "{}";
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(toolCallId);
        resolve({ approved: false, reason: "审批超时，已自动拒绝。如需执行请重新发起。" });
      }, APPROVAL_TIMEOUT_MS);
      // 不阻止进程退出
      timer.unref?.();

      this.#pending.set(toolCallId, { resolve, timer });
      trace(`已发出请求 ${toolName} ${toolCallId}`);
      this.#send({
        type: "approvalRequest",
        toolCallId,
        toolName,
        argsJson,
        timeoutMs: APPROVAL_TIMEOUT_MS,
        ...(subagent === undefined ? {} : { subagent }),
      });
    });
  }

  /** 主进程答复到达，唤醒对应的阻塞 */
  settle(toolCallId: string, approved: boolean, reason?: string): void {
    const entry = this.#pending.get(toolCallId);
    if (entry === undefined) return;
    this.#pending.delete(toolCallId);
    clearTimeout(entry.timer);
    entry.resolve({
      approved,
      reason: reason ?? "用户拒绝了这次工具调用。请换一种做法，或先向用户说明原因。",
    });
  }
}
