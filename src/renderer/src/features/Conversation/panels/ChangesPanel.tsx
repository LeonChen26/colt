/**
 * 右侧文件改动面板：列表选择 + unified patch 预览。
 * 数据来自当前的会话视图（fileChanges 已由主进程以数据库为真源回填）。
 * 作者：陕耀云栈WorkMate
 */
import { useState } from "react";
import type { ViewFileChange } from "@shared/worker-protocol";
import { DiffView } from "../../../components/DiffView";
import { cn } from "../../../lib/utils";

export function ChangesPanel({
  changes,
  onClose,
}: {
  changes: ViewFileChange[];
  onClose: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(changes.at(-1)?.id ?? null);
  const current = changes.find((item) => item.id === selected) ?? changes.at(-1);

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-[--color-border-subtle] bg-[--color-surface-raised]">
      <div className="flex shrink-0 items-center justify-between border-b border-[--color-border-subtle] px-3 py-2">
        <span className="text-xs font-medium text-[--color-text-secondary]">文件改动</span>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-[--color-text-muted] transition hover:text-[--color-text-primary]"
        >
          收起
        </button>
      </div>

      <div className="max-h-44 shrink-0 overflow-y-auto border-b border-[--color-border-subtle] p-2">
        {changes.map((change) => (
          <button
            key={change.id}
            type="button"
            onClick={() => setSelected(change.id)}
            className={cn(
              "mb-1 w-full rounded-md px-2 py-1.5 text-left transition",
              change.id === current?.id
                ? "bg-[--color-surface-overlay]"
                : "hover:bg-[--color-surface-overlay]/60",
            )}
          >
            <div className="truncate font-mono text-xs text-[--color-text-primary]">
              {change.path}
            </div>
            <div className="flex items-center gap-2 text-xs text-[--color-text-muted]">
              <span>{change.kind === "edit" ? "编辑" : "写入"}</span>
              {change.addedLines > 0 && <span className="text-green-400">+{change.addedLines}</span>}
              {change.removedLines > 0 && <span className="text-red-400">-{change.removedLines}</span>}
            </div>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {current?.patch ? (
          <DiffView patch={current.patch} />
        ) : (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-[--color-text-muted]">
            {current ? "该改动由 write 工具整文件写入，内核未提供 diff。" : "暂无改动"}
          </p>
        )}
      </div>
    </aside>
  );
}
