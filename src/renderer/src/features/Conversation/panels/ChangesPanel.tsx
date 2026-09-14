/**
 * 「改动」视图：列表选择 + unified patch 预览。
 * 数据来自当前的会话视图（fileChanges 已由主进程以数据库为真源回填）。
 *
 * A3-5：由中栏浮层面板迁入 ⑦ 工作区容器——不再是自带边框/固定宽度的 `aside`，
 * 关闭交给页签上的 ×（同一件事只留一个出口）。
 */
import { useState } from "react";
import type { ViewFileChange } from "@shared/worker-protocol";
import { DiffView } from "../../../components/DiffView";
import { cn } from "../../../lib/utils";

export function ChangesPanel({ changes }: { changes: ViewFileChange[] }): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(changes.at(-1)?.id ?? null);
  const current = changes.find((item) => item.id === selected) ?? changes.at(-1);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
        <span className="text-xs font-medium text-text-secondary">文件改动</span>
        {changes.length > 0 && (
          <span className="text-[10.5px] text-text-muted">{changes.length} 处</span>
        )}
      </div>

      <div className="max-h-44 shrink-0 overflow-y-auto border-b border-line p-2">
        {changes.map((change) => (
          <button
            key={change.id}
            type="button"
            onClick={() => setSelected(change.id)}
            className={cn(
              "mb-1 w-full rounded-md px-2 py-1.5 text-left transition",
              change.id === current?.id
                ? "bg-surface-overlay"
                : "hover:bg-surface-overlay/60",
            )}
          >
            <div className="truncate font-mono text-xs text-text-primary">
              {change.path}
            </div>
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <span>{change.kind === "edit" ? "编辑" : "写入"}</span>
              {change.addedLines > 0 && <span className="text-success-fg">+{change.addedLines}</span>}
              {change.removedLines > 0 && <span className="text-danger-fg">-{change.removedLines}</span>}
            </div>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {current?.patch ? (
          <DiffView patch={current.patch} />
        ) : (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-text-muted">
            {current ? "该改动由 write 工具整文件写入，内核未提供 diff。" : "暂无改动"}
          </p>
        )}
      </div>
    </div>
  );
}
