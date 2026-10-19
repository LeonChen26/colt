// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * durable 内核下的 `/memory-tidy`。
 *
 * 旧内核把它跑在一条独立 lane 上（`TIDY_LANE`），durable 没有 lane —— 对应物是一个
 * **ownerless 子对话**：独立 transcript、独立 `instructions`、独立的工具白名单。
 * 三件事与旧实现逐条对齐：
 *  - **不从主对话继承上下文**：子对话的提示词是 `memoryTidySystemPrompt`，不是编码助手；
 *  - **审批照常**：`ToolTask` 钩子是全局的，整理写记忆文件照样过闸门；
 *  - **结果必须有出口**：子对话对界面不可见，完成 / 失败都要由调用方报一声。
 *
 * 刻意**不复用** `DurableSubagents`：那个是「模型委派」的入口（有并发上限、收据、视图卡片），
 * 整理是用户命令，不该占委派额度，也不该出现在子代理总账里。
 */
import type { Context } from "@earendil-works/chord";
import type { Harness, ToolRegistration } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { memoryFilePath, readMemoryFile } from "../lib/memory";
import {
  TIDY_TOOLS,
  describeTidyOutcome,
  memoryTidyDoneNotice,
  memoryTidySystemPrompt,
  memoryTidyTask,
} from "../lib/memory-tidy";

export interface MemoryTidyDeps {
  harness: Harness;
  cwd: string;
  /**
   * 整理子对话是 ownerless 的，**不继承**主对话的 agent——模型必须显式给，
   * 否则它根本没有模型可跑（durable 的 ownerless 会话从空 agent 开始）。
   */
  model: { provider: string; modelId: string };
  /** 当前注册表里的工具：按 `TIDY_TOOLS` 过滤成硬白名单 */
  tools: readonly ToolRegistration[];
  reportMemoryIndex: (scope: "project", content: string | null) => void;
}

export type MemoryTidyOutcome =
  | { ok: true; notice: string }
  | { ok: false; message: string };

export async function runMemoryTidy(
  deps: MemoryTidyDeps,
  context: Context,
): Promise<MemoryTidyOutcome> {
  const byName = new Map<string, ToolRegistration>();
  for (const tool of deps.tools) byName.set(tool.name, tool);
  const missing = TIDY_TOOLS.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `记忆整理所需的工具不可用：${missing.join("、")}。`,
    };
  }
  const allowed = TIDY_TOOLS.map((name) => byName.get(name)).filter(
    (tool): tool is ToolRegistration => tool !== undefined,
  );

  const conversation = await deps.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        model: deps.model,
        instructions: memoryTidySystemPrompt(deps.cwd),
        cwd: deps.cwd,
        tools: allowed,
      },
    },
    context,
  );

  const submission = await conversation.submit(
    { type: "input", content: memoryTidyTask() },
    context,
  );
  const settled = await submission.wait(context);
  if (settled.status !== "done") {
    return {
      ok: false,
      message: describeTidyOutcome({ status: settled.status }),
    };
  }

  // `done` 只说明提交被回答了；模型报错仍然是一条 assistant 条目
  const view = await conversation.context(context);
  for (let index = view.entries.length - 1; index >= 0; index -= 1) {
    const entry = view.entries[index];
    if (entry === undefined || entry.kind !== "assistant") continue;
    const message = entry.model?.[0] as AssistantMessage | undefined;
    if (message?.stopReason === "error") {
      return {
        ok: false,
        message: describeTidyOutcome({
          status: "failed",
          error: { message: message.errorMessage ?? "原因未知" },
        }),
      };
    }
    break;
  }

  // 整理刚可能重写过记忆文件：立即重读上报，让检索索引同步
  const fresh = await readMemoryFile(memoryFilePath(deps.cwd));
  if (fresh.error === undefined) deps.reportMemoryIndex("project", fresh.content);
  return { ok: true, notice: memoryTidyDoneNotice() };
}
