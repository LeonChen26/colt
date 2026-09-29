// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「输入 tokens」的**唯一口径**：送进模型的 prompt 总量。
 *
 * 内核 `Usage.input` 是**扣除缓存后的净输入**，不是这一轮喂进去的上下文：
 *   `pi-ai` 的 `openai-completions`：`input = prompt_tokens - cacheRead - cacheWrite`；
 *   Anthropic 的 `input_tokens` 本身就不含 `cache_read/creation`。
 * 于是长会话里只报 `input` 会把「输入」报小一个数量级——命中缓存的那部分往往是主体
 * （实测某会话累计净输入 103,246、缓存读 4,004,672，相差 39 倍），
 * 界面上就成了「输入 103K / 输出 47K」这种看着像统计坏了的结论。
 *
 * 公式与 `telemetry.ts` 的上下文占用（`contextUsedFromUsage`）**同源**：
 *   prompt tokens = input + cacheRead + cacheWrite
 * 会话视图 stats、子代理 stats、占用条三处都走这个函数，不再各写一遍加法
 * （同一件事两处口径不一致，是本仓反复踩过的坑）。
 */
export interface PromptTokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** prompt tokens = 净输入 + 缓存读 + 缓存写 */
export function promptTokensOf(usage: PromptTokenUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}
