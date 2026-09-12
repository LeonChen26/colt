/**
 * 对话面板：消息流 + 流式文本 + 工具实时输出 + 右侧面板编排。
 * 具体的改动/用量/工具/分支面板已拆到 panels/ 与 BranchTree。
 * 作者：陕耀云栈WorkMate
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Coins,
  FileDiff,
  GitBranch,
  Loader2,
  Send,
  Shrink,
  Square,
  Wrench,
} from "lucide-react";
import type { ConversationView } from "@shared/worker-protocol";
import type { ProviderConfig } from "@shared/protocol";
import { TerminalOutput } from "../../components/TerminalOutput";
import { BranchTree } from "../BranchTree";
import { cn } from "../../lib/utils";
import { MessageBubble, Bubble } from "./MessageList";
import { ChangesPanel } from "./panels/ChangesPanel";
import { UsagePanel } from "./panels/UsagePanel";
import { ToolsPanel } from "./panels/ToolsPanel";
import type { ReactNode } from "react";

/** 右侧面板多选一 */
type SidePanel = "none" | "changes" | "branches" | "usage" | "tools";

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
  const modelGroups = providers
    .map((provider) => ({ provider, models: provider.models }))
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
          <PanelToggle
            active={panel === "branches"}
            icon={<GitBranch size={12} />}
            label="分支"
            onClick={() => togglePanel("branches")}
          />
          {changes.length > 0 && (
            <PanelToggle
              active={panel === "changes"}
              icon={<FileDiff size={12} />}
              label={`改动 ${changes.length}`}
              onClick={() => togglePanel("changes")}
            />
          )}
          <PanelToggle
            active={panel === "usage"}
            icon={<Coins size={12} />}
            label="用量"
            title="查看本次会话的用量历史"
            onClick={() => togglePanel("usage")}
          />
          <PanelToggle
            active={panel === "tools"}
            icon={<Wrench size={12} />}
            label="工具"
            title="查看本次会话的工具调用历史"
            onClick={() => togglePanel("tools")}
          />
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
          <ChangesPanel changes={changes} onClose={() => setPanel("none")} />
        )}
        {panel === "branches" && <BranchTree sessionId={sessionId} />}
        {panel === "usage" && <UsagePanel sessionId={sessionId} onClose={() => setPanel("none")} />}
        {panel === "tools" && <ToolsPanel sessionId={sessionId} onClose={() => setPanel("none")} />}
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
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition",
        active
          ? "border-[--color-accent] text-[--color-accent]"
          : "border-[--color-border-subtle] text-[--color-text-secondary] hover:text-[--color-text-primary]",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
