// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 子代理的**视图投影**：`LaneSnapshot` → `ViewSubagent`（纯函数）。
 *
 * 与 `project.ts` 对主对话做的事完全同形，只是**有界**：视图是全量快照、流式期间
 * 每 50ms 整份重推（`worker/entry.ts` 的 `scheduleFlush`），若把子代理的整份流塞进去，
 * 开销会按「子代理数 × 推送次数」乘上去。故只带最近 `MAX_SUBAGENT_STEPS_IN_VIEW` 步，
 * 但**如实给出真实总步数**——截断可以，静默截断不行（`docs/ERRORS.md`）。
 */
import type { LaneSnapshot } from "@earendil-works/pi-agent-core";
import type { ViewSubagent } from "@shared/worker-protocol";
import { extractText, extractThinking, projectRunningTools, projectTranscript } from "./project";

/**
 * 视图里保留的最近步数。
 *
 * 放在本文件而不是 `worker/lib/subagent.ts`（编排那侧）：截断是**投影**的责任，
 * 常量跟着它走才不会出现「改了上限、另一处还在按旧值截」的漂移。
 */
export const MAX_SUBAGENT_STEPS_IN_VIEW = 12;

/** 投影一个子代理实例所需的全部输入（编排侧的注册表按这个形状提供） */
export interface SubagentProjectionInput {
  id: string;
  toolCallId: string;
  name: string;
  title: string;
  status: ViewSubagent["status"];
  startedAt: number;
  endedAt?: number;
  error?: string;
  /** 走到时间上限、由交接收尾（见 `ViewSubagent.handedOff`） */
  handedOff?: boolean;
  snapshot: LaneSnapshot;
  stats: { inputTokens: number; outputTokens: number; costUsd: number };
  /**
   * 工具耗时表（toolCallId → ms）。**必须由调用方给**：不给的话有界预览里的每条
   * `toolCalls[].durationMs` 都会缺，而完整流（`session.subagentTranscript`）却有——
   * 同一件事两处口径不一致，看起来像「预览坏了」。
   */
  durations?: ReadonlyMap<string, number>;
}

export function projectSubagent(input: SubagentProjectionInput): ViewSubagent {
  const { messages } = projectTranscript(input.snapshot.transcript, input.durations ?? new Map());
  const streaming = input.snapshot.operation?.streamingMessage;
  const thought = streaming ? extractThinking(streaming.content) : "";
  return {
    id: input.id,
    toolCallId: input.toolCallId,
    name: input.name,
    title: input.title,
    status: input.status,
    startedAt: input.startedAt,
    ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.handedOff === undefined ? {} : { handedOff: input.handedOff }),
    tail: {
      streamingText: streaming ? extractText(streaming.content) || null : null,
      thought: thought.length > 0 ? thought : null,
      runningTools: projectRunningTools(input.snapshot.operation),
      recentSteps: messages.slice(-MAX_SUBAGENT_STEPS_IN_VIEW),
      // 真实总步数：截断时界面要能说「最近 12 / 共 N 步」，不许只给可见的那部分
      stepCount: messages.length,
    },
    stats: { ...input.stats },
  };
}
