// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * durable 视图 → `ConversationView` 的投影。
 *
 * 渲染层只认 `@shared/worker-protocol` 的形状，而 durable 的条目 / 文档是另一套结构。
 * 这一层把 durable 的「条目 + 内置文档」翻译成旧投影器（`../lib/project`）吃得下的
 * transcript，再把 `pi.live` / `pi.inbox` / `pi.usage` 折算成流式文本、运行中工具、
 * 排队数与统计。
 *
 * **为什么复用 `projectTranscript`**：消息 / 工具结果 / 技能标记 / 压缩条目的投影规则
 * 在两套内核下必须逐字一致——否则切换内核时界面会「看起来还能用，但细节全变了」，
 * 而这类差异很难靠冒烟逐条发现。翻译层只做形状映射，判断全留在旧函数里。
 */
import {
  AssistantEntry,
  CompactionEntry,
  SystemEntry,
  ToolResultEntry,
  UserEntry,
  type ConversationView as DurableConversationView,
  type EntryRecord,
  type InboxState,
  type LiveState,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";

import type {
  ConversationView,
  ViewFileChange,
  ViewRunningTool,
  ViewRunOutcome,
  ViewSkill,
  ViewSubagent,
} from "@shared/worker-protocol";
import type { ThinkingLevel } from "@shared/thinking-level";
import type { ViewTodo } from "@shared/todo";
import { promptTokensOf } from "@shared/token-usage";

import {
  extractText,
  extractThinking,
  extractToolCalls,
  projectTranscript,
} from "../lib/project";
import { skillPathMatcher } from "../lib/skills";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 压缩摘要的 content 可能是纯字符串（内核把摘要包成一条 user 消息）；两种形态都要认 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return extractText(content);
}

/** user 消息的 content 允许是纯字符串；旧投影器只处理内容块数组，这里先归一 */
function normalizeMessage(message: Message): Message {
  if (message.role === "user" && typeof message.content === "string") {
    return { ...message, content: [{ type: "text", text: message.content }] };
  }
  return message;
}

/**
 * durable 的 active entries → 旧投影器认识的 transcript 形状。
 *
 * 映射规则：
 *  - `pi.user` / `pi.assistant` / `pi.tool-result` → `{ type: "message", message }`；
 *  - `pi.compaction` → `{ type: "compaction", summary, tokensBefore }`（摘要正文在 model[0] 里）；
 *  - `pi.system` → **跳过**：它是提示词 / 工具清单的位置性条目，不是对话内容；
 *  - `pi.reset` → 有 handoff 文本时按 user 消息展示，没有就跳过（它标记新上下文起点）；
 *  - 其它（应用自己的展示性条目）→ 有 model 消息就展示，没有就跳过。
 */
export function durableTranscript(entries: readonly EntryRecord[]): unknown[] {
  const out: unknown[] = [];
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === SystemEntry.kind) continue;
    if (entry.kind === CompactionEntry.kind) {
      out.push({
        type: "compaction",
        id: String(entry.id),
        summary: message === undefined ? "" : textOf(message.content),
        // durable 的压缩条目只记 reason；旧界面在 <=0 时不显示数字（见 ViewMessage.compaction）
        tokensBefore: 0,
        timestamp: message?.timestamp,
      });
      continue;
    }
    if (message === undefined) continue;
    out.push({ type: "message", id: String(entry.id), message: normalizeMessage(message) });
  }
  return out;
}

/** 这份 transcript 里真正参与对话的条目数（system / reset 不算） */
function countMessages(entries: readonly EntryRecord[]): number {
  let count = 0;
  for (const entry of entries) {
    if (
      entry.kind === UserEntry.kind ||
      entry.kind === AssistantEntry.kind ||
      entry.kind === ToolResultEntry.kind ||
      entry.kind === CompactionEntry.kind
    ) {
      count += 1;
    }
  }
  return count;
}

/** durable 的 usage 文档（按模型分桶）→ 单份合计 */
export function sumUsage(state: UsageState | undefined): Usage {
  const total: Usage = {
    ...ZERO_USAGE,
    cost: { ...ZERO_USAGE.cost },
  };
  if (state === undefined) return total;
  for (const usage of Object.values(state.models)) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;
    total.cost.input += usage.cost.input;
    total.cost.output += usage.cost.output;
    total.cost.cacheRead += usage.cost.cacheRead;
    total.cost.cacheWrite += usage.cost.cacheWrite;
    total.cost.total += usage.cost.total;
  }
  return total;
}

/**
 * 当前上下文占用：最近一条带 usage 的助手消息的 prompt tokens。
 *
 * 不能用累计的 `pi.usage`（它随轮次二次增长，几个问题就能把进度条顶满）；
 * 与旧内核的 `contextUsed` 是同一口径（见 `@shared/token-usage`）。
 */
function contextUsedOf(entries: readonly EntryRecord[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.kind !== AssistantEntry.kind) continue;
    const message = entry.model?.[0] as AssistantMessage | undefined;
    if (message?.usage !== undefined) return promptTokensOf(message.usage);
  }
  return 0;
}

/** 工具调用 id → 入参 / 开始时间：运行中的工具卡要显示命令与已跑时长 */
function toolCallIndex(entries: readonly EntryRecord[]): {
  args: Map<string, string>;
  startedAt: Map<string, number>;
} {
  const args = new Map<string, string>();
  const startedAt = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== AssistantEntry.kind) continue;
    const message = entry.model?.[0];
    if (message === undefined) continue;
    for (const call of extractToolCalls(message.content)) {
      args.set(call.id, call.args);
      startedAt.set(call.id, message.timestamp);
    }
  }
  return { args, startedAt };
}

export function liveRunningTools(
  live: LiveState | undefined,
  entries: readonly EntryRecord[],
): ViewRunningTool[] {
  const { args, startedAt } = toolCallIndex(entries);
  const slots = live?.tools ?? [];
  return slots
    .filter((slot) => slot.status !== "done")
    .map((slot) => {
      const details = slot.details as { fullOutputPath?: string } | undefined;
      return {
        id: slot.callId,
        name: slot.name,
        args: args.get(slot.callId) ?? "{}",
        output: typeof slot.output === "string" ? slot.output : "",
        ...(typeof details?.fullOutputPath === "string"
          ? { fullOutputPath: details.fullOutputPath }
          : {}),
        startedAt: startedAt.get(slot.callId) ?? 0,
      };
    });
}

export function livePartialText(live: LiveState | undefined): {
  text: string | null;
  thought: string | null;
} {
  const message = live?.generation?.message as AssistantMessage | undefined;
  if (message === undefined) return { text: null, thought: null };
  const text = extractText(message.content);
  const thought = extractThinking(message.content);
  return {
    text: text.length > 0 ? text : null,
    thought: thought.length > 0 ? thought : null,
  };
}

export interface DurableProjectionMeta {
  sessionId: string;
  cwd: string;
  model: string;
  imageInput: boolean;
  thinkingLevel: ThinkingLevel;
  skills: ViewSkill[];
  /** 文件改动真源在主进程的库；这里恒为空，主进程会用库里那份覆盖 */
  fileChanges: ViewFileChange[];
  /** 待办同理：真源在主进程 */
  todos: ViewTodo[];
  /** 最近一轮运行的终态（由 worker 从 run_start / run_end 事件维护） */
  lastRun: ViewRunOutcome | null;
  /** 子代理总账（durable 下由后台任务投影；骨架阶段为空） */
  subagents: readonly ViewSubagent[];
}

export function projectDurableView(
  view: DurableConversationView,
  meta: DurableProjectionMeta,
): ConversationView {
  const transcript = durableTranscript(view.entries);
  const { messages, toolResults } = projectTranscript(
    transcript,
    new Map<string, number>(),
    skillPathMatcher(meta.skills, meta.cwd),
  );

  // 工具耗时由结果条目自带（`ToolResultMessage.durationMs`），重启后仍可重建，
  // 不依赖内存里的 tracker —— 这比旧内核靠事件配对更耐崩。
  for (const entry of view.entries) {
    if (entry.kind !== ToolResultEntry.kind) continue;
    const message = entry.model?.[0] as { toolCallId?: string; durationMs?: number } | undefined;
    if (typeof message?.toolCallId !== "string" || typeof message.durationMs !== "number") continue;
    for (const item of messages) {
      for (const call of item.toolCalls) {
        if (call.id === message.toolCallId) call.durationMs = message.durationMs;
      }
    }
  }

  const live = view.docs["pi.live"] as unknown as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as unknown as InboxState | undefined;
  const usageState = view.docs["pi.usage"] as unknown as UsageState | undefined;
  const usage = sumUsage(usageState);
  const streaming = livePartialText(live);
  const compactions = live?.compactions?.length ?? 0;
  const running = live?.run !== undefined;

  return {
    sessionId: meta.sessionId,
    model: meta.model,
    imageInput: meta.imageInput,
    thinkingLevel: meta.thinkingLevel,
    skills: meta.skills,
    messages,
    toolResults,
    fileChanges: meta.fileChanges,
    todos: meta.todos,
    streamingText: streaming.text,
    thought: streaming.thought,
    runningTools: liveRunningTools(live, view.entries),
    subagents: [...meta.subagents],
    running: running || compactions > 0,
    runningOperation: running ? (compactions > 0 ? "compaction" : "run") : compactions > 0 ? "compaction" : null,
    lastRun: meta.lastRun,
    queuedCount: inbox?.items.length ?? 0,
    stats: {
      messageCount: countMessages(view.entries),
      promptTokens: promptTokensOf(usage),
      outputTokens: usage.output,
      totalTokens: usage.totalTokens,
      costUsd: usage.cost.total,
      contextUsed: contextUsedOf(view.entries),
    },
  };
}
