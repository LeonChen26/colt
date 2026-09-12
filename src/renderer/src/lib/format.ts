/**
 * 展示层的格式化辅助函数。
 */
import type { ViewFileChange } from "@shared/worker-protocol";

/** 把 JSON 字符串美化缩进；解析失败时原样返回 */
export function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** 解析工具入参 JSON；失败或非对象时返回空对象 */
export function parseArgsJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 入参非 JSON 时按无参处理
  }
  return {};
}

/**
 * 在改动列表里倒序找同路径的最近一次改动。
 * 入参路径可能是绝对路径而改动记录是相对路径，故用后缀匹配兜底。
 */
export function matchChangeByPath(
  changes: ViewFileChange[],
  rawPath: unknown,
): ViewFileChange | undefined {
  if (typeof rawPath !== "string") return undefined;
  const normalized = rawPath.replaceAll("\\", "/");
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index]!;
    if (
      change.path === normalized ||
      normalized.endsWith(`/${change.path}`) ||
      normalized.endsWith(change.path)
    ) {
      return change;
    }
  }
  return undefined;
}
