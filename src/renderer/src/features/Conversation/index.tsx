/**
 * 对话面板：消息流 + 流式文本 + 工具实时输出 + 状态栏（Live Bar）+ 右侧面板编排。
 * 具体的改动/用量/工具/分支面板已拆到 panels/ 与 BranchTree。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ChevronDown,
  Coins,
  FileDiff,
  Loader2,
  Send,
  Shrink,
  Square,
  Wrench,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ConversationView } from "@shared/worker-protocol";
import type { ApprovalMode, ApprovalRequest, ProviderConfig } from "@shared/protocol";
import { cn } from "../../lib/utils";
import { Bubble, MessageBubble, ThinkingRail, ToolCard } from "./MessageList";
import { ChangesPanel } from "./panels/ChangesPanel";
import { UsagePanel } from "./panels/UsagePanel";
import { ToolsPanel } from "./panels/ToolsPanel";
import { ApprovalCard } from "./ApprovalCard";
import { FollowPanel } from "./FollowPanel";
import type { ReactNode } from "react";

/** 右侧面板多选一 */
type SidePanel = "none" | "changes" | "usage" | "tools";

/** 「长时间无事件」判定阈值：超过该秒数视为可能卡住 */
const STALE_IDLE_SEC = 30;

const MODE_OPTIONS: { value: ApprovalMode; label: string }[] = [
  { value: "approval", label: "审批模式" },
  { value: "full-access", label: "全权执行模式" },
];

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
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [mode, setMode] = useState<ApprovalMode>("approval");
  /** 跟随线联动：hover 工具卡片时高亮它碰的文件 */
  const [hoveredFile, setHoveredFile] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 心跳：运行期间每秒重渲染，驱动「已耗时 / 最后活动」显示
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!view?.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view?.running]);

  /** 本次运行开始时刻（running 变 true 时锁定；仅用于估算已耗时） */
  const runStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    runStartedAtRef.current = view?.running ? (runStartedAtRef.current ?? Date.now()) : null;
  }, [view?.running]);

  useEffect(() => {
    let disposed = false;
    setOpening(true);
    setError(null);
    setApprovals([]);

    const offView = window.banyan.on("session.view", (next) => {
      if (disposed || next.sessionId !== sessionId) return;
      setView(next);
    });
    const offError = window.banyan.on("session.error", (payload) => {
      if (!disposed && payload.sessionId === sessionId) setError(payload.message);
    });
    const offApproval = window.banyan.on("approval.pending", (payload) => {
      if (disposed || payload.sessionId !== sessionId) return;
      setApprovals(payload.requests);
    });

    void (async () => {
      try {
        // 会话级审批模式：与全局默认解耦
        const current = await window.banyan.invoke("approval.mode.get", { sessionId });
        if (!disposed) setMode(current.mode);

        await window.banyan.invoke("session.open", { sessionId, cwd });
        const snapshot = await window.banyan.invoke("session.view", { sessionId });
        if (!disposed && snapshot) setView(snapshot);
        // 重新打开时可能已有堆积的待审，需主动拉一次
        const pending = await window.banyan.invoke("approval.list", { sessionId });
        if (!disposed) setApprovals(pending);
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
      offApproval();
      // 卸载时释放该会话的 worker。运行中会被主进程拒绝，交给空闲回收兼顾；
      // 重新打开时靠 JSONL 重放恢复，代价仅是一次启动延迟。
      void window.banyan.invoke("session.close", { sessionId }).catch(() => undefined);
    };
  }, [sessionId, cwd]);

  // 新内容到达时自动滚到底（审批卡片出现时也要滚，否则用户看不到）
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [view?.messages.length, view?.streamingText, view?.thought, view?.runningTools, approvals.length]);

  // 是否已离开底部（决定是否显示「回到底部」）
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    setAwayFromBottom(node.scrollHeight - node.scrollTop - node.clientHeight > 80);
  }, []);
  const jumpToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, []);

  const resolveApproval = useCallback(
    async (
      toolCallId: string,
      input: {
        approved: boolean;
        remember?: "signature" | "tool";
        deny?: "signature" | "tool";
      },
    ) => {
      // 乐观移除：主进程随后会推全量待审覆盖
      setApprovals((list) => list.filter((item) => item.toolCallId !== toolCallId));
      try {
        await window.banyan.invoke("approval.resolve", {
          sessionId,
          toolCallId,
          approved: input.approved,
          remember: input.remember,
          deny: input.deny,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId],
  );

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

  const switchMode = useCallback(
    async (next: ApprovalMode) => {
      setError(null);
      try {
        const result = await window.banyan.invoke("approval.mode.set", { mode: next, sessionId });
        setMode(result.mode);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId],
  );

  const togglePanel = useCallback((target: SidePanel) => {
    setPanel((value) => (value === target ? "none" : target));
  }, []);

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
  const modelOptions = providers.flatMap((provider) =>
    provider.models.map((model) => ({ value: `${provider.id}/${model.id}`, label: model.name })),
  );
  const currentModelLabel =
    providers
      .find((provider) => provider.id === currentProviderId)
      ?.models.find((model) => model.id === currentModelId)?.name ??
    view?.model ??
    "—";

  // 上下文使用率：超过 70% 提示可压缩，超过 90% 转红
  const contextWindow =
    providers
      .find((item) => item.id === currentProviderId)
      ?.models.find((item) => item.id === currentModelId)?.contextWindow ?? 0;
  const contextUsed = view?.stats.contextUsed ?? 0;
  const contextRatio = contextWindow > 0 ? contextUsed / contextWindow : 0;
  const contextBarClass =
    contextRatio > 0.9 ? "bg-danger" : contextRatio > 0.7 ? "bg-warning" : "bg-accent-dim";

  // 心跳派生值
  const runStartedAt = runStartedAtRef.current;
  const elapsedSec = running && runStartedAt ? Math.floor((now - runStartedAt) / 1000) : 0;
  const elapsedLabel = `${String(Math.floor(elapsedSec / 60)).padStart(2, "0")}:${String(elapsedSec % 60).padStart(2, "0")}`;
  // 最后活动：取运行工具的最近 startedAt；无运行工具则用 now
  const lastActivity =
    view?.runningTools.reduce((latest, tool) => Math.max(latest, tool.startedAt), 0) ?? 0;
  const idleSec =
    running && lastActivity > 0 ? Math.max(0, Math.floor((now - lastActivity) / 1000)) : 0;
  // 「长时间无事件」：运行中但迟迟没有新事件，如实提示可中断
  const stale = running && lastActivity > 0 && idleSec > STALE_IDLE_SEC;

  // 输入框自适应增高
  const resizeInput = useCallback(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }, []);
  useEffect(() => {
    resizeInput();
  }, [input, resizeInput]);

  return (
    // 两列三行：左列「会话头 / 消息流 / 输入区」，右列是满高的跟随线。
    // 用网格而不是嵌套，确保输入区不会横向伸到跟随线下方（高保真的分栏模型）。
    <div className="grid h-full grid-cols-[1fr_280px] grid-rows-[auto_1fr_auto] overflow-hidden">
      <div className="col-start-1 row-start-1 flex shrink-0 items-center justify-between border-b border-line px-3.5 py-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[12px] text-text-primary">{cwd}</div>
        </div>
        <div className="flex items-center gap-2">
          {contextRatio > 0.7 && (
            <button
              type="button"
              onClick={() => void compact()}
              className="flex items-center gap-1.5 rounded-[6px] border border-warning/50 px-2 py-1 text-[11.5px] text-warning transition hover:bg-warning-soft"
              title="上下文已较满，压缩可释放空间"
            >
              <Shrink {...ICON.sm} />
              压缩上下文
            </button>
          )}
          {changes.length > 0 && (
            <PanelToggle
              active={panel === "changes"}
              icon={<FileDiff {...ICON.sm} />}
              label={`改动 ${changes.length}`}
              onClick={() => togglePanel("changes")}
            />
          )}
          <PanelToggle
            active={panel === "usage"}
            icon={<Coins {...ICON.sm} />}
            label="用量"
            title="查看本次会话的用量历史"
            onClick={() => togglePanel("usage")}
          />
          <PanelToggle
            active={panel === "tools"}
            icon={<Wrench {...ICON.sm} />}
            label="工具"
            title="查看本次会话的工具调用历史"
            onClick={() => togglePanel("tools")}
          />
        </div>
      </div>

      <div className="relative col-start-1 row-start-2 flex min-h-0 min-w-0">
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4">
          {opening && (
            <div className="flex items-center gap-2 text-[12.5px] text-text-muted">
              <Loader2 {...ICON.md} className="animate-spin" />
              正在启动会话进程…
            </div>
          )}

          {error && (
            <div className="mb-3 rounded-[8px] border border-danger/50 bg-danger-soft px-3 py-2 text-[12.5px] text-danger-fg">
              {error}
            </div>
          )}

          {view?.messages.length === 0 && !opening && !error && (
            <div className="flex h-full flex-col items-center justify-center gap-2.5">
              <div className="mb-1 text-[10px] uppercase tracking-[2px] text-text-muted">
                Banyan · 本地编码 Agent
              </div>
              <h2 className="m-0 text-[22px] font-semibold tracking-[-.3px] text-text-primary">
                今天要修哪个 bug？
              </h2>
              <p className="m-0 text-[12.5px] text-text-secondary">
                描述你想做的事，Banyan 会先给你一份计划。
              </p>
              <div className="mt-3 flex max-w-[560px] flex-wrap justify-center gap-2">
                {["修复登录超时", "给 utils 补单测", "把日志换成 pino", "解释这段代码"].map(
                  (suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setInput(suggestion)}
                      className="rounded-[6px] border border-line px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:border-line-strong hover:text-text-primary"
                    >
                      {suggestion}
                    </button>
                  ),
                )}
              </div>
            </div>
          )}

          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {view?.messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                resultMap={resultMap}
                changes={changes}
                onHoverFile={setHoveredFile}
              />
            ))}

            {/* 思考轨：正在推理的流式文本，弱化呈现 */}
            {view?.thought && <ThinkingRail text={view.thought} />}

            {view?.streamingText && (
              <Bubble role="assistant" streaming>
                {view.streamingText}
              </Bubble>
            )}

            {view?.runningTools.map((tool) => (
              <ToolCard
                key={tool.id}
                name={tool.name}
                args="{}"
                running
                result={{ output: tool.output, isError: false }}
              />
            ))}

            {/* 审批卡片放在消息流末尾：lane 正阻塞在这里，不处理就不会往下走 */}
            {approvals.map((request) => (
              <ApprovalCard
                key={request.toolCallId}
                request={request}
                changes={changes}
                onResolve={(input) => void resolveApproval(request.toolCallId, input)}
              />
            ))}
          </div>

          {awayFromBottom && (
            <button
              type="button"
              onClick={jumpToBottom}
              className="absolute bottom-4 right-4 flex items-center gap-1.5 rounded-[6px] border border-line bg-surface-overlay px-2.5 py-1 text-[11.5px] text-text-secondary shadow-lg transition hover:border-line-strong hover:text-text-primary"
            >
              <ArrowDown {...ICON.sm} />
              回到底部
            </button>
          )}
        </div>

        {panel === "changes" && (
          <ChangesPanel changes={changes} onClose={() => setPanel("none")} />
        )}
        {panel === "usage" && <UsagePanel sessionId={sessionId} onClose={() => setPanel("none")} />}
        {panel === "tools" && <ToolsPanel sessionId={sessionId} onClose={() => setPanel("none")} />}
      </div>

      <div className="col-start-1 row-start-3 min-w-0 shrink-0 border-t border-line p-3">
        <div className="mx-auto max-w-3xl">
          {/* 状态栏（Live Bar）：模型 · 模式 · 上下文 · 成本 · 心跳 */}
          <div className="mb-2 flex flex-wrap items-center gap-2.5 text-[11px] text-text-muted">
            <Picker
              title="模型"
              value={`${currentProviderId}/${currentModelId}`}
              label={currentModelLabel}
              options={modelOptions}
              onChange={(value) => void switchModel(value)}
            />
            <Picker
              title="会话级模式"
              value={mode}
              label={mode === "approval" ? "审批模式" : "全权执行模式"}
              options={MODE_OPTIONS}
              onChange={(value) => void switchMode(value as ApprovalMode)}
            />

            <span className="h-[13px] w-px bg-line-strong" />

            {contextWindow > 0 && (
              <span className="flex items-center gap-1.5" title="上下文占用">
                <span className="h-[5px] w-[76px] overflow-hidden rounded-full bg-line">
                  <span
                    className={cn("block h-full rounded-full", contextBarClass)}
                    style={{ width: `${Math.min(100, contextRatio * 100)}%` }}
                  />
                </span>
                <span className="font-mono">
                  {(contextRatio * 100).toFixed(0)}% · {contextUsed.toLocaleString()} /{" "}
                  {contextWindow.toLocaleString()}
                </span>
              </span>
            )}

            {view && view.stats.costUsd > 0 && (
              <span className="font-mono">${view.stats.costUsd.toFixed(4)}</span>
            )}

            <span className="h-[13px] w-px bg-line-strong" />

            <span className="flex items-center gap-2.5">
              {running ? (
                <>
                  <span className="flex items-center gap-1.5">
                    <span className={cn("live-dot", stale && "stale-dot")} />
                    <span>运行中</span>
                    <span className="font-mono">{elapsedLabel}</span>
                  </span>
                  {lastActivity > 0 && (
                    <span className={cn("font-mono", stale && "text-warning")}>
                      最后活动 {idleSec}s 前
                    </span>
                  )}
                  {stale && <span className="text-warning">似乎卡住了，可中断</span>}
                </>
              ) : (
                <span>空闲</span>
              )}
            </span>
          </div>

          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={1}
              placeholder={
                running
                  ? "运行中：Enter 发送插话，按钮停止"
                  : "空闲：输入消息，Enter 发送 · Shift+Enter 换行"
              }
              className="max-h-[180px] flex-1 resize-none rounded-[12px] border border-line bg-surface-input px-3.5 py-2.5 text-[13px] text-text-primary outline-none transition placeholder:text-text-muted focus:border-accent-dim focus:ring-[3px] focus:ring-accent-soft"
            />
            {running ? (
              <button
                type="button"
                onClick={() => void abort()}
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-[12px] bg-danger px-3 text-[13px] font-semibold text-white transition hover:opacity-90"
              >
                <Square {...ICON.sm} />
                停止
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!input.trim()}
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-[12px] bg-accent px-3 text-[13px] font-semibold text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                style={{ minWidth: 76 }}
              >
                <Send {...ICON.sm} />
                发送
              </button>
            )}
          </div>
          {view && view.queuedCount > 0 && (
            <p className="mt-1.5 text-[11px] text-text-muted">
              队列中还有 {view.queuedCount} 条待处理
            </p>
          )}
        </div>
      </div>

      {/* 右列：满高跟随线，跨三行，所以输入区不会压到它下面 */}
      <div className="col-start-2 row-span-3 row-start-1 flex min-h-0">
        <FollowPanel
          view={view}
          highlightPath={hoveredFile}
          onOpenChanges={() => setPanel("changes")}
        />
      </div>
    </div>
  );
}

/** 轻量下拉选择器：对齐高保真 .picker 的视觉与手感 */
function Picker({
  title,
  value,
  label,
  options,
  onChange,
}: {
  title: string;
  value: string;
  label: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        className={cn(
          "flex items-center gap-1.5 rounded-[6px] border border-line bg-surface px-2 py-0.5 text-[11.5px] text-text-secondary transition",
          "hover:border-line-strong hover:text-text-primary",
        )}
      >
        <span className="max-w-[180px] truncate">{label}</span>
        <ChevronDown {...ICON.xs} className="shrink-0 text-text-muted" />
      </button>
      {open && options.length > 0 && (
        <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[160px] rounded-[6px] border border-line bg-surface-overlay py-1 shadow-lg">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={cn(
                "block w-full truncate px-2.5 py-1 text-left text-[11.5px] transition hover:bg-surface-raised",
                option.value === value ? "text-text-primary" : "text-text-secondary",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 头部右侧的面板切换按钮 */
function PanelToggle({
  active,
  icon,
  label,
  title,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-1.5 rounded-[6px] border px-2 py-1 text-[11.5px] transition",
        active
          ? "border-accent bg-accent-soft text-text-primary"
          : "border-line text-text-secondary hover:text-text-primary",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
