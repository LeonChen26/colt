/**
 * 项目级改动汇总：跨会话展示所有文件改动
 * 作者：陕耀云栈WorkMate
 */
import { useEffect, useMemo, useState } from "react";
import { FileDiff, RefreshCw } from "lucide-react";
import type { ProjectFileChange } from "@shared/protocol";
import { DiffView } from "../components/DiffView";
import { cn } from "../lib/utils";

export function ProjectChanges({ projectId }: { projectId: string }): React.JSX.Element {
  const [changes, setChanges] = useState<ProjectFileChange[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useMemo(
    () => async () => {
      setLoading(true);
      try {
        const list = await window.banyan.invoke("changes.list", { projectId });
        setChanges(list);
        setSelected((current) => current ?? list[0]?.id ?? null);
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
      <div className="flex shrink-0 items-center justify-between border-b border-[--color-border-subtle] px-4 py-2">
        <div className="flex items-center gap-2 text-sm">
          <FileDiff size={14} />
          项目改动汇总
          <span className="text-xs text-[--color-text-muted]">
            {changes.length} 次改动 · {byFile.length} 个文件
          </span>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1.5 rounded-md border border-[--color-border-subtle] px-2.5 py-1 text-xs text-[--color-text-secondary] transition hover:text-[--color-text-primary]"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} />
          刷新
        </button>
      </div>

      {changes.length === 0 ? (
        <p className="mt-20 text-center text-sm text-[--color-text-muted]">
          {loading ? "加载中…" : "该项目还没有任何文件改动"}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-[380px] shrink-0 overflow-y-auto border-r border-[--color-border-subtle] p-2">
            <div className="mb-2 px-2 py-1 text-xs text-[--color-text-muted]">按文件聚合</div>
            {byFile.map(([path, stat]) => (
              <div
                key={path}
                className="mb-1 rounded-md bg-[--color-surface-raised] px-2 py-1.5"
              >
                <div className="truncate font-mono text-xs">{path}</div>
                <div className="flex items-center gap-2 text-xs text-[--color-text-muted]">
                  <span>{stat.count} 次</span>
                  {stat.added > 0 && <span className="text-green-400">+{stat.added}</span>}
                  {stat.removed > 0 && <span className="text-red-400">-{stat.removed}</span>}
                </div>
              </div>
            ))}

            <div className="mt-3 mb-2 px-2 py-1 text-xs text-[--color-text-muted]">按时间</div>
            {changes.map((change) => (
              <button
                key={change.id}
                type="button"
                onClick={() => setSelected(change.id)}
                className={cn(
                  "mb-1 w-full rounded-md px-2 py-1.5 text-left transition",
                  change.id === selected
                    ? "bg-[--color-surface-overlay]"
                    : "hover:bg-[--color-surface-overlay]/60",
                )}
              >
                <div className="truncate font-mono text-xs">{change.path}</div>
                <div className="flex items-center gap-2 text-xs text-[--color-text-muted]">
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
              <p className="mt-16 text-center text-xs text-[--color-text-muted]">
                {current ? "该改动由 write 工具整文件写入，内核未提供 diff。" : "选择一条改动查看"}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
