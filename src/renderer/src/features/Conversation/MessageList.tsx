/**
 * 消息渲染：消息气泡、思考轨、可展开的工具卡片（内嵌 diff）、流式光标。
 *
 * 布局对齐高保真：助手消息用左侧 46px 角色列 + 正文列；用户消息右对齐，
 * 角色标签在右。工具卡片走语义化图标 + 路径 + 增删行数 + 耗时 + 内嵌 diff。
 * 工具卡里若副标题**就是该工具操作的文件**，则该路径可点 → onOpenFile（A3-2「点任意文件路径」）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Brain,
  Check,
  ChevronRight,
  Eye,
  FileEdit,
  FilePlus,
  Globe,
  Monitor,
  Terminal,
  Wrench,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ViewFileChange, ViewMessage } from "@shared/worker-protocol";
import { Markdown } from "../../components/Markdown";
import { DiffView } from "../../components/DiffView";
import { TerminalOutput } from "../../components/TerminalOutput";
import { formatArgs, matchChangeByPath, parseArgsJson } from "../../lib/format";
import { cn } from "../../lib/utils";

type ToolResult = { output: string; isError: boolean; image?: { data: string; mimeType: string } };

/**
 * 助手行级骨架：左侧固定角色列 + 右侧正文列。
 * 流式态与完成态共用它，保证同一轮助手内容在不同生命周期下左边缘与宽度一致，
 * 避免“流式时没对齐、结束后才对齐”的跳动。
 */
export function AssistantRow({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-2.5">
      <span className="w-[46px] shrink-0 pt-[3px] text-[11px] text-text-muted">Agent</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** 一条消息：正文 + 其发起的工具调用卡片 */
export function MessageBubble({
  message,
  resultMap,
  changes,
  onHoverFile,
  onOpenFile,
  openState,
}: {
  message: ViewMessage;
  resultMap: Map<string, ToolResult>;
  changes: ViewFileChange[];
  onHoverFile?: (path: string | null) => void;
  /** 点工具卡里的文件路径 → 在右栏预览它（A3-2） */
  onOpenFile?: (path: string) => void;
  /** 工具卡展开状态共享表（键 = 工具调用 id），与流式区共用，完成迁移时不丢展开态 */
  openState?: Map<string, boolean>;
}): React.JSX.Element | null {
  // 工具结果已合并进各自的工具卡片，不再单独成条
  if (message.role === "toolResult") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  // 只带图片、没有文字的消息也必须渲染
  if (!message.text && !message.image && message.toolCalls.length === 0) return null;

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[72%] flex-col items-end gap-1.5 rounded-[8px] border border-r-[3px] border-line border-r-accent-dim bg-surface-overlay px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-text-primary">
          {message.image && (
            <img
              src={`data:${message.image.mimeType};base64,${message.image.data}`}
              alt="随消息发送的图片"
              className="max-h-64 rounded-[6px] border border-line"
            />
          )}
          {message.text}
        </div>
        <span className="ml-2.5 shrink-0 pt-[3px] text-[11px] text-text-muted">你</span>
      </div>
    );
  }

  return (
    <AssistantRow>
      {message.thought && <ThoughtBlock text={message.thought} />}
      {message.text && <Markdown>{message.text}</Markdown>}
      {message.toolCalls.map((call) => (
        <ToolCard
          key={call.id}
          openId={call.id}
          openState={openState}
          name={call.name}
          args={call.args}
          durationMs={call.durationMs}
          result={resultMap.get(call.id)}
          change={matchChangeByPath(changes, parseArgsJson(call.args).path)}
          onHoverFile={onHoverFile}
          onOpenFile={onOpenFile}
        />
      ))}
    </AssistantRow>
  );
}

/** 折叠的思考摘要：默认收起，展开看完整推理（氛围组，不抢主回复） */
function ThoughtBlock({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 text-[12px] text-text-muted transition hover:text-text-secondary"
      >
        <ChevronRight
          {...ICON.sm}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
        <Brain {...ICON.sm} />
        已思考
      </button>
      {open && <div className="thought mt-1.5">{text}</div>}
    </div>
  );
}

/**
 * 运行中的思考轨：默认折叠成与完成态 ThoughtBlock 等高的单行标题，
 * 避免流式结束后从“展开”塌缩为“已思考”时的高度跳变。展开可看实时推理。
 */
export function ThinkingRail({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 text-[12px] text-text-muted transition hover:text-text-secondary"
      >
        <ChevronRight
          {...ICON.sm}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
        <Brain {...ICON.sm} />
        思考中…
      </button>
      {open && <div className="thought mt-1.5">{text}</div>}
    </div>
  );
}

/** 工具类型 → 语义化图标与副标题（对齐 ACP ToolKind） */
function describeTool(
  name: string,
  args: Record<string, unknown>,
): { icon: ReactNode; subtitle?: string } {
  const path = typeof args.path === "string" ? args.path : undefined;
  const command = typeof args.command === "string" ? args.command : undefined;
  switch (name) {
    case "edit":
      return { icon: <FileEdit {...ICON.sm} />, subtitle: path };
    case "write":
      return { icon: <FilePlus {...ICON.sm} />, subtitle: path };
    case "read":
    case "grep":
    case "glob":
    case "ls":
    case "list":
    case "search":
      return { icon: <Eye {...ICON.sm} />, subtitle: command ?? path };
    case "bash":
      return { icon: <Terminal {...ICON.sm} />, subtitle: command };
    case "browser_read":
    case "browser_screenshot":
    case "browser_act": {
      const url = typeof args.url === "string" ? args.url : undefined;
      const action = typeof args.action === "string" ? args.action : undefined;
      const ref = typeof args.ref === "string" ? args.ref : undefined;
      return { icon: <Globe {...ICON.sm} />, subtitle: url ?? action ?? ref };
    }
    case "computer_screenshot":
    case "computer_action": {
      const action = typeof args.action === "string" ? args.action : "screenshot";
      const coords =
        typeof args.x === "number" && typeof args.y === "number" ? `(${args.x}, ${args.y})` : undefined;
      return { icon: <Monitor {...ICON.sm} />, subtitle: coords ? `${action} ${coords}` : action };
    }
    default:
      return { icon: <Wrench {...ICON.sm} />, subtitle: path ?? command };
  }
}

/** 耗时展示：<1s 用毫秒，否则保留一位小数 */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 可展开的工具调用卡片：折叠时显示名称 + 参数摘要 + 增删/耗时 */
export function ToolCard({
  name,
  args,
  result,
  durationMs,
  change,
  running,
  openId,
  openState,
  onHoverFile,
  onOpenFile,
}: {
  name: string;
  args: string;
  result?: ToolResult;
  durationMs?: number;
  change?: ViewFileChange;
  running?: boolean;
  /** 展开 state 共享表里的键（工具调用 id）；与 openState 成对使用 */
  openId?: string;
  /** 跨「流式区 → 完成态」迁移的展开状态表；缺省时展开状态只在实例本地 */
  openState?: Map<string, boolean>;
  onHoverFile?: (path: string | null) => void;
  /** 点副标题里的文件路径 → 在右栏预览它（A3-2） */
  onOpenFile?: (path: string) => void;
}): React.JSX.Element {
  // 展开状态优先取共享表（同一工具调用在流式区与完成态是两次挂载，
  // 实例本地 state 会在迁移时清零——用户正展开读实时输出，完成瞬间却被收起）。
  const [open, setOpenState] = useState(
    () => (openId !== undefined ? openState?.get(openId) : undefined) ?? Boolean(running),
  );
  const setOpen = (value: boolean): void => {
    setOpenState(value);
    if (openId !== undefined) openState?.set(openId, value);
  };
  const parsed = useMemo(() => parseArgsJson(args), [args]);
  const { icon, subtitle } = describeTool(name, parsed);
  const isError = result?.isError ?? false;
  const path = typeof parsed.path === "string" ? parsed.path : undefined;
  const hasArgs = Object.keys(parsed).length > 0;
  const hasStat = change !== undefined && (change.addedLines > 0 || change.removedLines > 0);
  // 工具条副标题（路径 / 命令）：超长时截断，仅在截断时挂 title 悬停展示完整内容
  const subtitleText = change?.path ?? subtitle;
  /**
   * 副标题若**就是这个工具操作的文件**，则可点开预览（A3-2「点任意文件路径」）。
   *
   * 判定刻意用「展示文本 === 路径」而不是「有 path 参数」：grep / glob 这类工具的副标题
   * 可以是搜索模式（`command ?? path`），点一个模式却打开文件会让人错愕——所见即所点。
   * 有改动记录时以记录里的相对路径为准（那是 `toRelative(cwd, …)` 的产物，最可信）。
   *
   * 路径可能是绝对路径（模型给的），主进程照样收——只要落在项目内（见 `src/main/file-read.ts`）。
   */
  const previewPath =
    change?.path ?? (path !== undefined && path === subtitle ? path : undefined);
  const clickable = previewPath !== undefined;
  const subtitleRef = useRef<HTMLSpanElement>(null);
  const [subtitleTruncated, setSubtitleTruncated] = useState(false);
  useEffect(() => {
    const el = subtitleRef.current;
    if (!el) return;
    const measure = (): void => setSubtitleTruncated(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [subtitleText]);

  return (
    <div
      className={cn(
        "self-start overflow-hidden rounded-[8px] border bg-surface-raised",
        isError ? "border-danger/50" : "border-line",
      )}
      onMouseEnter={() => onHoverFile?.(path ?? null)}
      onMouseLeave={() => onHoverFile?.(null)}
    >
      {/* 行容器用 div：路径要成为**独立**可点目标，而 <button> 里嵌 <button> 是非法结构 */}
      <div className="flex w-full items-center gap-2 px-3 py-2 transition hover:bg-surface-overlay/50">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={open ? "收起" : "展开"}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            {...ICON.sm}
            className={cn("shrink-0 text-text-muted transition-transform", open && "rotate-90")}
          />
          <span className="shrink-0 text-text-muted">{icon}</span>
          <span className="shrink-0 font-mono text-[11.5px] font-semibold text-text-primary">
            {name}
          </span>
        </button>
        <span
          ref={subtitleRef}
          title={clickable ? `点击预览 ${previewPath}` : subtitleTruncated ? subtitleText : undefined}
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : undefined}
          onClick={clickable ? () => onOpenFile?.(previewPath) : undefined}
          onKeyDown={
            clickable
              ? (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onOpenFile?.(previewPath);
                }
              : undefined
          }
          className={cn(
            // min-w-0 允许在窄中栏收缩（truncate 兜底）：固定 320 不可缩时，
            // 右侧的增删行数 / 运行态 / 失败徽标会被挤出卡片、被 overflow 裁掉。
            "w-[320px] min-w-0 truncate font-mono text-[11.5px] text-text-secondary",
            clickable && "cursor-pointer hover:text-text-primary hover:underline",
          )}
        >
          {subtitleText ?? ""}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[11px] text-text-muted">
          {hasStat && (
            <span>
              <span className="text-success-fg">+{change!.addedLines}</span>{" "}
              <span className="text-danger-fg">−{change!.removedLines}</span>
            </span>
          )}
          {running ? (
            <span className="flex items-center gap-1.5 text-text-secondary">
              <span className="live-dot" />
              运行中
            </span>
          ) : result ? (
            isError ? (
              <span className="text-danger-fg">失败</span>
            ) : (
              <span className="flex items-center gap-1 text-success">
                <Check {...ICON.xs} />
                {durationMs !== undefined ? formatDuration(durationMs) : "完成"}
              </span>
            )
          ) : null}
        </span>
      </div>

      {open && (
        <div className="border-t border-line bg-surface p-2">
          {change?.patch ? (
            <DiffView patch={change.patch} />
          ) : (
            <>
              {hasArgs && (
                <>
                  <div className="mb-1 text-[11px] text-text-muted">参数</div>
                  <pre className="mb-2 max-h-32 overflow-auto rounded-[6px] bg-surface-code px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-text-secondary">
                    {formatArgs(args)}
                  </pre>
                </>
              )}
              <div className="mb-1 text-[11px] text-text-muted">输出</div>
              {result ? (
                <>
                  {result.image && (
                    <img
                      alt="工具截图"
                      className="mb-2 max-h-80 rounded-[6px] border border-line"
                      src={`data:${result.image.mimeType};base64,${result.image.data}`}
                    />
                  )}
                  {result.output ? (
                    name === "bash" ? (
                      <TerminalOutput text={result.output} className="max-h-80" />
                    ) : (
                      <pre className="max-h-80 overflow-auto rounded-[6px] bg-surface-code px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-text-secondary">
                        {result.output}
                      </pre>
                    )
                  ) : result.image ? null : (
                    <p className="px-1 text-[11px] text-text-muted">（无输出）</p>
                  )}
                </>
              ) : running ? (
                <p className="px-1 text-[11px] text-text-muted">执行中…</p>
              ) : (
                <p className="px-1 text-[11px] text-text-muted">（无输出）</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

