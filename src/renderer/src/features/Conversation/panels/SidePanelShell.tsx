/**
 * 右侧面板的公共外壳：头部标题 + 刷新 + 收起，以及加载/空态的统一呈现。
 * 各具体面板（改动/用量/工具）只需提供内容与状态。
 */
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { ICON } from "@/lib/icon";
import { cn } from "../../../lib/utils";

export function SidePanelShell({
  title,
  icon,
  /** 标题右侧的补充信息，如计数 */
  meta,
  /** 头部与内容之间的可选摘要条 */
  summary,
  width = 360,
  loading,
  error,
  empty,
  isEmpty,
  onRefresh,
  onClose,
  children,
}: {
  title: string;
  icon: ReactNode;
  meta?: ReactNode;
  summary?: ReactNode;
  width?: number;
  loading: boolean;
  error: string | null;
  /** 空态文案 */
  empty: ReactNode;
  isEmpty: boolean;
  onRefresh: () => void;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <aside
      className="flex shrink-0 flex-col border-l border-line bg-surface-raised"
      style={{ width }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          {icon}
          {title}
          {meta}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="text-text-muted transition hover:text-text-primary"
            title="刷新"
          >
            <RefreshCw {...ICON.sm} className={cn(loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-text-muted transition hover:text-text-primary"
          >
            收起
          </button>
        </div>
      </div>

      {error && (
        <div className="m-2 rounded-md border border-danger/50 bg-danger/10 px-2 py-1.5 text-xs text-danger">
          {error}
        </div>
      )}

      {summary}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && isEmpty ? (
          <p className="px-2 py-6 text-center text-xs text-text-muted">加载中…</p>
        ) : isEmpty ? (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-text-muted">
            {empty}
          </p>
        ) : (
          children
        )}
      </div>
    </aside>
  );
}
