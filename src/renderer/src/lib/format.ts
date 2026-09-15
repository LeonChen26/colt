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
 * 判断某个路径与「hover 中」的路径是不是同一个文件（⑦-A 的现场联动）。
 *
 * 两边的写法可能不一致（改动记录是相对路径、工具入参常是绝对路径），故用后缀兜底；
 * 但裸后缀不算命中——`"src/a.ts".endsWith("rc/a.ts")` 这类「前缀被截断」的巧合
 * 会在不同文件之间乱配（同 basename 不同目录的场景更常见），命中必须落在 `/` 边界上。
 * 空路径一律不算命中，否则「没有 path 参数的工具」会被当成命中万物。
 * ⑦-G 的清单层抽出来后，`FollowPanel` 与 `ChangeDrilldown` 共用这一份；
 * 判据与 `matchChangeByPath` 保持一致，避免同一行 hover 在两处高亮不同的文件。
 */
export function samePath(path: string, highlight: string | null): boolean {
  if (!highlight || path === "") return false;
  const normalized = highlight.replaceAll("\\", "/");
  return normalized === path || normalized.endsWith(`/${path}`);
}

/**
 * 相对时间：刚刚 / Ns 前 / Nm 前 / Nh 前。
 *
 * ⑦-G 的「正在处理」与「改动清单」都要写「N 秒前动过」，故抽到共用的格式化模块里
 * （原先只在 `FollowPanel` 内有一份私有实现）。`now` 可注入，便于单测。
 */
export function formatAgo(ts: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 2) return "刚刚";
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  return `${Math.floor(min / 60)}h 前`;
}

/**
 * 在改动列表里找同路径的最近一次改动。
 * 入参路径可能是绝对路径而改动记录是相对路径，故用后缀匹配兜底。
 *
 * 分两趟，避免「同 basename 不同目录」的记录被后缀误抢：
 * 1. 先整表找**精确相等**（倒序，同路径多条时取最新）——
 *    例如工具卡是 `docs/README.md`、列表里同时有 `README.md` 与 `docs/README.md`，
 *    单趟倒序后缀匹配会先撞上 `README.md`（`"docs/README.md"` 以 `/README.md` 结尾），
 *    把别的文件的增删行数与 diff 配到这张卡上。
 * 2. 全部未命中再走「`/` 边界后缀」兜底（绝对路径 vs 相对记录），并在多个命中里取
 *    **最长路径**（更具体的那条，`docs/README.md` 优先于 `README.md`）；
 *    裸后缀（`rc/a.ts` 配 `src/a.ts`）不算命中——那是配对真数据，不是高亮容差。
 */
export function matchChangeByPath(
  changes: ViewFileChange[],
  rawPath: unknown,
): ViewFileChange | undefined {
  if (typeof rawPath !== "string") return undefined;
  const normalized = rawPath.replaceAll("\\", "/");
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    if (changes[index]!.path === normalized) return changes[index];
  }
  let best: ViewFileChange | undefined;
  for (const change of changes) {
    if (change.path !== "" && normalized.endsWith(`/${change.path}`)) {
      if (best === undefined || change.path.length >= best.path.length) best = change;
    }
  }
  return best;
}
