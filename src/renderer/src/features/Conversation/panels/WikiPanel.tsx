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
 * 唯一的源码入口是**页底的「涉及组件」**：`module_tree.json` 已经把「这一页讲哪些
 * 组件」写好了（`路径::符号`），点一条复用现成的 `FilePreview` 打开。它没有目录树、
 * 没有搜索，入口只来自当前页面——这是一次**从文档到源码的下钻**，不是第二个浏览器。
 * 边界与 `file.read` 同源：渲染层只传路径，越界由主进程拒绝。
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
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, BookOpen, ChevronRight, Loader2, Play, RotateCw, TriangleAlert } from "lucide-react";
import type { Components } from "react-markdown";
import type { WikiGenerateSnapshot, WikiPage, WikiStatus, WikiTreeNode } from "@shared/protocol";
import { WIKI_LOG_MAX_LINES } from "@shared/wiki";
import { ICON } from "@/lib/icon";
import { resolveWikiLink } from "@/lib/wiki-link";
import { parseWikiComponent, componentsForPage } from "@shared/wiki-tree";
import { cn } from "../../../lib/utils";
import { CodeBlock, Markdown } from "../../../components/Markdown";
import { SidePanelShell } from "./SidePanelShell";
import { MermaidBlock } from "./MermaidBlock";
import { FilePreview } from "./FilePreview";

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

/** 任务耗时：不到一分钟给秒，超过给「X 分 Y 秒」 */
function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

const JOB_PHASE_LABEL: Record<WikiGenerateSnapshot["phase"], string> = {
  running: "CodeWiki 运行中…",
  done: "上次生成完成",
  failed: "上次生成失败",
  cancelled: "上次生成已取消（半成品保留在 docs/wiki）",
};

/**
 * 生成任务卡片：跑的时候给**最近几行**（进度是活的），结束后收起成一段日志。
 * 终态卡片不自动消失——失败原因要留到用户看见为止（`docs/ERRORS.md` 的「别撒谎」）。
 */
function JobCard({ job }: { job: WikiGenerateSnapshot }): React.JSX.Element {
  const running = job.phase === "running";
  return (
    <div
      data-wiki-job={job.phase}
      className={cn(
        "mb-2 rounded-md border px-2 py-1.5 text-2xs leading-relaxed",
        job.phase === "failed"
          ? "border-danger/40 bg-danger-soft text-danger-fg"
          : "border-line bg-surface-overlay text-text-muted",
      )}
    >
      <div className="flex items-center gap-1.5">
        {running ? (
          <Loader2 {...ICON.xs} className="shrink-0 animate-spin" />
        ) : job.phase === "failed" ? (
          <TriangleAlert {...ICON.xs} className="shrink-0" />
        ) : null}
        <span className={cn(running && "text-text-secondary")}>{JOB_PHASE_LABEL[job.phase]}</span>
        {job.finishedAt === null ? null : (
          <span>· {formatDuration(job.finishedAt - job.startedAt)}</span>
        )}
      </div>
      {job.error === null ? null : (
        <p className="mt-1 whitespace-pre-wrap break-words">{job.error}</p>
      )}
      {running ? (
        job.lines.length === 0 ? (
          <p className="mt-1">
            已启动，等待第一行输出…（首次运行可能要几十秒；日志会逐行出现在这里）
          </p>
        ) : (
          <pre className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono">
            {job.lines.slice(-6).join("\n")}
          </pre>
        )
      ) : job.lines.length === 0 ? null : (
        <details className="mt-1" open={job.phase === "failed"}>
          <summary className="cursor-pointer select-none">日志 · {job.lines.length} 行</summary>
          <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono">
            {job.lines.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
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
  /** 当前/最近一次生成任务；`null` = 这个项目从没跑过（不是错误） */
  const [job, setJob] = useState<WikiGenerateSnapshot | null>(null);
  /** 「没有启动」的原因（前置检查缺件、spawn 失败），与任务本身的 `error` 分开 */
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /**
   * 面板当前跟的是哪个会话的任务。同一项目的生成是**单飞**的：另一个会话发起时，
   * `wiki.generate.status` 返回的仍是同一个任务，进度事件也要跟着那个 sessionId 收，
   * 否则界面会停在一帧（看起来像卡死）。
   */
  const jobSessionRef = useRef<string | null>(null);
  /** 页面里点开的组件（源码预览）；null = 正在看 wiki 页 */
  const [source, setSource] = useState<{ path: string; symbol: string | null } | null>(null);
  /** 源码预览的重读令牌：再点同一个组件也要重读（agent 可能刚改过） */
  const [sourceReload, setSourceReload] = useState(0);

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
      setSource(null);
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

  /** 面板重挂载 / 切页签回来时把进度接回来；读不到不算错误（进度是附加信息） */
  const loadJob = useCallback(async () => {
    try {
      const next = await window.colt.invoke("wiki.generate.status", { sessionId });
      jobSessionRef.current = next?.sessionId ?? null;
      setJob(next);
    } catch {
      // 目录本身由 loadStatus 的 error 呈现；这里静默即可
    }
  }, [sessionId]);

  const startGeneration = useCallback(
    async (mode: "full" | "update") => {
      const { confirmed } = await window.colt.invoke("dialog.confirm", {
        message: mode === "update" ? "更新仓库 Wiki？" : "生成仓库 Wiki？",
        detail:
          (mode === "update"
            ? "会在项目根运行 codewiki generate --update --output docs/wiki，只重写与代码差异相关的组件。"
            : "会在项目根运行 codewiki generate --output docs/wiki，全量重写 docs/wiki/。") +
          "\n\n这会花模型额度并修改工作区；写入路径由 Colt 固定，不需要逐页批准。" +
          "需要先为 CodeWiki 配好 provider 与密钥（codewiki config set）。" +
          "\n\n可以随时取消；已写出的半成品会保留，之后用「更新」接着修。",
        confirmLabel: mode === "update" ? "更新" : "生成",
      });
      if (!confirmed) return;
      setStarting(true);
      setStartError(null);
      try {
        const result = await window.colt.invoke("wiki.generate.start", { sessionId, mode });
        if (result.error !== null) setStartError(result.error);
        // 同项目已有任务（可能是另一个会话发起的）：接上它的进度
        else if (result.alreadyRunning) await loadJob();
      } catch (reason) {
        setStartError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setStarting(false);
      }
    },
    [sessionId, loadJob],
  );

  const cancelGeneration = useCallback(async () => {
    try {
      // 取消按**任务所属会话**发起：同项目单飞时，任务可能不是这个会话开的
      await window.colt.invoke("wiki.generate.cancel", {
        sessionId: job?.sessionId ?? sessionId,
      });
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [sessionId, job?.sessionId]);

  // 订阅生成进度。终态（done / failed / cancelled）后重读产物：
  // 成功要刷新时间与页数，取消也要如实显示已经写出来的那部分。
  useEffect(() => {
    return window.colt.on("wiki.generateState", (event) => {
      if (event.sessionId !== sessionId && event.sessionId !== jobSessionRef.current) return;
      jobSessionRef.current = event.sessionId;
      setJob((current) => {
        const prior = current?.sessionId === event.sessionId ? current.lines : [];
        const lines = [...prior, ...event.lines];
        if (lines.length > WIKI_LOG_MAX_LINES) {
          lines.splice(0, lines.length - WIKI_LOG_MAX_LINES);
        }
        return { ...event, lines };
      });
      if (event.phase !== "running") void loadStatus();
    });
  }, [sessionId, loadStatus]);

  // 换会话即回到列表：上一次会话的页面路径在新项目里大概率不存在
  useEffect(() => {
    setOpenPath(null);
    setPage(null);
    setPageError(null);
    setExpanded(new Set());
    setSource(null);
    setJob(null);
    setStartError(null);
    jobSessionRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    void loadStatus();
    void loadJob();
  }, [loadStatus, loadJob]);

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

  const running = job?.phase === "running";
  // `done` 不占位置：产物时间与页数已经在摘要条里。失败 / 取消要留到用户看见为止。
  const showJob = job !== null && job.phase !== "done";

  // 页面视图：页面 → 组件源码，逐层后退
  if (openPath !== null) {
    const pageComponents = componentsForPage(status?.tree ?? [], openPath);
    const pageName = openPath.slice(openPath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <div className="flex h-[var(--h-panel-head)] shrink-0 items-center gap-1 border-b border-line px-2">
          <button
            type="button"
            onClick={() => {
              if (source !== null) {
                setSource(null);
                return;
              }
              setOpenPath(null);
              setPage(null);
              setPageError(null);
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted hover:bg-line-soft hover:text-text-primary"
            title={source === null ? "返回目录" : "返回页面"}
          >
            <ArrowLeft {...ICON.sm} />
          </button>
          <span
            className="min-w-0 flex-1 truncate text-xs text-text-secondary"
            title={
              source === null
                ? openPath
                : `${source.path}${source.symbol === null ? "" : ` · ${source.symbol}`}`
            }
          >
            {source === null
              ? pageName
              : (source.symbol ?? source.path.slice(source.path.lastIndexOf("/") + 1))}
          </span>
        </div>
        {source !== null ? (
          <FilePreview
            sessionId={sessionId}
            path={source.path}
            reloadToken={sourceReload}
            onReload={() => setSourceReload((token) => token + 1)}
          />
        ) : (
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

            {pageComponents.length > 0 ? (
              <div className="mt-4 border-t border-line pt-2" data-wiki-components={pageComponents.length}>
                <div className="mb-1 text-2xs uppercase tracking-[.5px] text-text-muted">
                  涉及组件 · {pageComponents.length}
                </div>
                {pageComponents.map((raw, index) => {
                  const part = parseWikiComponent(raw);
                  if (part === null) return null;
                  return (
                    <button
                      key={`${raw}:${index}`}
                      type="button"
                      data-wiki-component={part.path}
                      onClick={() => {
                        setSource(part);
                        // 连点同一个组件也要重读：agent 可能刚改过源码
                        setSourceReload((token) => token + 1);
                      }}
                      className="mb-1 flex w-full items-baseline gap-2 rounded-sm px-1 py-0.5 text-left transition hover:bg-line-soft"
                      title={`${part.path}${part.symbol === null ? "" : ` · ${part.symbol}`}`}
                    >
                      <span className="shrink-0 truncate font-mono text-2xs text-text-secondary">
                        {part.symbol ?? "（整个文件）"}
                      </span>
                      <span className="min-w-0 truncate text-2xs text-text-muted">{part.path}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
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
      // 启动失败走外壳的 error 位：空态时 children 不渲染，放里面会「点了生成、什么都没发生」
      error={startError ?? error}
      isEmpty={status !== null && !status.present && !showJob}
      empty={
        <span className="block">
          这个项目还没有 wiki 产物（<span className="font-mono">docs/wiki/</span> 不存在）。
          <br />
          点右上角「生成」让 CodeWiki 从仓库写出文档；也可以在项目根跑{" "}
          <span className="font-mono">codewiki generate --output docs/wiki</span>。
        </span>
      }
      onRefresh={() => void loadStatus()}
      actions={
        running ? (
          <button
            type="button"
            onClick={() => void cancelGeneration()}
            className="rounded-xs px-1.5 py-0.5 text-2xs text-text-muted transition hover:bg-line-soft hover:text-danger"
          >
            取消
          </button>
        ) : (
          <>
            {status?.present ? (
              <button
                type="button"
                disabled={starting}
                onClick={() => void startGeneration("update")}
                className="flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-2xs text-text-secondary transition hover:bg-line-soft hover:text-text-primary disabled:opacity-50"
                title="只重写与代码差异相关的组件"
              >
                <RotateCw {...ICON.xs} />
                更新
              </button>
            ) : null}
            <button
              type="button"
              disabled={starting}
              onClick={() => void startGeneration("full")}
              className="flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-2xs font-medium text-accent-dim transition hover:bg-line-soft hover:text-accent disabled:opacity-50"
              title={status?.present ? "从头全量生成" : "生成仓库 Wiki"}
            >
              <Play {...ICON.xs} />
              {starting ? "启动中…" : status?.present ? "全量" : "生成"}
            </button>
          </>
        )
      }
    >
      {status !== null && status.error !== null ? (
        <div className="mb-2 rounded-md border border-warning/40 bg-warning-soft px-2 py-1.5 text-2xs leading-relaxed text-warning-fg">
          {status.error}
        </div>
      ) : null}

      {showJob && job !== null ? <JobCard job={job} /> : null}

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
