// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 写后诊断的执行封装：一次检查命令的受控执行 + 慢检查的防抖调度。
 *
 * 执行复用 durable 的 `NodeExecutionEnv.exec`：输出经 `onOutput` 逐段到达，这里按
 * `diagnose-config.ts` 的上限**只留尾部**（与内核 bash 工具的 retain=tail 同口径），
 * 超时由 exec 自己兑现。
 * 失败三态必须可区分：`skipped`（起不来 / 没得查）、`problems`（非零退出）、`clean`
 * ——绝不让「检查器坏了」伪装成「检查过了，没问题」（`docs/ERRORS.md` 失败可见原则）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  DIAGNOSE_OUTPUT_LIMIT_BYTES,
  DIAGNOSE_OUTPUT_LIMIT_LINES,
  SLOW_DEBOUNCE_MS,
  planDiagnose,
  type DiagnoseCheck,
} from "./diagnose-config";

/**
 * 执行原语：与 durable `ExecutionEnv.exec` 同形（收敛成这个窄签名以便单测注入）。
 * Result/E 的结构按实际返回做结构化收窄，不引入内核内部类型。
 */
export type ExecFn = (
  command: string,
  options: {
    cwd: string;
    timeout: number;
    /** 逐段的原始输出（stdout / stderr 按到达顺序合并） */
    onOutput?: (text: string) => void;
  },
  context: Context,
) => Promise<
  { ok: true; value: { exitCode: number } } | { ok: false; error: { message?: string } }
>;

/** 一次检查的结论。`output` 与 `skippedReason` 互斥，`clean` 时两者皆空 */
export interface DiagnoseOutcome {
  readonly label: string;
  readonly kind: "fast" | "slow";
  readonly status: "clean" | "problems" | "skipped";
  /** status=problems 时的有界输出原文（retain=tail，最后一段最相关） */
  readonly output?: string;
  /** status=skipped 的原因（工具没装 / 启动失败） */
  readonly skippedReason?: string;
}

/**
 * 执行一条检查命令。exec 抛异常（shell 没了等）也归一成 `skipped`——
 * 「没法查」不是「查出了问题」，两者在追加段里的措辞不同。
 */
export async function execCheck(
  exec: ExecFn,
  cwd: string,
  context: Context,
  check: DiagnoseCheck,
  command: string,
): Promise<DiagnoseOutcome> {
  let output = "";
  const result = await exec(
    command,
    {
      cwd,
      timeout: check.timeoutSec,
      onOutput: (chunk) => {
        output = keepTail(output + chunk);
      },
    },
    context,
  ).catch((error: unknown) => ({
    ok: false as const,
    error: { message: error instanceof Error ? error.message : String(error) },
  }));

  if (!result.ok) {
    return {
      label: check.label,
      kind: check.kind,
      status: "skipped",
      skippedReason: result.error.message ?? "启动失败",
    };
  }
  if (result.value.exitCode !== 0) {
    return {
      label: check.label,
      kind: check.kind,
      status: "problems",
      output: output === "" ? "(无输出)" : output,
    };
  }
  return { label: check.label, kind: check.kind, status: "clean" };
}

/**
 * 只留尾部（行数与字节数双双设限，与内核 bash 的 retain=tail 同口径）。
 *
 * 为什么按尾部保留：检查器的结论总在最后几行，头部多半是「正在检查…」这类噪音。
 * 这里逐段裁剪而不是最后一次裁——否则一次全仓 tsc 的输出会在内存里长到完整体量。
 */
function keepTail(text: string): string {
  let next = text;
  const lines = next.split("\n");
  if (lines.length > DIAGNOSE_OUTPUT_LIMIT_LINES) {
    next = lines.slice(lines.length - DIAGNOSE_OUTPUT_LIMIT_LINES).join("\n");
  }
  if (Buffer.byteLength(next, "utf8") > DIAGNOSE_OUTPUT_LIMIT_BYTES) {
    const bytes = Buffer.from(next, "utf8");
    // 截断点可能落在一个多字节字符**中间**：跳过开头的续字节（0b10xxxxxx），
    // 否则解码会在保留文本最前面吐出 1~3 个 U+FFFD（中文输出下概率不低）。
    let start = bytes.length - DIAGNOSE_OUTPUT_LIMIT_BYTES;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
    next = bytes.subarray(start).toString("utf8");
  }
  return next;
}

/**
 * 慢检查的防抖调度器。
 *
 * 窗口内多次写入**合并**：按检查器标签去重（同一全仓检查只跑一次），写入停止
 * `SLOW_DEBOUNCE_MS` 后作为**一批**执行（串行）。执行中又到期 → 记 `pendingRerun`，
 * 本批跑完后再排一轮——绝不并发跑两个全仓检查（两份 tsc 同时吃满 CPU，谁也不快）。
 */
export class SlowDiagnoseDebouncer {
  #timer: NodeJS.Timeout | undefined;
  readonly #pending = new Map<string, { check: DiagnoseCheck; existsProbe: () => boolean }>();
  #running = false;
  #pendingRerun = false;
  readonly #runBatch: (batch: { check: DiagnoseCheck; existsProbe: () => boolean }[]) => Promise<void>;
  readonly #debounceMs: number;

  constructor(
    runBatch: (batch: { check: DiagnoseCheck; existsProbe: () => boolean }[]) => Promise<void>,
    /** 测试注入小间隔快进；生产用默认值 */
    debounceMs: number = SLOW_DEBOUNCE_MS,
  ) {
    this.#runBatch = runBatch;
    this.#debounceMs = debounceMs;
  }

  /** 记一次写入命中的 slow 检查器（窗口内去重），并重置计时 */
  schedule(check: DiagnoseCheck, existsProbe: () => boolean): void {
    this.#pending.set(check.label, { check, existsProbe });
    this.#arm();
  }

  async #flush(): Promise<void> {
    this.#timer = undefined;
    if (this.#running) {
      // 上一批还在跑：记下重跑意图，本批结束时再排（此时 #pending 里已有新写入的项）
      this.#pendingRerun = true;
      return;
    }
    this.#running = true;
    try {
      const batch = [...this.#pending.values()];
      this.#pending.clear();
      await this.#runBatch(batch);
    } finally {
      this.#running = false;
    }
    // 到期时上一批还没跑完的那个定时器已经消费掉了，这里必须补排，
    // 否则「运行中到期」的这批写入永远没人执行
    if (this.#pendingRerun) {
      this.#pendingRerun = false;
      if (this.#pending.size > 0) this.#arm();
    }
  }

  #arm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    // 不阻止进程退出：worker 收 dispose 后不该被一个诊断拖住
    this.#timer = setTimeout(() => void this.#flush(), this.#debounceMs);
    this.#timer.unref?.();
  }

  /**
   * 丢弃待跑批次并停表。**可复用**：之后 schedule 照常工作——
   * 它承担的是「设置开关关掉时收尾」的职责，不是终态。
   */
  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending.clear();
    this.#pendingRerun = false;
  }
}

/** 项目根相对标记的探测（worker 侧唯一碰盘的点，包装出来便于测试替换） */
export function markerProbe(cwd: string): (marker: string) => boolean {
  return (marker: string) => existsSync(join(cwd, marker));
}

/** 便捷转发：保持本文件是执行侧唯一入口 */
export { planDiagnose };
