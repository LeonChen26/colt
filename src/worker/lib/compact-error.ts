// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 把内核 `lane.compact()` 的失败原因翻译成给用户看的一句话。
 *
 * ⚠️ 内核压缩的失败**走 `Result.err` 而不是抛异常**：accept 阶段被拒（`LaneBusy` /
 * `NothingToCompact` / `Closed`），或摘要请求失败（`CompactionError`）。worker 侧必须
 * 显式检查返回值，否则这些失败全部静默——用户点压缩只会「点了没反应」。
 * 这些错误类不在本仓类型面里（worker 只拿到运行时对象），故按 `_tag`（TaggedError）
 * 与 `code`（CompactionError）判别，与内核 `result.js` / `compaction.js` 的定义对齐。
 */

/** 压缩失败的几种形态 → 给用户看的一句话 */
export function describeCompactError(error: unknown): string {
  const tag = (error as { _tag?: string } | undefined)?._tag;
  switch (tag) {
    case "NothingToCompact":
      return "没有可压缩的内容：会话还没有消息，或刚压缩过还没有新对话。";
    case "LaneBusy":
      return "当前有正在进行的任务，无法压缩：请等它结束，或先停止当前任务。";
    case "Closed":
      return "会话已关闭，无法压缩。";
  }
  if ((error as { code?: string } | undefined)?.code === "aborted") return "压缩已中止。";
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | undefined)?.message === "string"
        ? (error as { message: string }).message
        : String(error);
  return `压缩上下文失败：${message}`;
}

/**
 * 压缩操作**运行后**结算的终态（`OperationResultRecord.status !== "completed"`）→ 给用户看的一句话。
 *
 * ⚠️ 这条失败路径**不走 `Result.err`**：摘要请求失败（`CompactionError`）会被内核结算成
 * `ok: true` 但 `record.status === "failed"`（`OperationError` 是普通对象，带 `code` / `message`）。
 * 只查 `Result.err` 的话，最常见的失败（密钥 / 网络 / 模型错误）依旧静默。
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
