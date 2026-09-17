/**
 * 「统计」视图的聚合（规则 ⑦-H：附属视图给**结论**，不给流水）。
 *
 * 抽成纯函数是为了能单测（沿用 `runStateOf` / `change-list` 的聚合先例）：
 * 组件只负责画，聚合规则（占比的分母是谁、排序、缺失值口径）全在这里，
 * 而这些恰好是用户会拿去核对的部分。
 *
 * 数据全部来自**既有字段**，不需要改协议：
 *   `UsageRecord`（model / tokens / cost）→ 总额 + 按模型分组
 *   `ToolCallRecord`（toolName / durationMs / isError）→ 次数排行 + 耗时排行 + 失败统计
 *
 * 也不读 `usage.totals`：主进程那份 totals 本来就是用同一份 records 累加出来的
 * （见 `repo.ts#listSessionUsage`），自己算一遍才能保证「KPI 总额 == 各模型行之和」——
 * 用户在同一屏里看到两处对不上的数字，是最伤信任的一种呈现。
 */
import type { ToolCallRecord, UsageRecord } from "@shared/protocol";
import { parseArgsJson } from "./format";

/** 模型缺失时的占位（DB 里 `model` 可为 null：早期记录、或供应商没回传） */
export const UNKNOWN_MODEL = "未知模型";

export interface UsageTotals {
  /** 记录条数，即模型调用的轮次 */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 读写合计：KPI 卡片上只显示这一个数 */
  cacheTokens: number;
  costUsd: number;
}

export interface ModelStat {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** 费用占比 0..1；总费用为 0 时是 0 而不是 NaN */
  costShare: number;
}

export interface ToolCountStat {
  toolName: string;
  calls: number;
  failed: number;
  /** 次数占比 0..1 */
  share: number;
}

export interface ToolDurationStat {
  toolName: string;
  /** 只累加**有耗时**的调用（`durationMs === null` 的那些不参与，否则均值会假性变小） */
  totalMs: number;
  /** 参与了累加的调用数（即「平均」的分母） */
  calls: number;
  /** 耗时占比 0..1 */
  share: number;
}

export interface SessionStats {
  totals: UsageTotals;
  /** 缓存读取 / 输入 tokens，0..1（原型「缓存命中 … 占输入 49%」的口径） */
  cacheHitRatio: number;
  models: ModelStat[];
  /** 工具调用总次数（含失败） */
  toolCalls: number;
  toolFailures: number;
  /** 所有工具有耗时调用的耗时之和 */
  toolTotalMs: number;
  toolCounts: ToolCountStat[];
  toolDurations: ToolDurationStat[];
}

/** 占比：分母为 0 时返回 0（统计里出现 NaN 比出现 0 更糟——它会渲染成「NaN%」） */
function shareOf(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/** 主指标降序；同分时按名字升序，保证每次渲染顺序稳定（否则列表会跳） */
function byMetricDesc<T>(
  metric: (item: T) => number,
  name: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) => metric(b) - metric(a) || name(a).localeCompare(name(b));
}

const EMPTY_TOTALS: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheTokens: 0,
  costUsd: 0,
};

export function buildSessionStats(
  records: UsageRecord[],
  toolCalls: ToolCallRecord[],
): SessionStats {
  const totals = records.reduce<UsageTotals>(
    (acc, item) => ({
      calls: acc.calls + 1,
      inputTokens: acc.inputTokens + item.inputTokens,
      outputTokens: acc.outputTokens + item.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + item.cacheWriteTokens,
      cacheTokens: acc.cacheTokens + item.cacheReadTokens + item.cacheWriteTokens,
      costUsd: acc.costUsd + item.costUsd,
    }),
    EMPTY_TOTALS,
  );

  // 分组键只取 model，不含 provider：同一个模型换供应商在用户眼里仍是同一个模型，
  // 而按 provider 再分一层会把「谁最贵」这个结论拆散。
  const byModel = new Map<string, ModelStat>();
  for (const record of records) {
    const key = record.model ?? UNKNOWN_MODEL;
    const stat = byModel.get(key) ?? {
      model: key,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costShare: 0,
    };
    stat.calls += 1;
    stat.inputTokens += record.inputTokens;
    stat.outputTokens += record.outputTokens;
    stat.costUsd += record.costUsd;
    byModel.set(key, stat);
  }
  const models = [...byModel.values()]
    .map((stat) => ({ ...stat, costShare: shareOf(stat.costUsd, totals.costUsd) }))
    .sort(byMetricDesc<ModelStat>((stat) => stat.costUsd, (stat) => stat.model));

  const byTool = new Map<string, { calls: number; failed: number; totalMs: number; timed: number }>();
  let toolFailures = 0;
  let toolTotalMs = 0;
  for (const call of toolCalls) {
    const stat = byTool.get(call.toolName) ?? { calls: 0, failed: 0, totalMs: 0, timed: 0 };
    stat.calls += 1;
    if (call.isError) {
      stat.failed += 1;
      toolFailures += 1;
    }
    if (call.durationMs !== null) {
      stat.totalMs += call.durationMs;
      stat.timed += 1;
      toolTotalMs += call.durationMs;
    }
    byTool.set(call.toolName, stat);
  }

  const toolCounts = [...byTool.entries()]
    .map(([toolName, stat]) => ({
      toolName,
      calls: stat.calls,
      failed: stat.failed,
      share: shareOf(stat.calls, toolCalls.length),
    }))
    .sort(byMetricDesc<ToolCountStat>((stat) => stat.calls, (stat) => stat.toolName));

  const toolDurations = [...byTool.entries()]
    .filter(([, stat]) => stat.totalMs > 0)
    .map(([toolName, stat]) => ({
      toolName,
      totalMs: stat.totalMs,
      calls: stat.timed,
      share: shareOf(stat.totalMs, toolTotalMs),
    }))
    .sort(byMetricDesc<ToolDurationStat>((stat) => stat.totalMs, (stat) => stat.toolName));

  return {
    totals,
    cacheHitRatio: shareOf(totals.cacheReadTokens, totals.inputTokens),
    models,
    toolCalls: toolCalls.length,
    toolFailures,
    toolTotalMs,
    toolCounts,
    toolDurations,
  };
}

/** 去掉 `toFixed` 留下的尾零：1.20M → 1.2M、612.0K → 612K */
function trimZeros(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

/**
 * 大数的紧凑写法（对齐原型 KPI：`1.24M` / `86.4K` / `612`）。
 * 统计面板求的是「一眼看出量级」，精确值仍可在明细里看到。
 */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimZeros(value / 1_000_000, 2)}M`;
  if (value >= 1_000) {
    // 999.95K 起 toFixed(1) 会四舍五入进位成「1000K」：直接升到 M 档
    const k = value / 1_000;
    if (k >= 999.95) return `${trimZeros(value / 1_000_000, 2)}M`;
    return `${trimZeros(k, 1)}K`;
  }
  return String(value);
}

/**
 * 工具耗时：`ms` / `18.4s` / `2m38s`。
 * 分钟档要进位到整数秒再拆（原型「2m38s」），否则 `% 60000` 会算出 `2m59.999s → 2m60s`。
 */
export function formatToolDuration(ms: number): string {
  if (ms >= 60_000) {
    const totalSeconds = Math.round(ms / 1000);
    return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/**
 * 一次工具调用「在干什么」的一行摘要（明细行用）。
 *
 * 按优先级取第一个拿得出手的字符串参数：命令 → 路径 → 地址 → 匹配式。
 * 不特判某个工具——入参格式随工具变，而这里是**兜底展示**，取错了也只是不够精确，
 * 不会像「按字段名猜语义」那样做出一个撒谎的控件（AGENTS.md 的教训）。
 */
const SUMMARY_KEYS = ["command", "path", "file_path", "url", "query", "pattern", "selector"];

export function toolCallSummary(inputJson: string | null): string {
  const args = parseArgsJson(inputJson ?? "");
  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const fallback = Object.values(args).find(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  return typeof fallback === "string" ? fallback : "";
}
