import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Coins,
  FileDiff,
  GitBranch,
  Loader2,
  RefreshCw,
  Send,
  Shrink,
  Square,
  Terminal,
} from "lucide-react";
import type { ConversationView, ViewFileChange, ViewMessage } from "@shared/worker-protocol";
import type { ProviderConfig, SessionUsage } from "@shared/protocol";
import { TerminalOutput } from "../components/TerminalOutput";
import { DiffView } from "../components/DiffView";
import { BranchTree } from "./BranchTree";
import { cn } from "../lib/utils";

/** 右侧面板多选一 */
type SidePanel = "none" | "changes" | "branches" | "usage";

/** 对话面板：消息流 + 流式文本 + 工具实时输出 + 文件改动
 *  作者：陕耀云栈WorkMate */
export function Conversation({
  sessionId,
  cwd,
  providers,
}: {
  sessionId: string;
  cwd: string;
  providers: ProviderConfig[];
}): React.JSX.Element {
  const [view, setView] = useState<ConversationView | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [panel, setPanel] = useState<SidePanel>("none");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    setOpening(true);
    setError(null);

    const offView = window.banyan.on("session.view", (next) => {
      if (disposed || next.sessionId !== sessionId) return;
      setView(next);
    });
    const offError = window.banyan.on("session.error", (payload) => {
      if (!disposed && payload.sessionId === sessionId) setError(payload.message);
    });

    void (async () => {
      try {
        await window.banyan.invoke("session.open", { sessionId, cwd });
        const current = await window.banyan.invoke("session.view", { sessionId });
        if (!disposed && current) setView(current);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!disposed) setOpening(false);
      }
    })();

    return () => {
      disposed = true;
      offView();
      offError();
      // 卸载时释放该会话的 worker。运行中会被主进程拒绝，交给空闲回收兼顾；
      // 重新打开时靠 JSONL 重放恢复，代价仅是一次启动延迟。
      void window.banyan.invoke("session.close", { sessionId }).catch(() => undefined);
    };
  }, [sessionId, cwd]);

  // 新内容到达时自动滚到底
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [view?.messages.length, view?.streamingText, view?.runningTools]);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setError(null);
    try {
      await window.banyan.invoke("session.prompt", { sessionId, text });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [input, sessionId]);

  const abort = useCallback(async () => {
    try {
      await window.banyan.invoke("session.abort", { sessionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  const compact = useCallback(async () => {
    setError(null);
    try {
      await window.banyan.invoke("session.compact", { sessionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  const switchModel = useCallback(
    async (value: string) => {
      // 下拉值形如 "providerId/modelId"，需拆开分别下发
      const slash = value.indexOf("/");
      if (slash === -1) return;
      const providerId = value.slice(0, slash);
      const modelId = value.slice(slash + 1);
      setError(null);
      try {
        await window.banyan.invoke("session.setModel", { sessionId, providerId, modelId });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId],
  );

  // toolCallId → 工具输出，供工具卡片展开时查阅
  const resultMap = useMemo(() => {
    const map = new Map<string, { output: string; isError: boolean }>();
    for (const item of view?.toolResults ?? []) map.set(item.id, item);
    return map;
  }, [view?.toolResults]);

  const running = view?.running ?? false;
  const changes = view?.fileChanges ?? [];

  // 当前会话所用 provider 与模型
  const currentProviderId = view?.model.split("/")[0] ?? "";
  const currentModelId = view?.model.split("/").slice(1).join("/") ?? "";
  // 跨 provider 选择：列出所有已配置密钥的 provider 的模型，值带上 provider 前缀
  const modelGroups = providers
    .map((provider) => ({
      provider,
      models: provider.models,
    }))
    .filter((group) => group.models.length > 0);
  const totalModels = modelGroups.reduce((sum, group) => sum + group.models.length, 0);

  // 上下文使用率：超过 70% 提示可压缩
  const contextWindow =
    providers
      .find((item) => item.id === currentProviderId)
      ?.models.find((item) => item.id === currentModelId)?.contextWindow ?? 0;
  const contextUsed = view?.stats.totalTokens ?? 0;
  const contextRatio = contextWindow > 0 ? contextUsed / contextWindow : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-[--color-border-subtle] px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm">{cwd}</div>
          <div className="flex items-center gap-2 text-xs text-[--color-text-muted]">
            {totalModels > 1 ? (
              <select
                value={`${currentProviderId}/${currentModelId}`}
                onChange={(e) => void switchModel(e.target.value)}
                className="rounded border border-[--color-border-subtle] bg-[--color-surface] px-1 py-0.5 text-xs outline-none"
              >
                {modelGroups.map((group) => (
                  <optgroup key={group.provider.id} label={group.provider.name}>
                    {group.models.map((option) => (
                      <option
                        key={`${group.provider.id}/${option.id}`}
                        value={`${group.provider.id}/${option.id}`}
                      >
                        {option.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <span>{view?.model ?? "—"}</span>
            )}
            {view && view.stats.totalTokens > 0 && (
              <span>
                {view.stats.totalTokens} tokens · ${view.stats.costUsd.toFixed(6)}
                {contextWindow > 0 && ` · 上下文 ${(contextRatio * 100).toFixed(1)}%`}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {contextRatio > 0.7 && (
            <button
              type="button"
              onClick={() => void compact()}
              className="flex items-center gap-1.5 rounded-md border border-[--color-warning]/50 px-2.5 py-1 text-xs text-[--color-warning] transition hover:bg-[--color-warning]/10"
              title="上下文已较满，压缩可释放空间"
            >
              <Shrink size={12} />
              压缩上下文
            </button>
          )}
          <button
            type="button"
            onClick={() => setPanel((value) => (value === "branches" ? "none" : "branches"))}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition",
              panel === "branches"
                ? "border-[--color-accent] text-[--color-accent]"
                : "border-[--color-border-subtle] text-[--color-text-secondary] hover:text-[--color-text-primary]",
            )}
          >
            <GitBranch size={12} />
            分支
          </button>
          {changes.length > 0 && (
            <button
              type="button"
              onClick={() => setPanel((value) => (value === "changes" ? "none" : "changes"))}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition",
                panel === "changes"
                  ? "border-[--color-accent] text-[--color-accent]"
                  : "border-[--color-border-subtle] text-[--color-text-secondary] hover:text-[--color-text-primary]",
              )}
            >
              <FileDiff size={12} />
              改动 {changes.length}
            </button>
          )}
          <button
            type="button"
            onClick={() => setPanel((value) => (value === "usage" ? "none" : "usage"))}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition",
              panel === "usage"
                ? "border-[--color-accent] text-[--color-accent]"
                : "border-[--color-border-subtle] text-[--color-text-secondary] hover:text-[--color-text-primary]",
            )}
            title="查看本次会话的用量历史"
          >
            <Coins size={12} />
            用量
          </button>
          {running && (
            <button
              type="button"
              onClick={() => void abort()}
              className="flex items-center gap-1.5 rounded-md border border-[--color-border-subtle] px-2.5 py-1 text-xs text-[--color-text-secondary] transition hover:border-[--color-danger] hover:text-[--color-danger]"
            >
              <Square size={12} />
              中断
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
          {opening && (
            <div className="flex items-center gap-2 text-sm text-[--color-text-muted]">
              <Loader2 size={14} className="animate-spin" />
              正在启动会话进程…
            </div>
          )}

          {error && (
            <div className="mb-3 rounded-lg border border-[--color-danger]/50 bg-[--color-danger]/10 px-3 py-2 text-sm text-[--color-danger]">
              {error}
            </div>
          )}

          {view?.messages.length === 0 && !opening && (
            <p className="mt-16 text-center text-sm text-[--color-text-muted]">
              会话已就绪，输入你的第一个问题。
            </p>
          )}

          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {view?.messages.map((message) => (
              <MessageBubble key={message.id} message={message} resultMap={resultMap} />
            ))}

            {view?.streamingText && (
              <Bubble role="assistant" streaming>
                {view.streamingText}
              </Bubble>
            )}

            {view?.runningTools.map((tool) => (
              <div
                key={tool.id}
                className="self-start rounded-lg border border-[--color-border-subtle] bg-[--color-surface-raised] px-3 py-2"
              >
                <div className="flex items-center gap-2 text-xs text-[--color-text-secondary]">
                  <Loader2 size={12} className="animate-spin" />
                  正在执行 <span className="font-mono">{tool.name}</span>
                </div>
                {/* bash 等工具运行中会持续回写全量输出快照 */}
                {tool.output && <TerminalOutput text={tool.output} className="mt-2 max-h-72" />}
              </div>
            ))}
          </div>
        </div>

        {panel === "changes" && (
          <ChangePanel changes={changes} onClose={() => setPanel("none")} />
        )}
        {panel === "branches" && <BranchTree sessionId={sessionId} />}
        {panel === "usage" && <UsagePanel sessionId={sessionId} onClose={() => setPanel("none")} />}
      </div>

      <div className="shrink-0 border-t border-[--color-border-subtle] p-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={running ? "Agent 运行中，输入内容将作为插话…" : "输入消息，Enter 发送，Shift+Enter 换行"}
            className="flex-1 resize-none rounded-lg border border-[--color-border-subtle] bg-[--color-surface-raised] px-3 py-2 text-sm outline-none transition placeholder:text-[--color-text-muted] focus:border-[--color-accent]"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!input.trim()}
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-[--color-accent] text-white transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={16} />
          </button>
        </div>
        {view && view.queuedCount > 0 && (
          <p className="mx-auto mt-1.5 max-w-3xl text-xs text-[--color-text-muted]">
            队列中还有 {view.queuedCount} 条待处理
          </p>
        )}
      </div>
    </div>
  );
}

/** 右侧用量历史面板：每次模型调用的 token 与费用，数据来自数据库 */
function UsagePanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}): React.JSX.Element {
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsage(await window.banyan.invoke("usage.list", { sessionId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-[--color-border-subtle] bg-[--color-surface-raised]">
      <div className="flex shrink-0 items-center justify-between border-b border-[--color-border-subtle] px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-[--color-text-secondary]">
          <Coins size={12} />
          用量历史
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="text-[--color-text-muted] transition hover:text-[--color-text-primary]"
            title="刷新"
          >
            <RefreshCw size={12} className={cn(loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-[--color-text-muted] transition hover:text-[--color-text-primary]"
          >
            收起
          </button>
        </div>
      </div>

      {error && (
        <div className="m-2 rounded-md border border-[--color-danger]/50 bg-[--color-danger]/10 px-2 py-1.5 text-xs text-[--color-danger]">
          {error}
        </div>
      )}

      {usage && usage.totals.calls > 0 && (
        <div className="shrink-0 border-b border-[--color-border-subtle] px-3 py-2 text-xs text-[--color-text-secondary]">
          <div>
            {usage.totals.calls} 次调用 · {(
              usage.totals.inputTokens + usage.totals.outputTokens
            ).toLocaleString("zh-CN")}{" "}
            tokens
          </div>
          <div className="text-[--color-text-muted]">
            输入 {usage.totals.inputTokens.toLocaleString("zh-CN")} · 输出{" "}
            {usage.totals.outputTokens.toLocaleString("zh-CN")}
            {usage.totals.cacheReadTokens + usage.totals.cacheWriteTokens > 0 &&
              ` · 缓存 ${(
                usage.totals.cacheReadTokens + usage.totals.cacheWriteTokens
              ).toLocaleString("zh-CN")}`}
          </div>
          <div className="mt-0.5 font-mono">${usage.totals.costUsd.toFixed(6)}</div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && !usage ? (
          <p className="px-2 py-6 text-center text-xs text-[--color-text-muted]">加载中…</p>
        ) : !usage || usage.records.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-[--color-text-muted]">
            还没有用量记录。发起对话后，每次模型调用都会记录在此。
          </p>
        ) : (
          usage.records.map((record) => (
            <div
              key={record.id}
              className="mb-1 rounded-md bg-[--color-surface-overlay] px-2 py-1.5"
            >
              <div className="flex items-center justify-between">
                <span className="truncate font-mono text-xs text-[--color-text-primary]">
                  {record.model ?? "—"}
                </span>
                <span className="shrink-0 text-[10px] text-[--color-text-muted]">
                  {new Date(record.createdAt).toLocaleTimeString("zh-CN")}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-[--color-text-muted]">
                <span>入 {record.inputTokens.toLocaleString("zh-CN")}</span>
                <span>出 {record.outputTokens.toLocaleString("zh-CN")}</span>
                <span className="ml-auto font-mono">${record.costUsd.toFixed(6)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

/** 右侧文件改动面板 */
function ChangePanel({
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
            {current
              ? "该改动由 write 工具整文件写入，内核未提供 diff。"
              : "暂无改动"}
          </p>
        )}
      </div>
    </aside>
  );
}

function MessageBubble({
  message,
  resultMap,
}: {
  message: ViewMessage;
  resultMap: Map<string, { output: string; isError: boolean }>;
}): React.JSX.Element | null {
  // 工具结果已合并进各自的工具卡片，不再单独成条
  if (message.role === "toolResult") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (!message.text && message.toolCalls.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {message.text && <Bubble role={message.role}>{message.text}</Bubble>}
      {message.toolCalls.map((call) => (
        <ToolCard key={call.id} call={call} result={resultMap.get(call.id)} />
      ))}
    </div>
  );
}

/** 可展开的工具调用卡片：折叠时只显示名称与参数摘要 */
function ToolCard({
  call,
  result,
}: {
  call: { id: string; name: string; args: string };
  result?: { output: string; isError: boolean };
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const isBash = call.name === "bash";

  return (
    <div
      className={cn(
        "self-start overflow-hidden rounded-lg border bg-[--color-surface-raised]",
        result?.isError ? "border-[--color-danger]/50" : "border-[--color-border-subtle]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition hover:bg-[--color-surface-overlay]/50"
      >
        <ChevronRight
          size={12}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
        <Terminal size={12} className="shrink-0 text-[--color-text-muted]" />
        <span className="font-mono text-xs">{call.name}</span>
        <span className="truncate font-mono text-xs text-[--color-text-muted]">{call.args}</span>
        {result?.isError && <span className="ml-auto shrink-0 text-xs text-[--color-danger]">失败</span>}
      </button>

      {open && (
        <div className="border-t border-[--color-border-subtle] p-2">
          <div className="mb-1 text-xs text-[--color-text-muted]">参数</div>
          <pre className="mb-2 max-h-32 overflow-auto rounded-md bg-black/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {formatArgs(call.args)}
          </pre>
          <div className="mb-1 text-xs text-[--color-text-muted]">输出</div>
          {result ? (
            isBash ? (
              <TerminalOutput text={result.output} className="max-h-80" />
            ) : (
              <pre className="max-h-80 overflow-auto rounded-md bg-black/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                {result.output}
              </pre>
            )
          ) : (
            <p className="px-1 text-xs text-[--color-text-muted]">（无输出）</p>
          )}
        </div>
      )}
    </div>
  );
}

function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function Bubble({
  role,
  children,
  streaming,
}: {
  role: "user" | "assistant";
  children: React.ReactNode;
  streaming?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
        role === "user"
          ? "self-end bg-[--color-accent] text-white"
          : "self-start border border-[--color-border-subtle] bg-[--color-surface-raised]",
      )}
    >
      {children}
      {streaming && <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle" />}
    </div>
  );
}
