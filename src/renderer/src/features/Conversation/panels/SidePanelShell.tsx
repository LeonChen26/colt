// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 面板的公共外壳：头部标题 + 刷新，以及加载/空态的统一呈现。
 * 各具体面板（改动 / 统计 / 规则）只需提供内容与状态。
 *
 * A3-5：外壳不再自带 `aside` / 边框 / 固定宽度，也不再提供「收起」——
 * 这些面板已迁入 ⑦ 工作区容器，**关闭由页签上的 × 负责**（同一件事只留一个出口）。
 * 头部保留（对齐高保真 `.dock-head`）：标题与刷新是面板自己的工具行。
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
  loading,
  error,
  empty,
  isEmpty,
  onRefresh,
  children,
}: {
  title: string;
  icon: ReactNode;
  meta?: ReactNode;
  summary?: ReactNode;
  loading: boolean;
  error: string | null;
  /** 空态文案 */
  empty: ReactNode;
  isEmpty: boolean;
  onRefresh: () => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex h-[var(--h-panel-head)] shrink-0 items-center justify-between border-b border-line px-3">
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-text-secondary">
          {icon}
          {title}
          {meta}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted transition hover:bg-line-soft hover:text-text-primary"
          title="刷新"
        >
          <RefreshCw {...ICON.sm} className={cn(loading && "animate-spin")} />
        </button>
      </div>

      {error && (
        <div className="m-2 rounded-md border border-line border-l-2 border-l-danger bg-danger-soft px-2 py-1.5 text-[11.5px] text-danger-fg">
          {error}
        </div>
      )}

      {summary}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && isEmpty ? (
          <p className="px-3 py-10 text-center text-[11.5px] text-text-muted">加载中…</p>
        ) : isEmpty ? (
          <p className="px-3 py-10 text-center text-[11.5px] leading-relaxed text-text-muted">
            {empty}
          </p>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
