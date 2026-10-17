// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「Wiki」页签：读 CodeWiki 生成的仓库文档（`docs/wiki/`）。
 *
 * ## 它为什么不是「第二个文件浏览器」
 *
 * 这里只呈现**模块树 → 页面**这条叙事：一页讲一个模块，页面之间有相对链接。
 * 看源码仍然走「文件」页签与 `read`（`AGENTS.md` §3.6：入口一旦职责重叠，
 * 用户就不知道该点哪个）。所以本面板**不**做文件树、不做搜索、不做编辑。
 *
 * ## 三种状态都要如实呈现，不能糊成一种
 *
 *   - 没生成：说明怎么生成（这是正常状态，不是错误）
 *   - 生成了但过期：`behind > 0` 明说落后多少；`behind === null` 说「比较不了」
 *     ——把「不知道」显示成「最新」是本面板最容易撒的谎
 *   - 生成了但树坏了：`status.error` 照实展示，页面仍可读（别让导航坏了把内容也挡掉）
 *
 * ## 页内链接
 *
 * wiki 页之间是相对链接（产物里形如 `[x](<模块/页.md>)`，文件名含空格时用尖括号包裹）。
 * 默认的 `<a target="_blank">` 会把这种链接丢给系统浏览器，必然 404——所以这里覆盖
 * `a`：能解析到 `docs/wiki/` 内的 `.md` 就留在应用内换页，其余（http、锚点）按原样。
 */
import { Children, isValidElement, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, ChevronRight } from "lucide-react";
import type { Components } from "react-markdown";
import type { WikiPage, WikiStatus, WikiTreeNode } from "@shared/protocol";
import { ICON } from "@/lib/icon";
import { resolveWikiLink } from "@/lib/wiki-link";
import { cn } from "../../../lib/utils";
import { CodeBlock, Markdown } from "../../../components/Markdown";
import { SidePanelShell } from "./SidePanelShell";
import { MermaidBlock } from "./MermaidBlock";

/** 从 `<pre>` 的孩子里认出 ```mermaid 块；不是就返回 null */
function mermaidSource(children: ReactNode): string | null {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null;
  if (!(child.props.className ?? "").includes("language-mermaid")) return null;
  return String(child.props.children ?? "");
}

/** 一小节标题 + 缩进的行；`depth` 只影响缩进，不影响可点性 */
function TreeRow({
  node,
  /** 从根到本节点的名字链：展开状态的键。用 title 会撞名（两个模块都叫 index 时一起开合） */
  pathKey,
  depth,
  open,
  onOpen,
  onToggle,
}: {
  node: WikiTreeNode;
  pathKey: string;
  depth: number;
  /** 已展开的节点（按路径链认） */
  open: ReadonlySet<string>;
  onOpen: (page: string) => void;
  onToggle: (key: string) => void;
}): React.JSX.Element {
  const hasChildren = node.children.length > 0;
  const expanded = open.has(pathKey);
  return (
    <div>
      <div
        className="flex items-center gap-1 rounded-sm pr-1 hover:bg-line-soft"
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        <button
          type="button"
          onClick={() => (hasChildren ? onToggle(pathKey) : undefined)}
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center text-text-muted",
            hasChildren ? "hover:text-text-primary" : "invisible",
          )}
          title={expanded ? "收起" : "展开"}
          tabIndex={hasChildren ? 0 : -1}
        >
          <ChevronRight
            {...ICON.xs}
            className={cn("transition-transform", expanded && "rotate-90")}
          />
        </button>
        {node.page === null ? (
          <span className="flex-1 truncate py-1 text-xs text-text-muted" title="这个模块没有页面">
            {node.title}
            <span className="ml-1 text-2xs">（无页面）</span>
          </span>
        ) : (
          <button
            type="button"
            data-wiki-page={node.page}
            onClick={() => onOpen(node.page as string)}
            className="flex-1 truncate py-1 text-left text-xs text-text-secondary hover:text-text-primary"
          >
            {node.title}
          </button>
        )}
      </div>
      {hasChildren && expanded
        ? node.children.map((child) => (
            <TreeRow
              key={`${pathKey}/${child.title}`}
              node={child}
              pathKey={`${pathKey}/${child.title}`}
              depth={depth + 1}
              open={open}
              onOpen={onOpen}
              onToggle={onToggle}
            />
          ))
        : null}
    </div>
  );
}

/** 时间只取到分钟：`2026-10-17T22:03:43.924415` → `2026-10-17 22:03` */
function shortTime(raw: string | null): string | null {
  if (raw === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(raw);
  return match === null ? raw : `${match[1]} ${match[2]}`;
}

export function WikiPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [status, setStatus] = useState<WikiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 展开的节点（顶层默认展开；深层默认收起，否则大仓库一屏全是叶子） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.colt.invoke("wiki.status", { sessionId });
      setStatus(next);
      // 顶层默认展开一次就够：用户手动收起后不该被下一次刷新又掰开
      setExpanded((current) =>
        current.size > 0 ? current : new Set(next.tree.map((node) => node.title)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const openPage = useCallback(
    async (path: string) => {
      setOpenPath(path);
      setPageLoading(true);
      setPageError(null);
      try {
        setPage(await window.colt.invoke("wiki.page", { sessionId, path }));
      } catch (reason) {
        setPage(null);
        setPageError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setPageLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // 换会话即回到列表：上一次会话的页面路径在新项目里大概率不存在
  useEffect(() => {
    setOpenPath(null);
    setPage(null);
    setPageError(null);
    setExpanded(new Set());
  }, [sessionId]);

  /** 页内链接：能解析到 docs/wiki 内的 .md 就换页，否则按外链交给系统浏览器 */
  const components = useMemo<Components>(
    () => ({
      pre: ({ children }) => {
        const source = mermaidSource(children);
        return source === null ? <CodeBlock>{children}</CodeBlock> : <MermaidBlock code={source} />;
      },
      a: ({ node, href, children, ...rest }) => {
        void node;
        const target = href === undefined || openPath === null ? null : resolveWikiLink(openPath, href);
        if (target === null) {
          return (
            <a href={href} {...rest} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
        return (
          <a
            {...rest}
            href={href}
            className="cursor-pointer"
            onClick={(event) => {
              event.preventDefault();
              void openPage(target);
            }}
          >
            {children}
          </a>
        );
      },
    }),
    [openPath, openPage],
  );

  const toggle = useCallback((title: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }, []);

  const summarize = useCallback((value: WikiStatus): ReactNode => {
    const time = shortTime(value.generatedAt);
    const parts: string[] = [];
    if (time !== null) parts.push(`生成于 ${time}`);
    if (value.commit !== null) {
      if (value.behind === 0) parts.push("与 HEAD 一致");
      else if (value.behind === null) parts.push(`提交 ${value.commit.slice(0, 7)}（无法比较）`);
      else parts.push(`落后 ${value.behind} 个提交`);
    } else if (value.present) {
      parts.push("未记录生成提交");
    }
    if (parts.length === 0) return null;
    const stale = value.behind !== null && value.behind > 0;
    return (
      <div
        className={cn(
          "mx-2 mt-2 rounded-md border px-2 py-1 text-2xs leading-relaxed",
          stale
            ? "border-warning/40 bg-warning-soft text-warning-fg"
            : "border-line bg-surface-overlay text-text-muted",
        )}
      >
        {parts.join(" · ")}
        {stale ? "（结论可能已过期）" : ""}
      </div>
    );
  }, []);

  // 概览入口：它不在 module_tree 里（顶层页面），单独钉在列表最上面
  const overview = status?.overview ?? null;

  // 页面视图
  if (openPath !== null) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <div className="flex h-[var(--h-panel-head)] shrink-0 items-center gap-1 border-b border-line px-2">
          <button
            type="button"
            onClick={() => {
              setOpenPath(null);
              setPage(null);
              setPageError(null);
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted hover:bg-line-soft hover:text-text-primary"
            title="返回目录"
          >
            <ArrowLeft {...ICON.sm} />
          </button>
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={openPath}>
            {openPath.slice(openPath.lastIndexOf("/") + 1).replace(/\.md$/i, "")}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {pageLoading ? (
            <p className="py-8 text-center text-xs text-text-muted">加载中…</p>
          ) : pageError !== null ? (
            <div className="rounded-md border border-danger/40 bg-danger-soft px-2 py-1.5 text-xs text-danger-fg">
              {pageError}
            </div>
          ) : page === null ? null : (
            <Markdown components={components}>{page.text}</Markdown>
          )}
        </div>
      </div>
    );
  }

  return (
    <SidePanelShell
      title="Wiki"
      icon={<BookOpen {...ICON.sm} />}
      meta={
        status !== null && status.present ? (
          <span className="text-text-muted">{status.pages} 页</span>
        ) : null
      }
      summary={status === null ? null : summarize(status)}
      loading={loading}
      error={error}
      isEmpty={status !== null && !status.present}
      empty={
        <span className="block">
          这个项目还没有 wiki 产物（<span className="font-mono">docs/wiki/</span> 不存在）。
          <br />
          让 agent 用 CodeWiki 生成，或在项目根跑 <span className="font-mono">codewiki generate --output docs/wiki</span>。
        </span>
      }
      onRefresh={() => void loadStatus()}
    >
      {status !== null && status.error !== null ? (
        <div className="mb-2 rounded-md border border-warning/40 bg-warning-soft px-2 py-1.5 text-2xs leading-relaxed text-warning-fg">
          {status.error}
        </div>
      ) : null}

      {overview !== null ? (
        <button
          type="button"
          data-wiki-page={overview}
          onClick={() => void openPage(overview)}
          className="mb-1 flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-left text-xs font-medium text-text-primary hover:bg-line-soft"
        >
          <BookOpen {...ICON.xs} className="shrink-0 text-text-muted" />
          概览
        </button>
      ) : null}

      {status?.tree.map((node) => (
        <TreeRow
          key={node.title}
          node={node}
          pathKey={node.title}
          depth={0}
          open={expanded}
          onOpen={(path) => void openPage(path)}
          onToggle={toggle}
        />
      ))}
    </SidePanelShell>
  );
}
