// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「文件」页签（⑦ 的可插拔视图之一）：**整项目**的只读文件浏览器。
 *
 * 与「任务摘要」下钻（⑦-G）的关系：那是「本次会话动过哪些文件」的不同粒度，这里是
 * 「项目里有什么」——浏览整棵目录树，与改动记录无关。两份数据不同源（`file.list` vs
 * 会话视图），所以是并列页签而不是又一层下钻。
 *
 * 只读：浏览 + 预览，**没有**新建 / 重命名 / 删除——写盘是 agent 工具与审批的领域，
 * 用户侧再加一套绕过审批的写入口会破坏「所有落盘动作可裁决」的安全模型。
 *
 * 结构：左右分栏，**内容在左、目录树在右**——浏览时视线与阅读起点都在内容上，树只是
 * 索引，贴右不挡正文。右是懒加载目录树（展开某层才拉某层），左是**现成的 `FilePreview`**
 * （安全边界在主进程，这里只传路径）。
 *
 * 树**可整体收起**（头部开关，v1.80）：收起后预览占满全宽——树是索引，逛完就该让位。
 * （节点级的逐个展开/收起是树自己的事，见 `DirNode`。）
 *
 * 分栏而不是「点开→返回」是因为浏览的核心动作是「逛目录、瞄一眼」，每看一个文件都要
 * 折返一次树是纯粹的损耗。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileSearch,
  Folder,
  FolderOpen,
  FolderTree,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import type { FsEntry } from "@shared/protocol";
import { cn } from "../../../lib/utils";
import { FilePreview } from "./FilePreview";

/** 树区固定宽度：够看全常见文件名，又不至于把预览挤没（预览才需要横向空间） */
const TREE_WIDTH = 220;

/** 一个目录的树节点数据：条目 + 该层的拉取状态 */
interface DirState {
  entries: FsEntry[];
  truncated: boolean;
  loading: boolean;
  /** 该层拉取失败的原因（列目录是快照，agent 正在删文件是常态——单层失败别拖垮整棵树） */
  error: string | null;
}

/** 把一层的 FsEntry[] 渲染成树（目录可递归展开） */
function TreeLayer({
  entries,
  depth,
  states,
  expanded,
  selected,
  onToggleDir,
  onSelectFile,
  onRetry,
}: {
  entries: FsEntry[];
  depth: number;
  states: ReadonlyMap<string, DirState>;
  expanded: ReadonlySet<string>;
  selected: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onRetry: (path: string) => void;
}): React.JSX.Element | null {
  if (entries.length === 0) {
    return depth === 0 ? (
      <p className="px-3 py-10 text-center text-xs leading-relaxed text-text-muted">
        项目内没有可浏览的文件
      </p>
    ) : (
      // 空目录也给一句：留白的话用户分不清「空的」和「没加载出来」
      <p className="py-1 text-2xs text-text-muted" style={{ paddingLeft: depth * 12 + 18 }}>
        （空目录）
      </p>
    );
  }
  return (
    <>
      {entries.map((entry) =>
        entry.kind === "dir" ? (
          <DirNode
            key={entry.path}
            entry={entry}
            depth={depth}
            states={states}
            expanded={expanded}
            selected={selected}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
            onRetry={onRetry}
          />
        ) : (
          <button
            key={entry.path}
            type="button"
            data-file-entry={entry.path}
            onClick={() => onSelectFile(entry.path)}
            style={{ paddingLeft: depth * 12 + 26 }}
            className={cn(
              "flex h-6 w-full shrink-0 items-center gap-1.5 rounded-xs pr-2 text-left text-xs transition",
              selected === entry.path
                ? "bg-accent-soft font-medium text-text-primary"
                : "text-text-secondary hover:bg-surface-overlay hover:text-text-primary",
            )}
          >
            <File {...ICON.xs} className="shrink-0 text-text-muted" />
            <span className="truncate">{entry.name}</span>
          </button>
        ),
      )}
    </>
  );
}

/** 目录节点：自身一行 +（展开时）子层递归 */
function DirNode({
  entry,
  depth,
  states,
  expanded,
  selected,
  onToggleDir,
  onSelectFile,
  onRetry,
}: {
  entry: FsEntry;
  depth: number;
  states: ReadonlyMap<string, DirState>;
  expanded: ReadonlySet<string>;
  selected: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onRetry: (path: string) => void;
}): React.JSX.Element {
  const isOpen = expanded.has(entry.path);
  const state = states.get(entry.path);
  return (
    <>
      <button
        type="button"
        data-dir-entry={entry.path}
        aria-expanded={isOpen}
        onClick={() => onToggleDir(entry.path)}
        style={{ paddingLeft: depth * 12 + 8 }}
        className="flex h-6 w-full shrink-0 items-center gap-1 rounded-xs pr-2 text-left text-xs text-text-secondary transition hover:bg-surface-overlay hover:text-text-primary"
      >
        {isOpen ? (
          <ChevronDown {...ICON.xs} className="shrink-0 text-text-muted" />
        ) : (
          <ChevronRight {...ICON.xs} className="shrink-0 text-text-muted" />
        )}
        {isOpen ? (
          <FolderOpen {...ICON.xs} className="shrink-0 text-text-muted" />
        ) : (
          <Folder {...ICON.xs} className="shrink-0 text-text-muted" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {isOpen && state !== undefined && (
        <div>
          {state.loading && state.entries.length === 0 ? (
            <p className="py-1 text-2xs text-text-muted" style={{ paddingLeft: depth * 12 + 30 }}>
              正在读取…
            </p>
          ) : state.error !== null ? (
            <p
              className="flex items-center gap-1.5 py-1 text-2xs leading-relaxed text-text-muted"
              style={{ paddingLeft: depth * 12 + 30 }}
            >
              <span className="min-w-0 flex-1">列不出来：{state.error}</span>
              <button
                type="button"
                onClick={() => onRetry(entry.path)}
                className="shrink-0 text-text-secondary underline decoration-line transition hover:text-text-primary"
              >
                重试
              </button>
            </p>
          ) : (
            <TreeLayer
              entries={state.entries}
              depth={depth + 1}
              states={states}
              expanded={expanded}
              selected={selected}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
              onRetry={onRetry}
            />
          )}
          {state.truncated && (
            <p
              className="py-1 text-2xs text-text-muted"
              style={{ paddingLeft: depth * 12 + 30 }}
              title="这一层的条目超过单层上限，只列出了前 500 个"
            >
              还有更多，仅显示前 500 条
            </p>
          )}
        </div>
      )}
    </>
  );
}

export function FilesPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  /** 每层目录的拉取结果（path → 该层状态）。根目录的键是 "" */
  const [states, setStates] = useState<Map<string, DirState>>(new Map());
  /** 已展开的目录集合（含根 ""）——树的可折叠状态 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [selected, setSelected] = useState<string | null>(null);
  /** 整棵目录树是否收起（收起后预览占满全宽；树的数据保留，展开即时回来） */
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  /** 预览的重读令牌：自增驱动 FilePreview 重读（重读按钮用；agent 可能刚改过文件） */
  const [reloadToken, setReloadToken] = useState(0);

  /** 拉某一层（不动展开态；已展开的层刷新时也走这里，有旧数据时静默换新） */
  const loadDir = useCallback(
    (path: string): void => {
      setStates((prev) => {
        const old = prev.get(path);
        const next = new Map(prev);
        next.set(path, {
          entries: old?.entries ?? [],
          truncated: old?.truncated ?? false,
          loading: true,
          error: null,
        });
        return next;
      });
      void window.colt
        .invoke("file.list", { sessionId, path })
        .then((result) => {
          setStates((prev) => {
            const next = new Map(prev);
            next.set(path, {
              entries: result.entries,
              truncated: result.truncated,
              loading: false,
              error: null,
            });
            return next;
          });
        })
        .catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          setStates((prev) => {
            const next = new Map(prev);
            next.set(path, { entries: [], truncated: false, loading: false, error: message });
            return next;
          });
        });
    },
    [sessionId],
  );

  // 换会话时整棵树重置：那是另一个项目的目录（与下钻状态同一条纪律）。
  // 依赖只看 sessionId：loadDir 也随它变，写进依赖只会让重置语义更绕。
  useEffect(() => {
    setStates(new Map());
    setExpanded(new Set([""]));
    setSelected(null);
    setReloadToken(0);
    loadDir("");
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 点目录：切换展开；首次展开（或上次失败）即拉取——懒加载 */
  const toggleDir = useCallback(
    (path: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      const cached = states.get(path);
      if (cached === undefined || cached.error !== null) loadDir(path);
    },
    [states, loadDir],
  );

  /** 刷新：清缓存，按当前展开集合重拉（含根）——展开位置不丢 */
  const refresh = useCallback((): void => {
    setStates(new Map());
    for (const dir of expanded) loadDir(dir);
  }, [expanded, loadDir]);

  const root = states.get("");
  const rootLoading = root === undefined || (root.loading && root.entries.length === 0);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" data-files-tree="">
      {/* 头部：标题 + 隐藏说明 + 目录树收起开关 + 刷新（对齐 FilePreview / 浏览器页签的头部模式） */}
      <div className="flex h-[var(--h-panel-head)] shrink-0 items-center gap-2 border-b border-line px-2.5">
        <FolderTree {...ICON.sm} className="shrink-0 text-text-muted" />
        <span className="text-xs font-medium text-text-secondary">文件</span>
        {!treeCollapsed && (
          <span
            className="shrink-0 text-2xs text-text-muted"
            title="这些目录不参与浏览：内容是哈希对象 / 依赖黑盒，列出来没有意义"
          >
            已隐藏 .git · node_modules
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setTreeCollapsed((value) => !value)}
            title={treeCollapsed ? "展开目录树" : "收起目录树"}
            aria-label={treeCollapsed ? "展开目录树" : "收起目录树"}
            aria-expanded={!treeCollapsed}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
          >
            {treeCollapsed ? <PanelRightOpen {...ICON.xs} /> : <PanelRightClose {...ICON.xs} />}
          </button>
          <button
            type="button"
            onClick={refresh}
            title="重新读取目录"
            aria-label="重新读取目录"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
          >
            <RefreshCw {...ICON.xs} className={cn(root?.loading === true && "animate-spin")} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：选中文件的预览（现成组件；安全边界在主进程）。内容在左——阅读起点不被树挡 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-files-preview-pane="">
          {selected === null ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <FileSearch className="text-text-muted" style={{ width: 24, height: 24 }} />
              <p className="mt-2 text-sm text-text-secondary">选择一个文件预览</p>
              <p className="max-w-[240px] text-xs leading-relaxed text-text-muted">
                点右侧的文件名查看内容；目录可展开（树可整体收起）。预览是只读的。
              </p>
            </div>
          ) : (
            <FilePreview
              sessionId={sessionId}
              path={selected}
              reloadToken={reloadToken}
              onReload={() => setReloadToken((token) => token + 1)}
            />
          )}
        </div>

        {/* 右：目录树（懒加载）。可整体收起——收起时整块不渲染，预览占满全宽；
            树的数据留在 states 里，再展开即时回来。整棵树可横向滚动兜底，别把预览挤没 */}
        {!treeCollapsed && (
          <div
            className="min-h-0 shrink-0 overflow-y-auto overflow-x-auto border-l border-line py-1"
            style={{ width: TREE_WIDTH }}
            data-files-tree-pane=""
          >
            {rootLoading ? (
              <p className="px-3 py-10 text-center text-xs text-text-muted">加载中…</p>
            ) : root === undefined || root.error !== null ? (
              <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
                <p className="text-xs leading-relaxed text-text-secondary">
                  目录读取失败：{root?.error ?? "未知原因"}
                </p>
                <button
                  type="button"
                  onClick={refresh}
                  className="rounded-xs border border-line px-2 py-1 text-xs text-text-secondary transition hover:bg-surface-overlay hover:text-text-primary"
                >
                  重试
                </button>
              </div>
            ) : (
              <TreeLayer
                entries={root.entries}
                depth={0}
                states={states}
                expanded={expanded}
                selected={selected}
                onToggleDir={toggleDir}
                onSelectFile={setSelected}
                onRetry={loadDir}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
