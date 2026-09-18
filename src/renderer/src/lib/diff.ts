// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * Unified patch 的行分类。
 * edit 工具的 details.patch 已是标准 unified diff，按行前缀判定类型即可。
 */

export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

/**
 * 按前缀判定单行类型；顺序要紧：头信息必须先于增删判定。
 *
 * `inHunk`：是否已进入某个 `@@` 范围。头信息（`---` / `+++`）只可能出现在第一个
 * hunk 之前——hunk 内以 `---` 开头的是**被删除的正文行**（比如删掉 markdown 的
 * `---` 分隔线、SQL 的 `--` 注释），按 meta 着成灰色会让用户以为那行没被删。
 */
export function classifyDiffLine(line: string, inHunk = false): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}
