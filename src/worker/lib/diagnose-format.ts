// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 诊断结论 → 追加进工具结果的文本段（纯函数）。
 *
 * 措辞纪律（DESIGN-afterwrite.md D4）：
 * - 有问题 → 逐项列出，输出原文带上（有界，见 diagnose-config 的上限）；
 * - 没问题 → 一句话带过（模型不需要更多，用户看工具卡也只需要这个）；
 * - 跳过 → 「跳过：<原因>」，**永不静默**——沉默的跳过会被模型读成「检查过了」。
 */
import type { DiagnoseOutcome } from "./diagnose-run";

/** 一轮诊断（fast 同步那批，或 slow 防抖那批）的完整追加文本 */
export function formatDiagnoseSection(outcomes: readonly DiagnoseOutcome[]): string {
  if (outcomes.length === 0) return "";
  const lines: string[] = ["---", "写后诊断："];
  for (const outcome of outcomes) lines.push(...formatOutcome(outcome));
  return lines.join("\n");
}

function formatOutcome(outcome: DiagnoseOutcome): string[] {
  const head = `${outcome.label}（${outcome.kind === "fast" ? "文件级" : "全仓"}）：`;
  switch (outcome.status) {
    case "clean":
      return [`- ${head}通过`];
    case "skipped":
      return [`- ${head}跳过：${outcome.skippedReason ?? "原因未知"}`];
    case "problems": {
      const lines = [`- ${head}发现问题`];
      if (outcome.output) {
        for (const line of outcome.output.replace(/\s+$/, "").split("\n")) {
          lines.push(`  ${line}`);
        }
      }
      return lines;
    }
  }
}

/**
 * slow（防抖、异步）批次的消息版：经 ephemeral notice 注入下一请求，
 * 模型读到时写入已是几步之前，措辞要点明这一点。
 */
export function formatSlowNotice(outcomes: readonly DiagnoseOutcome[]): string {
  if (outcomes.length === 0) return "";
  const problems = outcomes.filter((item) => item.status === "problems");
  if (problems.length === 0) return "";
  const lines = [
    "写后诊断（全仓检查，在你早些时候的文件写入之后运行）：",
    ...problems.flatMap((item) => formatOutcome(item)),
  ];
  return lines.join("\n");
}
