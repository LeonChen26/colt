// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 思考等级（会话级配置）。
 *
 * 内核的 canonical 取值是 `off | minimal | low | medium | high | xhigh | max`，
 * 界面只开放其中四档：其余几档对绝大多数 provider 会被钳制到相邻档，放出来只会
 * 让用户以为选了 A 实际跑的是 B。需要时再按模型能力放开。
 *
 * **默认值不能再是 off**：pi-ai 的 provider 兼容层会把 off 翻译成「显式关闭思考」
 * （zai 协议必写 `thinking:{"type":"disabled"}`），而「始终思考」的模型会直接 400
 * ——压缩、审批分析器这类**不带工具**的请求会因此整条失效。
 */
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 默认等级；同时兜住「库里是 NULL / 脏值」的情况 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * 把库里存的值收敛成一个合法等级。
 *
 * 只有**用户显式选过**的合法值才被沿用；NULL（新字段、从未选过）与历史脏值
 * 一律回落到默认值。注意 off 是合法值：旧会话在库里是 NULL，会被回落到 high，
 * 于是内核对老会话持久化的 off（那时谁都没选过）会被显式覆盖掉。
 */
export function resolveThinkingLevel(stored: string | null | undefined): ThinkingLevel {
  return isThinkingLevel(stored) ? stored : DEFAULT_THINKING_LEVEL;
}

/** 把库里存的原始值收敛成「会话可选值」：非法 / 空值一律视为「从未选过」（null） */
export function toStoredThinkingLevel(value: string | null | undefined): ThinkingLevel | null {
  return isThinkingLevel(value) ? value : null;
}
