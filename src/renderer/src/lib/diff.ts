/**
 * Unified patch 的行分类。
 * edit 工具的 details.patch 已是标准 unified diff，按行前缀判定类型即可。
 */

export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

/** 按前缀判定单行类型；顺序要紧：头信息必须先于增删判定 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}
