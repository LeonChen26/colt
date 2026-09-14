/**
 * 展示层的格式化辅助函数。
 */
import type { ViewFileChange, ViewRunOutcome } from "@shared/worker-protocol";

/** 把 JSON 字符串美化缩进；解析失败时原样返回 */
export function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** 体积：B / KB / MB 三档即可，展示场景不需要更细 */
export function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
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

/** ⑥ 状态段的取值；除 `running` 外都是「静止态」，区别只在文案与点的颜色 */
export type RunState = "running" | "aborted" | "failed" | "idle";

/**
 * 由 `running` 与最近一轮终态推出 ⑥ 状态段的取值（C1 / C2）。
 *
 * 只有**中断**与**失败**值得单独留一行：正常跑完（`completed`）与「还没跑过」（`lastRun === null`）
 * 都是「空闲」——状态条不该为一次正常的结束留痕。
 *
 * 抽成纯函数是为了能单测：这段判定是 C1 的全部行为，而 ⑥ 目前没有任何冒烟覆盖
 * （`fixture` 只跑浏览器能力、`dock` 只跑右栏）。
 */
export function runStateOf(running: boolean, lastRun: ViewRunOutcome | null): RunState {
  if (running) return "running";
  if (lastRun?.status === "aborted") return "aborted";
  if (lastRun?.status === "failed") return "failed";
  return "idle";
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
