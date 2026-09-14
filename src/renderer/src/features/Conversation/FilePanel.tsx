/**
 * 右栏工作区的「文件」视图：**预览**（A3-2）+ **本次改动树**（A3-4 范围 A）。
 *
 * 安全边界**不在这里**：渲染层只传路径，根由主进程按 `sessionId → 项目` 推出
 * （见 `src/main/file-read.ts`）。所以这里对「越界 / 不存在 / 不是文件」只需把主进程
 * 给的原因原样显示，不必自己再判一遍（判了也是两套说法，早晚不一致）。
 *
 * 布局对齐高保真 `.file-view`：**预览左 + 树右**。树是 A3-4 的**范围 A**——
 * 只列 agent 本次动过的文件（`view.fileChanges`），**不是整项目树**：右栏是「现场」（⑦-A），
 * 「项目里有什么」是 IDE 的问题。附带好处是 `+` →「文件」从「只能看空态」变成「能从树里挑一个文件」。
 *
 * 预览按类型分流，**不做「尽力渲染半截内容」**：
 *   - 文本：`.md` 走 Markdown（与助手回复同一套渲染），其余按代码等宽显示；
 *   - 图片：直接给 dataUrl；
 *   - 二进制 / 过大：只给一句说明——半截内容比看不到更容易误导。
 *
 * `target.seq` 每次「打开」都自增，因此**同一文件再点一次也会重读**（agent 可能刚改过它）。
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileWarning,
  Folder,
  Loader2,
  RotateCw,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import { buildFileTree, countTreeFiles, type FileTreeNode } from "@/lib/file-tree";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FileReadResult } from "@shared/protocol";
import type { ViewFileChange } from "@shared/worker-protocol";
import { Markdown } from "../../components/Markdown";

/** 走 Markdown 渲染的扩展名；其余文本一律按代码显示 */
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

/** 空态 / 不可预览 / 过大的统一排版：图标 + 标题 + 说明 */
function Placeholder({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
      {icon}
      <p className="mt-2 text-[12.5px] text-text-secondary">{title}</p>
      <p className="max-w-[260px] text-[11.5px] leading-relaxed text-text-muted">{body}</p>
    </div>
  );
}

export function FilePanel({
  sessionId,
  target,
  changes,
  onOpenFile,
  onReload,
}: {
  sessionId: string;
  /** 要预览的文件；null = 尚未选过文件。seq 变化触发重读（含同一路径再点一次） */
  target: { path: string; seq: number } | null;
  /** 本次会话改动过的文件（树的数据源） */
  changes: ViewFileChange[];
  /** 从树里选文件 → 预览它（与「点路径」同一条路，会带 seq 重读） */
  onOpenFile: (path: string) => void;
  /** 重新读取当前文件 */
  onReload: () => void;
}): React.JSX.Element {
  const [result, setResult] = useState<FileReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const path = target?.path ?? null;
  const seq = target?.seq ?? 0;

  useEffect(() => {
    if (path === null) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    setError(null);
    void window.banyan
      .invoke("file.read", { sessionId, path })
      .then((next) => {
        if (!disposed) setResult(next);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setResult(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, path, seq]);

  return (
    <div className="file-view flex min-h-0 w-full flex-1" data-file-view={path ?? ""}>
      {/* 预览列 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {path === null ? (
          <Placeholder
            icon={<FileWarning className="text-text-muted" style={{ width: 26, height: 26 }} />}
            title="还没有打开文件"
            body="点「正在处理」里的文件路径，或从「本次改动」列表里挑一个。"
          />
        ) : (
          <>
            {/* 文件头：路径 + 体积 + 重读 */}
            <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line px-2.5">
              <span className="truncate font-mono text-[11px] text-text-secondary" title={path}>
                {path}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {result !== null && (
                  <span className="text-[10.5px] text-text-muted">{formatBytes(result.size)}</span>
                )}
                <button
                  type="button"
                  onClick={onReload}
                  title="重新读取"
                  aria-label="重新读取"
                  className="rounded-[4px] p-1 text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
                >
                  <RotateCw {...ICON.xs} />
                </button>
              </span>
            </div>

            {loading ? (
              <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12px] text-text-muted">
                <Loader2 {...ICON.sm} className="animate-spin" />
                正在读取…
              </div>
            ) : error !== null ? (
              <Placeholder
                icon={<AlertTriangle className="text-warning" style={{ width: 24, height: 24 }} />}
                title="无法预览该文件"
                body={error}
              />
            ) : result === null ? null : result.kind === "text" ? (
              MARKDOWN_EXT.test(path) ? (
                <div className="min-h-0 flex-1 overflow-auto px-4 py-4" data-file-text>
                  <Markdown>{result.text}</Markdown>
                </div>
              ) : (
                <pre
                  data-file-text
                  className="min-h-0 flex-1 overflow-auto whitespace-pre bg-surface-code px-3 py-3 font-mono text-[11.5px] leading-relaxed text-text-secondary"
                >
                  {result.text}
                </pre>
              )
            ) : result.kind === "image" ? (
              <div className="min-h-0 flex-1 overflow-auto p-3">
                <img
                  src={result.dataUrl}
                  alt={path}
                  data-file-image
                  className="max-w-full rounded-[6px] border border-line"
                />
              </div>
            ) : result.kind === "too-large" ? (
              <Placeholder
                icon={<FileWarning className="text-text-muted" style={{ width: 24, height: 24 }} />}
                title="文件过大，已跳过预览"
                body={`${formatBytes(result.size)} 超出上限 ${formatBytes(result.limit)}。`}
              />
            ) : (
              <Placeholder
                icon={<FileWarning className="text-text-muted" style={{ width: 24, height: 24 }} />}
                title="二进制文件，暂不支持预览"
                body={`${formatBytes(result.size)}。`}
              />
            )}
          </>
        )}
      </div>

      <FileTree changes={changes} activePath={path} onOpenFile={onOpenFile} />
    </div>
  );
}

/**
 * 「本次改动」树：把 `fileChanges` 按目录折成树（纯逻辑见 `lib/file-tree.ts`）。
 *
 * 窄栏自动让位：`.file-view` 是命名容器，栅格窄到阈值时整棵树隐藏（见 `styles.css`）——
 * 否则 200px 的树会把预览挤到没法看（右栏最小可拖到 220px）。
 * 树内**自己做可折叠**，因为 200px 对预览已是笔固定开销，得给用户一个手动让位的开关。
 */
function FileTree({
  changes,
  activePath,
  onOpenFile,
}: {
  changes: ViewFileChange[];
  activePath: string | null;
  onOpenFile: (path: string) => void;
}): React.JSX.Element {
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const nodes = useMemo(() => buildFileTree(changes), [changes]);
  const total = countTreeFiles(nodes);

  const toggleDir = (dirPath: string): void => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  if (treeCollapsed) {
    return (
      <div
        data-file-tree
        data-tree-collapsed=""
        className="fv-tree flex w-8 shrink-0 flex-col items-center border-l border-line bg-surface-raised pt-1.5"
      >
        <button
          type="button"
          onClick={() => setTreeCollapsed(false)}
          title="展开改动列表"
          aria-label="展开改动列表"
          className="flex h-6 w-6 items-center justify-center rounded-[5px] text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
        >
          <ChevronLeft {...ICON.sm} />
        </button>
      </div>
    );
  }

  return (
    <div
      data-file-tree
      className="fv-tree flex w-[200px] shrink-0 flex-col border-l border-line bg-surface-raised"
    >
      <div className="flex h-[30px] shrink-0 items-center gap-1.5 border-b border-line pr-1 pl-2.5">
        <span className="shrink-0 text-[11px] font-semibold text-text-secondary">本次改动</span>
        <span className="shrink-0 text-[10.5px] text-text-muted">{total}</span>
        <button
          type="button"
          onClick={() => setTreeCollapsed(true)}
          title="收起改动列表"
          aria-label="收起改动列表"
          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
        >
          <ChevronRight {...ICON.sm} />
        </button>
      </div>

      {nodes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] leading-relaxed text-text-muted">
          本次还没有改动文件
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
          {nodes.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              activePath={activePath}
              collapsedDirs={collapsedDirs}
              onToggleDir={toggleDir}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  activePath,
  collapsedDirs,
  onToggleDir,
  onOpenFile,
}: {
  node: FileTreeNode;
  depth: number;
  activePath: string | null;
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}): React.JSX.Element {
  // 目录缩进 +12、起始 6；文件行多一个与折叠箭头等宽的空位，末两列才能对齐
  const indent = { paddingLeft: 6 + depth * 12 };

  if (node.change === undefined) {
    const collapsed = collapsedDirs.has(node.path);
    return (
      <div>
        <button
          type="button"
          data-tree-dir={node.path}
          onClick={() => onToggleDir(node.path)}
          title={node.path}
          style={indent}
          className="flex w-full items-center gap-1.5 rounded-[5px] py-[3px] pr-1.5 text-left transition hover:bg-surface-overlay"
        >
          <ChevronRight
            {...ICON.sm}
            className={cn("shrink-0 text-text-muted transition-transform", !collapsed && "rotate-90")}
          />
          <Folder {...ICON.sm} className="shrink-0 text-text-muted" />
          <span className="truncate font-mono text-[11px] text-text-secondary">{node.name}</span>
        </button>
        {!collapsed &&
          node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              collapsedDirs={collapsedDirs}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
            />
          ))}
      </div>
    );
  }

  const active = node.path === activePath;
  return (
    <button
      type="button"
      data-tree-file={node.path}
      onClick={() => onOpenFile(node.path)}
      title={`点击预览 ${node.path}`}
      style={indent}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-[5px] py-[3px] pr-1.5 text-left transition hover:bg-surface-overlay",
        active && "bg-surface-overlay",
      )}
    >
      <span className="w-[13px] shrink-0" aria-hidden />
      <FileText {...ICON.sm} className="shrink-0 text-text-muted" />
      <span
        className={cn(
          "truncate font-mono text-[11px]",
          active ? "text-text-primary" : "text-text-secondary",
        )}
      >
        {node.name}
      </span>
      <span
        className={cn(
          "ml-auto shrink-0 text-[10px] font-bold",
          node.change.kind === "edit" ? "text-warning" : "text-success-fg",
        )}
      >
        {node.change.kind === "edit" ? "M" : "A"}
      </span>
    </button>
  );
}
