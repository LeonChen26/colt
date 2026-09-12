/**
 * 右侧用量历史面板：每次模型调用的 token 与费用，及累计汇总。
 * 数据来自数据库，与内核内存快照解耦，重启后仍可回看。
 */
import { useCallback, useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { SessionUsage } from "@shared/protocol";
import { SidePanelShell } from "./SidePanelShell";

export function UsagePanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}): React.JSX.Element {
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsage(await window.banyan.invoke("usage.list", { sessionId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const records = usage?.records ?? [];
  const totals = usage?.totals;
  const cacheTokens = (totals?.cacheReadTokens ?? 0) + (totals?.cacheWriteTokens ?? 0);

  return (
    <SidePanelShell
      title="用量历史"
      icon={<Coins {...ICON.sm} />}
      loading={loading}
      error={error}
      isEmpty={records.length === 0}
      empty="还没有用量记录。发起对话后，每次模型调用都会记录在此。"
      onRefresh={() => void load()}
      onClose={onClose}
      summary={
        totals && totals.calls > 0 ? (
          <div className="shrink-0 border-b border-line px-3 py-2 text-xs text-text-secondary">
            <div>
              {totals.calls} 次调用 ·{" "}
              {(totals.inputTokens + totals.outputTokens).toLocaleString("zh-CN")} tokens
            </div>
            <div className="text-text-muted">
              输入 {totals.inputTokens.toLocaleString("zh-CN")} · 输出{" "}
              {totals.outputTokens.toLocaleString("zh-CN")}
              {cacheTokens > 0 && ` · 缓存 ${cacheTokens.toLocaleString("zh-CN")}`}
            </div>
            <div className="mt-0.5 font-mono">${totals.costUsd.toFixed(6)}</div>
          </div>
        ) : null
      }
    >
      {records.map((record) => (
        <div key={record.id} className="mb-1 rounded-md bg-surface-overlay px-2 py-1.5">
          <div className="flex items-center justify-between">
            <span className="truncate font-mono text-xs text-text-primary">
              {record.model ?? "—"}
            </span>
            <span className="shrink-0 text-[10px] text-text-muted">
              {new Date(record.createdAt).toLocaleTimeString("zh-CN")}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-text-muted">
            <span>入 {record.inputTokens.toLocaleString("zh-CN")}</span>
            <span>出 {record.outputTokens.toLocaleString("zh-CN")}</span>
            <span className="ml-auto font-mono">${record.costUsd.toFixed(6)}</span>
          </div>
        </div>
      ))}
    </SidePanelShell>
  );
}
