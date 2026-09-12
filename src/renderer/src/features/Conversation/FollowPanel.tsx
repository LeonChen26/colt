/**
 * 右栏「跟随线」：让用户随时看到 Agent 正在碰哪些文件、本次改了多少。
 *
 * 两段（均可折叠，对齐高保真 .fsec）：
 *   1. Agent 正在处理 —— 运行中的工具 + 最近改动的文件（含增删行数与相对时间）
 *   2. 本次改动 —— 文件数 + 增删行数汇总（点「查看全部改动」打开改动面板）
 *
 * 数据全部来自 ConversationView，无需额外 IPC。
 * hover 工具卡片时通过 highlightPath 高亮它碰的文件（对齐设计的跟随联动）。
 */
import { useState, type ReactNode } from "react";
import { ChevronDown, Eye, FileEdit, FileDiff } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ConversationView } from "@shared/worker-protocol";
import { cn } from "../../lib/utils";

/** 相对时间：刚刚 / Ns 前 / Nm 前 */
function ago(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 2) return "刚刚";
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  return `${Math.floor(min / 60)}h 前`;
}

/** 判断跟随线里的相对路径是否与 hover 的路径指向同一文件 */
function samePath(path: string, highlight: string | null): boolean {
  if (!highlight) return false;
  const normalized = highlight.replaceAll("\\", "/");
  return (
    normalized === path ||
    normalized.endsWith(`/${path}`) ||
    normalized.endsWith(path)
  );
}

/** 从工具入参里取一句最能说明「它在干什么」的摘要：命令 / 路径 */
function runningToolSummary(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    const command = typeof parsed.command === "string" ? parsed.command : undefined;
    const path = typeof parsed.path === "string" ? parsed.path : undefined;
    return command ?? path ?? "";
  } catch {
    return "";
  }
}

/** 可折叠分段头：caret + 标题 + 右侧元信息（对齐 .fsec-head） */
function SectionHead({
  title,
  meta,
  collapsed,
  onToggle,
}: {
  title: string;
  meta?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full shrink-0 items-center gap-1.5 px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[.6px] text-text-muted transition hover:text-text-secondary"
    >
      <ChevronDown
        {...ICON.xs}
        className={cn("shrink-0 transition-transform", collapsed && "-rotate-90")}
      />
      <span className="truncate">{title}</span>
      {meta !== undefined && (
        <span className="ml-auto shrink-0 text-[10.5px] font-medium normal-case tracking-normal text-text-muted">
          {meta}
        </span>
      )}
    </button>
  );
}

export function FollowPanel({
  view,
  highlightPath,
  onOpenChanges,
}: {
  view: ConversationView | null;
  highlightPath?: string | null;
  onOpenChanges: () => void;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState({ agent: false, changes: false });
  const changes = view?.fileChanges ?? [];
  const runningTools = view?.runningTools ?? [];

  // 文件 → 最近一次改动（按路径去重，保留最新）
  const byPath = new Map<
    string,
    { path: string; kind: "write" | "edit"; timestamp: number; added: number; removed: number }
  >();
  for (const change of changes) {
    const prev = byPath.get(change.path);
    if (!prev || change.timestamp > prev.timestamp) {
      byPath.set(change.path, {
        path: change.path,
        kind: change.kind,
        timestamp: change.timestamp,
        added: change.addedLines,
        removed: change.removedLines,
      });
    }
  }
  const files = [...byPath.values()].sort((a, b) => b.timestamp - a.timestamp);

  const added = changes.reduce((sum, change) => sum + change.addedLines, 0);
  const removed = changes.reduce((sum, change) => sum + change.removedLines, 0);

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-l border-line bg-surface-raised">
      {/* 段一：Agent 正在处理 */}
      <section className="flex min-h-0 flex-col border-b border-line">
        <SectionHead
          title="Agent 正在处理"
          meta={files.length > 0 ? `${files.length} 个文件` : undefined}
          collapsed={collapsed.agent}
          onToggle={() => setCollapsed((value) => ({ ...value, agent: !value.agent }))}
        />
        {!collapsed.agent && (
          <div className="max-h-[260px] overflow-y-auto px-2 pb-1.5">
            {/* 运行中的工具 */}
            {runningTools.map((tool) => {
              const summary = runningToolSummary(tool.args);
              return (
                <div key={tool.id} className="rounded-[6px] px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="live-dot shrink-0" />
                    <span className="truncate font-mono text-[11px] text-text-secondary">
                      {tool.name}
                    </span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-text-muted">
                      {ago(tool.startedAt)}
                    </span>
                  </div>
                  {summary.length > 0 && (
                    <div
                      title={summary}
                      className="truncate pl-3.5 font-mono text-[10.5px] text-text-muted"
                    >
                      {summary}
                    </div>
                  )}
                </div>
              );
            })}

            {/* 最近改动的文件 */}
            {files.length === 0 && runningTools.length === 0 ? (
              <p className="px-2 py-6 text-center text-[11.5px] text-text-muted">
                会话空闲，暂无进行中的操作
              </p>
            ) : (
              files.map((file) => (
                <div
                  key={file.path}
                  className={cn(
                    "flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 transition",
                    samePath(file.path, highlightPath ?? null) && "bg-surface-overlay",
                  )}
                  title={file.path}
                >
                  {file.kind === "edit" ? (
                    <FileEdit {...ICON.xs} className="shrink-0 text-text-muted" />
                  ) : (
                    <Eye {...ICON.xs} className="shrink-0 text-text-muted" />
                  )}
                  <span className="truncate font-mono text-[11px] text-text-secondary">
                    {file.path}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[10.5px]">
                    {(file.added > 0 || file.removed > 0) && (
                      <span>
                        <span className="text-success-fg">+{file.added}</span>{" "}
                        <span className="text-danger-fg">−{file.removed}</span>
                      </span>
                    )}
                    <span className="text-text-muted">{ago(file.timestamp)}</span>
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {/* 段二：本次改动 */}
      <section className="flex min-h-0 flex-col border-b border-line">
        <SectionHead
          title="本次改动"
          meta={
            changes.length > 0 ? (
              <>
                {byPath.size} 文件 <span className="text-success-fg">+{added}</span>{" "}
                <span className="text-danger-fg">−{removed}</span>
              </>
            ) : undefined
          }
          collapsed={collapsed.changes}
          onToggle={() => setCollapsed((value) => ({ ...value, changes: !value.changes }))}
        />
        {!collapsed.changes && (
          <div className="max-h-[260px] overflow-y-auto px-3.5 pb-3">
            {changes.length === 0 ? (
              <p className="text-[11.5px] text-text-muted">还没有文件改动</p>
            ) : (
              <>
                <div className="text-[12px] text-text-secondary">
                  {byPath.size} 文件 · <span className="text-success-fg">+{added}</span>{" "}
                  <span className="text-danger-fg">−{removed}</span>
                </div>
                <button
                  type="button"
                  onClick={onOpenChanges}
                  className="mt-2 flex items-center gap-1.5 rounded-[6px] border border-line px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:border-line-strong hover:text-text-primary"
                >
                  <FileDiff {...ICON.sm} />
                  查看全部改动
                </button>
              </>
            )}
          </div>
        )}
      </section>
    </aside>
  );
}
