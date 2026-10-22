// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 侧栏的行组件：工作目录行（`ProjectRow`）与会话行（`SessionRow`）。
 *
 * 从 `App.tsx` 抽出（2026-10，P0 残余收尾）：`App.tsx` 要装下侧栏搜索重做与会话菜单，
 * 先把这两块自成一体的行模板搬走，再往上加——搬移是**纯位置变化，行为零变化**。
 * `App.tsx` 里留 import，调用点一个字都不用动。
 */
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Copy,
  FolderSync,
  MoreHorizontal,
  Pin,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { formatSessionStamp } from "@/lib/format";
import { ICON } from "@/lib/icon";
import type { Project, SessionInfo } from "@shared/protocol";
import { cn } from "@/lib/utils";

/** 已运行时长：mm:ss */
export function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/** 工作目录行：折叠三角 + 目录名 + 新建会话 + 重新定位 + 从列表移除 */
export function ProjectRow({
  project,
  active,
  expanded,
  busy,
  unavailable,
  onToggle,
  onActivate,
  onNewSession,
  onRelocate,
  onRemove,
}: {
  project: Project;
  active: boolean;
  expanded: boolean;
  /** 该目录下有会话正在运行（含等人回话）——此时不允许移除，与主进程的拒绝一致 */
  busy: boolean;
  /** 位置不可用（FR-04）：仍可打开查看历史，但不把新会话建进去；标记要一直看得见 */
  unavailable: boolean;
  onToggle: () => void;
  onActivate: () => void;
  onNewSession: () => void;
  /** 重新定位（FR-04）：修复同一条登记——换一个文件夹，历史保留、文件不搬移 */
  onRelocate: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div
      data-project-row={project.id}
      className={cn(
        "group flex items-center gap-1 rounded-sm py-1.5 pl-1.5 pr-1.5 transition",
        active ? "bg-surface-overlay" : "hover:bg-surface-overlay/60",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={expanded ? "收起" : "展开"}
        className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted transition hover:text-text-primary"
      >
        <ChevronDown
          {...ICON.xs}
          className={cn("transition-transform", !expanded && "-rotate-90")}
        />
      </button>
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          unavailable ? "bg-danger" : "bg-text-muted",
        )}
      />
      <button type="button" onClick={onActivate} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm text-text-primary">{project.name}</div>
      </button>
      {unavailable && (
        <span
          data-project-unavailable
          title="目录不存在或暂时无法访问：会话可查看历史，但不能发送"
          className="shrink-0 rounded-xs bg-warning-soft px-1.5 py-0.5 text-2xs text-warning-fg"
        >
          位置不可用
        </span>
      )}
      <button
        type="button"
        onClick={onNewSession}
        disabled={unavailable}
        title={unavailable ? "位置不可用：请重新定位或在别处新建" : "新建会话"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line-soft hover:text-text-primary focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Plus {...ICON.xs} />
      </button>
      <button
        type="button"
        onClick={onRelocate}
        disabled={busy}
        data-project-relocate
        title={
          busy
            ? "有会话正在运行，请先停止再重新定位"
            : "重新定位：换一个文件夹修复这条登记（历史保留，文件不搬移）"
        }
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line-soft hover:text-text-primary focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <FolderSync {...ICON.xs} />
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        data-project-remove
        title={busy ? "有会话正在运行，暂不能移除目录" : "从列表移除（不影响磁盘上的文件，可恢复）"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line-soft hover:text-text-primary focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
      >
        <X {...ICON.xs} />
      </button>
    </div>
  );
}

/**
 * 会话菜单（PRD FR-05）：「查看产物」「打开此会话的位置」「在新位置继续…」「归档」「删除」。
 *
 * 行内悬停图标（图钉 / 归档 / 复制 / 删除）是**快捷方式**，这里是 PRD 点名的完整集合。
 * 「在新位置继续…」与「归档」「删除」对运行中的会话置灰——运行中的会话不能复制、
 * 不能归档、不能删除（FR-03 / FR-07 的同一条纪律）。
 */
function SessionMenu({
  archived,
  running,
  onViewArtifacts,
  onReveal,
  onContinue,
  onToggleArchive,
  onDelete,
}: {
  archived: boolean;
  running: boolean;
  onViewArtifacts: () => void;
  onReveal: () => void;
  onContinue: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  // 展开态的根（切换按钮 + 菜单）。外点判断要认**自己**的 DOM，不能用
  // `[data-session-menu]` 选择器——侧栏每行都有菜单按钮，选错了会把「点开另一行
  // 的菜单」当成菜单内点击，两个菜单同时挂在那儿。
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="会话菜单"
        aria-label="打开会话菜单"
        aria-haspopup="menu"
        data-session-menu
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover/session:opacity-100 hover:bg-line-soft hover:text-text-primary focus:opacity-100"
      >
        <MoreHorizontal {...ICON.xs} />
      </button>
    );
  }
  const item = (
    label: string,
    marker: string,
    action: () => void,
    opts?: { disabled?: boolean; title?: string },
  ): React.JSX.Element => (
    <button
      type="button"
      data-session-menu-item={marker}
      disabled={opts?.disabled}
      title={opts?.title}
      onClick={() => {
        setOpen(false);
        action();
      }}
      className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs text-text-secondary transition hover:bg-surface-overlay hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {label}
    </button>
  );
  return (
    <div ref={rootRef} className="relative shrink-0" data-session-menu>
      <button
        type="button"
        onClick={() => setOpen(false)}
        title="会话菜单"
        aria-label="关闭会话菜单"
        aria-haspopup="menu"
        aria-expanded
        className="flex h-5 w-5 items-center justify-center rounded-xs bg-line-soft text-text-primary"
      >
        <MoreHorizontal {...ICON.xs} />
      </button>
      <div
        role="menu"
        className="absolute right-0 top-6 z-20 w-44 rounded-md border border-line bg-surface-raised p-1 shadow-md"
      >
        {item("查看产物", "artifacts", onViewArtifacts, {
          title: "按目录内容列出这条会话的产物文件",
        })}
        {item("打开此会话的位置", "reveal", onReveal, {
          title: "在系统文件管理器里打开这条会话工作的目录",
        })}
        {item("在新位置继续…", "continue", onContinue, {
          disabled: running,
          title: running
            ? "运行中的会话不能复制到新位置，请先停止"
            : "把对话与改动记录复制到另一个工作位置",
        })}
        {item(archived ? "恢复" : "归档", "archive", onToggleArchive, {
          disabled: !archived && running,
          title:
            !archived && running
              ? "运行中的会话不可归档"
              : archived
                ? "恢复：移回会话列表"
                : "归档：从列表收起（数据保留）",
        })}
        {item("删除", "delete", onDelete, {
          disabled: running,
          title: running ? "运行中的会话不可删除" : "删除会话",
        })}
      </div>
    </div>
  );
}

/** 会话行：状态点 + 标题 / 副标题（运行中带计时），悬停显示图钉/归档/复制/删除与会话菜单 */
export function SessionRow({
  session,
  active,
  archived,
  context,
  tags,
  startedAt,
  offlineState,
  waiting,
  pinned,
  now,
  onClick,
  onTogglePin,
  onToggleArchive,
  onViewArtifacts,
  onReveal,
  onContinue,
  onDelete,
}: {
  session: SessionInfo;
  active: boolean;
  /** 归档态：标题变暗、不画图钉、悬停出「恢复」。数据仍在，只是收在底部「已归档」区里 */
  archived: boolean;
  /**
   * 前置上下文（**所属项目名**）——底部「已归档」区是**跨项目**的，不写项目名会分不清
   * 不同项目里的同名会话；常规列表按项目分组，传 `undefined`。
   */
  context?: string;
  /**
   * 状态小标（搜索结果用，PRD FR-05：归档与已移除的会话参与搜索并**标出状态**；
   * 产物文件名命中也在这里给一句「产物 · 文件名」）。常规列表不传。
   */
  tags?: string[];
  startedAt?: number;
  /**
   * worker 已离开内存的原因：空闲休眠（stopped）/ 崩溃（crashed）。
   * 与 startedAt 正交：停止的会话一定不在运行中。
   */
  offlineState?: "dormant" | "crashed";
  /**
   * 有待用户处置的请求，及是哪一类：**授权**（等人给许可）还是**提问**（等人给信息）。
   * 协议层刻意把两者分成两条通道（approval.pending / userquestion.pending），
   * 这里也必须分开说——模型提问不是申请授权，混用会稀释用户对真正授权卡的警觉。
   * undefined = 没有待处置。同一会话两类同时挂起时取「授权」（更该被看见）。
   */
  waiting: "approval" | "question" | undefined;
  /** 被钉住的会话不被自动回收。与 offlineState 正交：钉住只是「别收」，不代表进程还活着 */
  pinned: boolean;
  now: number;
  onClick: () => void;
  onTogglePin: () => void;
  /** 归档 / 恢复本行（`archived` 决定方向，见 setSessionArchived） */
  onToggleArchive: () => void;
  /** 会话菜单 ·「查看产物」：打开这条会话的产物清单（按目录内容） */
  onViewArtifacts: () => void;
  /** 会话菜单 ·「打开此会话的位置」 */
  onReveal: () => void;
  /** 会话菜单 ·「在新位置继续…」 */
  onContinue: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const running = startedAt !== undefined;
  const [copied, setCopied] = useState(false);

  // 同 Markdown.tsx：复位定时器挂到 effect 上，卸载即清，不对已卸载组件 setState
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyId = (): void => {
    void navigator.clipboard.writeText(session.id).then(() => setCopied(true));
  };

  return (
    <div
      data-session-row={session.id}
      className={cn(
        "group/session flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 transition",
        active ? "bg-surface-overlay" : "hover:bg-surface-overlay/60",
      )}
    >
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span
          className={cn(
            "h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]",
            waiting
              ? "pulse-dot border-warning bg-warning"
              : running
                ? "pulse-dot border-success bg-success"
                : offlineState === "crashed"
                  ? "border-danger bg-danger"
                  : offlineState === "dormant"
                    ? "border-warning"
                    : active
                      ? "border-accent bg-accent"
                      : "border-text-muted",
          )}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm leading-tight",
              active ? "text-text-primary" : archived ? "text-text-muted" : "text-text-secondary",
            )}
          >
            {session.title}
          </span>
          <span
            className={cn(
              "block truncate text-2xs leading-tight tabular-nums",
              waiting
                ? "text-warning"
                : offlineState === "crashed"
                  ? "text-danger-fg"
                  : "text-text-muted",
            )}
          >
            {context && <span className="text-text-muted">{context} · </span>}
            {waiting
              ? waiting === "approval"
                ? "等待你的授权"
                : "等待你的回答"
              : running
                ? `运行中 · ${formatElapsed(startedAt, now)}`
                : offlineState === "crashed"
                  ? "异常中断 · 发送即恢复"
                  : offlineState === "dormant"
                    ? "空闲休眠 · 发送即恢复"
                    : formatSessionStamp(session.updatedAt)}
          </span>
        </span>
        {tags !== undefined && tags.length > 0 && (
          <span className="flex shrink-0 flex-col items-end gap-0.5">
            {tags.map((tag) => (
              <span
                key={tag}
                data-session-tag={tag}
                className="max-w-[88px] truncate rounded-xs bg-surface-overlay px-1 py-px text-2xs text-text-muted"
              >
                {tag}
              </span>
            ))}
          </span>
        )}
      </button>
      {/* 图钉只在常规行出现：归档时主进程已解掉图钉（见 session.setArchived），
          在归档行上画它等于展示一个已被清掉的状态 */}
      {!archived && (
        <button
          type="button"
          onClick={onTogglePin}
          title={pinned ? "已钉住 · 不会被自动回收" : "钉住：不让它被自动回收"}
          aria-label={pinned ? "取消钉住" : "钉住会话"}
          aria-pressed={pinned}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-xs transition hover:bg-line-soft focus:opacity-100",
            pinned
              ? "text-accent opacity-100"
              : "text-text-muted opacity-0 group-hover/session:opacity-100 hover:text-text-primary",
          )}
        >
          <Pin {...ICON.xs} className={pinned ? "fill-current" : undefined} />
        </button>
      )}
      {/* 归档 / 恢复：可逆、不删任何数据（与删除会话的分界）。**归档运行中的会话**会被
          主进程拒绝（它会从列表消失、却在后台继续跑），故与删除一致地置灰并说明原因；
          **恢复**不受限——把一条归档会话捞回来是无害的。 */}
      <button
        type="button"
        onClick={onToggleArchive}
        disabled={!archived && running}
        title={
          !archived && running
            ? "运行中的会话不可归档"
            : archived
              ? "恢复：移回会话列表"
              : "归档：从列表收起（数据保留）"
        }
        aria-label={archived ? "恢复会话" : "归档会话"}
        data-session-archive={archived ? "restore" : "archive"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover/session:opacity-100 hover:bg-line-soft hover:text-text-primary focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
      >
        {archived ? <ArchiveRestore {...ICON.xs} /> : <Archive {...ICON.xs} />}
      </button>
      <button
        type="button"
        onClick={copyId}
        title={copied ? "已复制" : "复制会话 ID"}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted transition hover:bg-line-soft hover:text-text-primary focus:opacity-100",
          copied ? "text-success-fg opacity-100" : "opacity-0 group-hover/session:opacity-100",
        )}
      >
        {copied ? <Check {...ICON.xs} /> : <Copy {...ICON.xs} />}
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={running}
        title={running ? "运行中的会话不可删除" : "删除会话"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover/session:opacity-100 hover:bg-line-soft hover:text-danger-fg focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
      >
        <Trash2 {...ICON.xs} />
      </button>
      <SessionMenu
        archived={archived}
        running={running}
        onViewArtifacts={onViewArtifacts}
        onReveal={onReveal}
        onContinue={onContinue}
        onToggleArchive={onToggleArchive}
        onDelete={onDelete}
      />
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="px-3 py-6 text-center text-xs leading-relaxed text-text-muted">
      {children}
    </p>
  );
}
