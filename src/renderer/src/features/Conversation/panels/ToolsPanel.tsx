/**
 * 右侧工具调用历史面板：每次工具调用的入参、耗时与成败。
 * 数据来自数据库，可展开查看入参。
 * 作者：陕耀云栈WorkMate
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import type { ToolCallRecord } from "@shared/protocol";
import { formatArgs } from "../../../lib/format";
import { cn } from "../../../lib/utils";
import { SidePanelShell } from "./SidePanelShell";

export function ToolsPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}): React.JSX.Element {
  const [calls, setCalls] = useState<ToolCallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCalls(await window.banyan.invoke("toolCalls.list", { sessionId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const failed = calls.filter((item) => item.isError).length;

  return (
    <SidePanelShell
      title="工具调用"
      icon={<Wrench size={12} />}
      meta={
        calls.length > 0 ? (
          <span className="text-[--color-text-muted]">
            {calls.length} 次{failed > 0 && ` · ${failed} 失败`}
          </span>
        ) : null
      }
      loading={loading}
      error={error}
      isEmpty={calls.length === 0}
      empty="还没有工具调用。Agent 使用 read/write/edit/bash 时会记录在此。"
      onRefresh={() => void load()}
      onClose={onClose}
    >
      {calls.map((call) => (
        <div
          key={call.id}
          className={cn(
            "mb-1 overflow-hidden rounded-md border bg-[--color-surface-overlay]",
            call.isError ? "border-[--color-danger]/40" : "border-transparent",
          )}
        >
          <button
            type="button"
            onClick={() => setExpanded((v) => (v === call.id ? null : call.id))}
            className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
          >
            <ChevronRight
              size={12}
              className={cn(
                "shrink-0 text-[--color-text-muted] transition-transform",
                expanded === call.id && "rotate-90",
              )}
            />
            <span className="font-mono text-xs text-[--color-text-primary]">{call.toolName}</span>
            {call.isError && <span className="text-xs text-[--color-danger]">失败</span>}
            <span className="ml-auto shrink-0 text-[10px] text-[--color-text-muted]">
              {call.durationMs !== null && `${call.durationMs}ms`}
              {" · "}
              {new Date(call.createdAt).toLocaleTimeString("zh-CN")}
            </span>
          </button>
          {expanded === call.id && (
            <div className="border-t border-[--color-border-subtle] p-2">
              <div className="mb-1 text-xs text-[--color-text-muted]">入参</div>
              <pre className="max-h-60 overflow-auto rounded-md bg-black/40 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
                {formatArgs(call.inputJson ?? "")}
              </pre>
            </div>
          )}
        </div>
      ))}
    </SidePanelShell>
  );
}
