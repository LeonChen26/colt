// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 把压缩的失败原因翻译成给用户看的一句话。
 *
 * durable 下压缩是一次任务：`waitForTask` 回来的 `outcome.status` 不是 `completed`
 * 时才算失败（`failed` / `faulted` / `aborted` / `declined`），错误对象就是普通的
 * `{ message }`——**没有**旧内核那层 `Result.err`。失败必须显式翻成文案，
 * 否则用户点压缩只会「点了没反应」。
 *
 * 本文件管压缩的**用户可见文案**。
 */

/**
 * 压缩操作**运行后**结算的终态（`outcome.status !== "completed"`）→ 给用户看的一句话。
 */
export function describeCompactOutcome(record: {
  status: string;
  error?: { code?: string; message?: string };
}): string {
  if (record.status === "aborted" || record.error?.code === "aborted") return "压缩已中止。";
  if (record.error?.message) return `压缩上下文失败：${record.error.message}`;
  if (record.status === "declined") return "压缩未执行。";
  return "压缩上下文失败：原因未知。";
}
