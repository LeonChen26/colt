/**
 * 右侧「统计」视图（规则 ⑦-H：附属视图给**结论**，不给流水）。
 *
 * 它由原来的「用量」视图**改名并扩容**而来（2026-09）：改名是因为「用量」在收窄自己
 * ——它只盖得住费用与 tokens，而「工具调用次数」「耗时排行」「失败率」都不是用量；
 * 扩容是因为原「工具」视图**取消独立存在**，它的聚合与明细都并到了这里
 * （工具视图的平铺流水与 ④ 消息流的工具卡重复，且信息更少：只有入参、没有输出）。
 *
 * 版式四段（对齐概念稿 `docs/prototype-follow-merged-hifi.html` 的形态 E）：
 *   ① KPI 卡片  —— 先把结论摆出来（费用 / 轮次 / tokens / 缓存命中）
 *   ② 按模型    —— 谁最贵（费用占比）
 *   ③ 工具次数 + 耗时排行 —— 哪些地方花得多（带分母与占比）
 *   ④ 明细      —— **默认折叠、必须能筛**；点排行行 → 自动筛成该维度
 *
 * 第 ④ 段是「并入」成立的前提：如果并入后仍是平铺，就只是换了地方堆放流水。
 * 「按维度筛全量」正是聚合视图独有的能力——④ 的消息流给不了「只把 bash 挑出来看」。
 *
 * 本视图是**事后回顾**：数据来自 DB（重启后仍可看），不做订阅、不做轮询。
 * 聚合规则在 `lib/session-stats.ts`（纯函数，有单测）；本组件只负责画。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartColumn, ChevronRight } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ToolCallRecord, UsageRecord } from "@shared/protocol";
import { cn } from "../../../lib/utils";
import {
  UNKNOWN_MODEL,
  buildSessionStats,
  formatTokenCount,
  formatToolDuration,
  toolCallSummary,
} from "../../../lib/session-stats";
import { SidePanelShell } from "./SidePanelShell";

/** 排行只给前几名，其余折进「还有 N 种」——排行不是流水，全量在这里没有价值 */
const RANK_LIMIT = 4;
/** 明细一次最多渲染这么多行（再往下就是纯流水，且会拖慢渲染）；超出时明确告知还有多少 */
const DETAIL_LIMIT = 200;

/** 明细的筛选维度：全部 / 只看失败 / 某一个工具 */
type DetailFilter = { kind: "all" } | { kind: "fail" } | { kind: "tool"; toolName: string };

/** 百分比展示：四舍五入到整数即可（占比在这个尺度上不必有位小数） */
function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** 排行行的横条：宽度即占比，让「谁贵 / 谁多」一眼可见 */
function Bar({ share, tone }: { share: number; tone?: "danger" }): React.JSX.Element {
  return (
    <span className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-[3px] bg-line">
      <span
        className={cn("block h-full rounded-[3px]", tone === "danger" ? "bg-danger" : "bg-accent-dim")}
        style={{ width: `${Math.max(2, share * 100)}%` }}
      />
    </span>
  );
}

/** 分段标题：小字大写的分组名 + 右侧的结论数字（「共 128 次 · 3 失败」） */
function SectionHead({ title, note }: { title: string; note?: string }): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-baseline gap-2 px-1.5 text-[10.5px] font-semibold uppercase tracking-[.5px] text-text-muted">
      <span>{title}</span>
      <span className="flex-1" />
      {note !== undefined && <span className="font-medium normal-case tracking-normal">{note}</span>}
    </div>
  );
}

/** KPI 卡片：值用等宽字体，量级才好在几块之间横向比较 */
function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }): React.JSX.Element {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-2.5 py-2">
      <div className="text-[10.5px] text-text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-semibold text-text-primary">{value}</div>
      {sub !== undefined && <div className="mt-0.5 text-[10.5px] text-text-muted">{sub}</div>}
    </div>
  );
}

export function UsagePanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [calls, setCalls] = useState<ToolCallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DetailFilter>({ kind: "all" });
  const [detailOpen, setDetailOpen] = useState(false);
  const [allToolsShown, setAllToolsShown] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 两个既有 IPC 并发取；任一失败都进同一个错误分支（缺一个都画不出完整结论）
      const [usage, toolCalls] = await Promise.all([
        window.banyan.invoke("usage.list", { sessionId }),
        window.banyan.invoke("toolCalls.list", { sessionId }),
      ]);
      setRecords(usage.records);
      setCalls(toolCalls);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 换会话时把上一会话留下的筛选条件清掉：否则新会话里会看到一个筛出 0 条的明细，
  // 而用户并没有做过这个筛选（这是「状态跟着数据走」的一处必要重置）。
  useEffect(() => {
    setFilter({ kind: "all" });
    setDetailOpen(false);
    setAllToolsShown(false);
  }, [sessionId]);

  const stats = useMemo(() => buildSessionStats(records, calls), [records, calls]);
  const { totals, models, toolCounts, toolDurations, cacheHitRatio } = stats;

  const visibleCounts = allToolsShown ? toolCounts : toolCounts.slice(0, RANK_LIMIT);
  const hidden = toolCounts.slice(RANK_LIMIT);
  const hiddenCalls = hidden.reduce((sum, item) => sum + item.calls, 0);

  const filtered = calls.filter((call) =>
    filter.kind === "all"
      ? true
      : filter.kind === "fail"
        ? call.isError
        : call.toolName === filter.toolName,
  );
  const shown = filtered.slice(0, DETAIL_LIMIT);

  /** 点排行行 = 把明细筛成该维度并展开它（⑦-H：点进去就要能落到明细） */
  const drillInto = (toolName: string): void => {
    setFilter({ kind: "tool", toolName });
    setDetailOpen(true);
  };

  const chip = (active: boolean, danger = false): string =>
    cn(
      "rounded-full border px-1.5 py-[2px] text-[10px] transition",
      active
        ? danger
          ? "border-danger bg-danger-soft font-semibold text-danger-fg"
          : "border-line-strong bg-accent-soft font-semibold text-text-primary"
        : "border-line text-text-muted hover:border-line-strong hover:text-text-primary",
    );

  return (
    <SidePanelShell
      title="会话统计"
      icon={<ChartColumn {...ICON.sm} />}
      loading={loading}
      error={error}
      isEmpty={records.length === 0 && calls.length === 0}
      empty="还没有统计数据。发起对话后，模型调用与工具调用都会记录在此（重启后仍可回看）。"
      onRefresh={() => void load()}
    >
      {/* ① KPI：结论先行 */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Kpi label="总费用" value={`$${totals.costUsd.toFixed(4)}`} sub="本次会话" />
        <Kpi label="模型调用" value={String(totals.calls)} sub="次" />
        <Kpi
          label="输入 / 输出"
          value={`${formatTokenCount(totals.inputTokens)} / ${formatTokenCount(totals.outputTokens)}`}
          sub="tokens"
        />
        <Kpi
          label="缓存"
          value={formatTokenCount(totals.cacheTokens)}
          sub={`占输入 ${percent(cacheHitRatio)}`}
        />
      </div>

      {/* ② 按模型：谁最贵 */}
      <div className="mb-3.5">
        <SectionHead title="按模型" note={`${totals.calls} 次调用`} />
        {models.map((stat) => (
          <div key={stat.model} className="flex items-center gap-2 px-1.5 py-1">
            <span
              className="w-[82px] shrink-0 truncate font-mono text-[11px] text-text-primary"
              title={stat.model === UNKNOWN_MODEL ? "记录里没有模型名" : stat.model}
            >
              {stat.model}
            </span>
            <Bar share={stat.costShare} />
            <span className="w-[74px] shrink-0 text-right font-mono text-[10.5px] text-text-secondary">
              ${stat.costUsd.toFixed(4)}
            </span>
            <span className="w-[34px] shrink-0 text-right text-[10px] text-text-muted">
              {percent(stat.costShare)}
            </span>
          </div>
        ))}
      </div>

      {/* ③ 工具调用次数排行（原「工具」视图的核心需求）；点行 → 明细筛成该工具 */}
      <div className="mb-3.5">
        <SectionHead
          title="工具调用"
          note={`共 ${stats.toolCalls} 次${stats.toolFailures > 0 ? ` · ${stats.toolFailures} 失败` : ""}`}
        />
        {visibleCounts.map((stat) => (
          <button
            key={stat.toolName}
            type="button"
            data-stats-rank={stat.toolName}
            onClick={() => drillInto(stat.toolName)}
            title={`只看 ${stat.toolName} 的调用明细`}
            className={cn(
              "group flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left transition hover:bg-surface-overlay",
              filter.kind === "tool" && filter.toolName === stat.toolName && "bg-accent-soft",
            )}
          >
            <span className="shrink-0 text-text-muted opacity-0 transition group-hover:opacity-100">
              <ChevronRight {...ICON.xs} />
            </span>
            <span className="w-[82px] shrink-0 truncate font-mono text-[11px] text-text-primary">
              {stat.toolName}
            </span>
            <Bar share={stat.share} tone={stat.failed > 0 ? "danger" : undefined} />
            <span className="w-[74px] shrink-0 text-right font-mono text-[10.5px] text-text-secondary">
              {stat.calls} 次
            </span>
            <span className="w-[34px] shrink-0 text-right text-[10px] text-text-muted">
              {percent(stat.share)}
            </span>
          </button>
        ))}
        {hidden.length > 0 && (
          <button
            type="button"
            onClick={() => setAllToolsShown((value) => !value)}
            className="block w-full px-1.5 py-1 text-left text-[10.5px] text-text-muted transition hover:text-text-primary"
          >
            {allToolsShown
              ? "收起"
              : `还有 ${hidden.length} 种工具（${hiddenCalls} 次）▾`}
          </button>
        )}
      </div>

      {/* ③' 耗时排行：最慢的先看（`durationMs` 为空的调用不参与，见 session-stats 的说明） */}
      <div className="mb-3.5">
        <SectionHead title="工具耗时" note={`累计 ${formatToolDuration(stats.toolTotalMs)}`} />
        {toolDurations.slice(0, RANK_LIMIT).map((stat) => (
          <button
            key={stat.toolName}
            type="button"
            data-stats-rank={stat.toolName}
            onClick={() => drillInto(stat.toolName)}
            title={`只看 ${stat.toolName} 的调用明细`}
            className={cn(
              "group flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left transition hover:bg-surface-overlay",
              filter.kind === "tool" && filter.toolName === stat.toolName && "bg-accent-soft",
            )}
          >
            <span className="shrink-0 text-text-muted opacity-0 transition group-hover:opacity-100">
              <ChevronRight {...ICON.xs} />
            </span>
            <span className="w-[82px] shrink-0 truncate font-mono text-[11px] text-text-primary">
              {stat.toolName}
            </span>
            <Bar share={stat.share} />
            <span className="w-[74px] shrink-0 text-right font-mono text-[10.5px] text-text-secondary">
              {formatToolDuration(stat.totalMs)}
            </span>
            <span className="w-[34px] shrink-0 text-right text-[10px] text-text-muted">
              {percent(stat.share)}
            </span>
          </button>
        ))}
      </div>

      {/* ④ 明细：默认折叠（聚合是主、流水是次），且**必须能筛** */}
      <button
        type="button"
        data-stats-detail-toggle=""
        onClick={() => setDetailOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-1.5 py-1.5 text-left text-[11px] text-text-muted transition hover:text-text-primary"
      >
        <ChevronRight
          {...ICON.xs}
          className={cn("shrink-0 transition-transform", detailOpen && "rotate-90")}
        />
        按轮次明细
        <span className="text-text-muted">（{filtered.length} 条）</span>
      </button>

      {detailOpen && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-1.5">
            <button
              type="button"
              onClick={() => setFilter({ kind: "all" })}
              className={chip(filter.kind === "all")}
            >
              全部 {stats.toolCalls}
            </button>
            {stats.toolFailures > 0 && (
              <button
                type="button"
                onClick={() => setFilter({ kind: "fail" })}
                className={chip(filter.kind === "fail", true)}
              >
                只看失败 {stats.toolFailures}
              </button>
            )}
            {toolCounts.map((stat) => (
              <button
                key={stat.toolName}
                type="button"
                onClick={() => setFilter({ kind: "tool", toolName: stat.toolName })}
                className={cn(
                  chip(filter.kind === "tool" && filter.toolName === stat.toolName),
                  "font-mono",
                )}
              >
                {stat.toolName} {stat.calls}
              </button>
            ))}
          </div>

          {shown.map((call) => {
            const summary = toolCallSummary(call.inputJson);
            return (
              <div
                key={call.id}
                className="flex items-center gap-2 rounded-[4px] px-1.5 py-1 font-mono text-[10.5px] text-text-muted"
              >
                <span
                  className={cn("shrink-0", call.isError ? "text-danger-fg" : "text-text-secondary")}
                >
                  {call.toolName}
                </span>
                <span className="min-w-0 flex-1 truncate" title={summary}>
                  {summary}
                </span>
                {call.isError && <span className="shrink-0 text-danger-fg">失败</span>}
                <span className="shrink-0">
                  {call.durationMs !== null && formatToolDuration(call.durationMs)}
                </span>
                <span className="shrink-0">
                  {new Date(call.createdAt).toLocaleTimeString("zh-CN")}
                </span>
              </div>
            );
          })}
          {filtered.length > shown.length && (
            <div className="px-1.5 py-1 text-[10.5px] text-text-muted">
              只显示前 {DETAIL_LIMIT} 条（共 {filtered.length} 条），可用上面的筛选收窄
            </div>
          )}
        </>
      )}
    </SidePanelShell>
  );
}
