// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 项目级改动汇总：跨会话展示所有文件改动
 */
import { useEffect, useMemo, useState } from "react";
import { FileDiff, RefreshCw } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ProjectFileChange } from "@shared/protocol";
import { DiffView } from "../components/DiffView";
import { cn } from "../lib/utils";

export function ProjectChanges({ projectId }: { projectId: string }): React.JSX.Element {
  const [changes, setChanges] = useState<ProjectFileChange[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useMemo(
    () => async () => {
      setLoading(true);
      try {
        const list = await window.colt.invoke("changes.list", { projectId });
        setChanges(list);
        setSelected((current) => current ?? list[0]?.id ?? null);
        setError(null);
      } catch (e) {
        // 查询失败不能静默变成「该项目还没有任何文件改动」假空态——那是在撒谎
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // 按文件聚合，便于看出哪些文件被反复改动
  const byFile = useMemo(() => {
    const map = new Map<string, { added: number; removed: number; count: number }>();
    for (const change of changes) {
      const current = map.get(change.path) ?? { added: 0, removed: 0, count: 0 };
      map.set(change.path, {
        added: current.added + change.addedLines,
        removed: current.removed + change.removedLines,
        count: current.count + 1,
      });
    }
    return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [changes]);

  const current = changes.find((item) => item.id === selected);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
        <div className="flex items-center gap-2 text-[13px]">
          <FileDiff {...ICON.md} />
          项目改动汇总
          <span className="text-[11.5px] text-text-muted">
            {changes.length} 次改动 · {byFile.length} 个文件
          </span>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:text-text-primary"
        >
          <RefreshCw {...ICON.sm} className={cn(loading && "animate-spin")} />
          刷新
        </button>
      </div>

      {error && (
        <div className="m-3 rounded-md border border-line bg-danger-soft px-3 py-2 text-[13px] text-danger-fg">
          {error}
        </div>
      )}

      {changes.length === 0 ? (
        <p className="mt-20 text-center text-[13px] text-text-muted">
          {loading ? "加载中…" : error !== null ? "加载失败，请重试" : "该项目还没有任何文件改动"}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-[380px] shrink-0 overflow-y-auto border-r border-line p-2">
            <div className="mb-2 px-2 py-1 text-[11.5px] text-text-muted">按文件聚合</div>
            {byFile.map(([path, stat]) => (
              <div
                key={path}
                className="mb-1 rounded-md bg-surface-raised px-2 py-1.5"
              >
                <div className="truncate font-mono text-[11.5px]">{path}</div>
                <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
                  <span>{stat.count} 次</span>
                  {stat.added > 0 && <span className="text-success-fg">+{stat.added}</span>}
                  {stat.removed > 0 && <span className="text-danger-fg">-{stat.removed}</span>}
                </div>
              </div>
            ))}

            <div className="mt-3 mb-2 px-2 py-1 text-[11.5px] text-text-muted">按时间</div>
            {changes.map((change) => (
              <button
                key={change.id}
                type="button"
                onClick={() => setSelected(change.id)}
                className={cn(
                  "mb-1 w-full rounded-md px-2 py-1.5 text-left transition",
                  change.id === selected
                    ? "bg-surface-overlay"
                    : "hover:bg-surface-overlay/60",
                )}
              >
                <div className="truncate font-mono text-[11.5px]">{change.path}</div>
                <div className="flex items-center gap-2 text-[11.5px] text-text-muted">
                  <span className="truncate">{change.sessionTitle}</span>
                  <span className="shrink-0">
                    {new Date(change.createdAt).toLocaleTimeString("zh-CN")}
                  </span>
                </div>
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {current?.patch ? (
              <DiffView patch={current.patch} />
            ) : (
              <p className="mt-16 text-center text-[11.5px] text-text-muted">
                {current ? "该改动由 write 工具整文件写入，内核未提供 diff。" : "选择一条改动查看"}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
