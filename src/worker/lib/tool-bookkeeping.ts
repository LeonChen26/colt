// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 工具调用的进程内记账：**耗时**与**发起它的 lane**。
 *
 * 两张表都按 toolCallId 配对读写（`before_tool` 记、`after_tool` 清），都有上限避免长会话
 * 无界增长。单列一个模块是因为 `entry.ts` 是体量闸的棘轮大户（`AGENTS.md` §1.4）——
 * 搬的是「两张有界记账表 + 各自的读写」这**一整块**，行为一字不改。
 */
import { agentNameFromLane, isSubagentLane } from "./subagent";

/**
 * toolCallId → 发起它的 lane 名。
 *
 * 审批与提问都要如实标出「来自哪个子代理」，而这两条入口只拿得到 toolCallId；
 * lane 只有 `before_tool` 知道（且 `ask_user` 在那里被提前放行，压根不记录就会丢）。
 */
const toolLanes = new Map<string, string>();
const TOOL_LANE_LIMIT = 512;

export function rememberToolLane(toolCallId: string, lane: string): void {
  if (toolLanes.size >= TOOL_LANE_LIMIT) {
    const oldest = toolLanes.keys().next().value;
    if (oldest !== undefined) toolLanes.delete(oldest);
  }
  toolLanes.set(toolCallId, lane);
}

/** `after_tool` 里配对清理（提问与审批此时都已答复完，来源不再需要） */
export function forgetToolLane(toolCallId: string): void {
  toolLanes.delete(toolCallId);
}

/** 某个 lane 是否子代理；是则给出 { 身份 = lane 名, 显示名 }（主 lane 返回 undefined） */
export function subagentRefOfLane(lane: string): { id: string; name: string } | undefined {
  if (!isSubagentLane(lane)) return undefined;
  return { id: lane, name: agentNameFromLane(lane) ?? "子代理" };
}

/** 按 toolCallId 反查发起它的子代理（未记录 / 不是子代理都返回 undefined） */
export function subagentRefOf(toolCallId: string): { id: string; name: string } | undefined {
  return subagentRefOfLane(toolLanes.get(toolCallId) ?? "");
}

/** 已完成的工具调用耗时（toolCallId → ms），供工具卡片展示；有上限避免无界增长 */
export const toolDurations = new Map<string, number>();
const TOOL_DURATION_LIMIT = 512;

export function rememberDuration(toolCallId: string, durationMs: number | null): void {
  if (durationMs === null) return;
  if (toolDurations.size >= TOOL_DURATION_LIMIT) {
    const oldest = toolDurations.keys().next().value;
    if (oldest !== undefined) toolDurations.delete(oldest);
  }
  toolDurations.set(toolCallId, durationMs);
}
