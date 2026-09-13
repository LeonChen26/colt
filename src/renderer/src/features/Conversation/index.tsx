/**
 * 对话面板：消息流 + 流式文本 + 工具实时输出 + 状态栏（Live Bar）+ 右侧面板编排。
 * 具体的改动/用量/工具/分支面板已拆到 panels/ 与 BranchTree。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Coins,
  FileDiff,
  Folder,
  GitBranch,
  ImagePlus,
  Loader2,
  ShieldCheck,
  Shrink,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ConversationView } from "@shared/worker-protocol";
import type { ApprovalMode, ApprovalRequest, BrowserViewState, GitStatus, ProviderConfig } from "@shared/protocol";
import { splitModelRef } from "@shared/model-ref";
import { cn } from "../../lib/utils";
import { Markdown } from "../../components/Markdown";
import { AssistantRow, MessageBubble, ThinkingRail, ToolCard } from "./MessageList";
import { ChangesPanel } from "./panels/ChangesPanel";
import { UsagePanel } from "./panels/UsagePanel";
import { ToolsPanel } from "./panels/ToolsPanel";
import { RulesPanel } from "./panels/RulesPanel";
import { ApprovalCard } from "./ApprovalCard";
import { DOCK_SUGGEST_WIDTH, WorkspaceDock, type DockView } from "./WorkspaceDock";
import type { ReactNode } from "react";

/** 右侧面板多选一 */
type SidePanel = "none" | "changes" | "usage" | "tools" | "rules";

/** 「长时间无事件」判定阈值：超过该秒数视为可能卡住 */
const STALE_IDLE_SEC = 30;

/** 待发送的图片附件；data 为不含 data URI 前缀的 base64（pi 的 ImageContent 约定） */
interface Attachment {
  name: string;
  mimeType: string;
  data: string;
}

/**
 * 单张上限与张数上限。图片以 base64 走 IPC 的 postMessage，
 * 1920×1200 的 PNG 约 350KB、base64 后约 470KB，不设限会明显拖慢主进程。
 */
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

const MODE_OPTIONS: { value: ApprovalMode; label: string; hint: string }[] = [
  { value: "approval", label: "审批模式", hint: "只读命令放行，其余逐条确认" },
  { value: "auto", label: "自动审批模式", hint: "普通操作由大模型判定，仅高风险确认" },
  { value: "full-access", label: "全权执行模式", hint: "一律放行，不做拦截" },
];

const MODE_LABEL: Record<ApprovalMode, string> = {
  approval: "审批模式",
  auto: "自动审批模式",
  "full-access": "全权执行模式",
};

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [panel, setPanel] = useState<SidePanel>("none");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [mode, setMode] = useState<ApprovalMode>("approval");
  /** 跟随线联动：hover 工具卡片时高亮它碰的文件 */
  const [hoveredFile, setHoveredFile] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  /** 右栏工作区当前页签（默认「正在处理」，规则 ⑦-E） */
  const [dockTab, setDockTab] = useState<DockView>("follow");
  /** 内嵌浏览器视图状态（loaded 为 false 表示尚未创建 WebContents） */
  const [browser, setBrowser] = useState<BrowserViewState | null>(null);
  /** 右栏可用宽度：用于把「建议宽度」钳制到不挤压中栏（⑦-B 中栏下限 360px） */
  const [dockSpace, setDockSpace] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 工作区根节点：量它才能知道右栏能宽到哪 */
  const rootRef = useRef<HTMLDivElement>(null);
  /** 是否已自动切过一次浏览器页签（规则 ⑦-F 只在「首次使用」切） */
  const browserAutoSwitchedRef = useRef(false);

  /**
   * 右栏宽度：视图切换只给**建议值**（⑦-B），并按可用空间钳制，
   * 保证中栏不被挤到 360px 以下（那会让会话流无法阅读）。
   */
  const dockWidth = useMemo(() => {
    const suggestion = DOCK_SUGGEST_WIDTH[dockTab];
    if (dockSpace <= 0) return suggestion;
    return Math.max(220, Math.min(suggestion, dockSpace - 360));
  }, [dockTab, dockSpace]);

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

  // 会话头展示工作目录的 git 分支（规则 ②-B）；非仓库或读取失败则隐藏。
  // 用户可能在应用外部切换分支，故除 cwd 变化外，窗口重新获焦时也刷新一次。
  useEffect(() => {
    let disposed = false;
    const refresh = (): void => {
      void window.banyan
        .invoke("git.status", { cwd })
        .then((next) => {
          if (!disposed) setGit(next);
        })
        .catch(() => {
          if (!disposed) setGit(null);
        });
    };
    setGit(null);
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [cwd]);

  // 内嵌浏览器：订阅视图状态；agent 首次使用浏览器时自动切到「浏览器」页签（规则 ⑦-F）。
  // ⑦-C（视野跳跃为零）在此场景优先于 ⑦-D（不抢焦）——新现场的开始必须被看到。
  useEffect(() => {
    let disposed = false;
    browserAutoSwitchedRef.current = false;
    setBrowser(null);
    setDockTab("follow");

    const apply = (next: BrowserViewState): void => {
      if (disposed) return;
      setBrowser(next);
      if (next.loaded && !browserAutoSwitchedRef.current) {
        browserAutoSwitchedRef.current = true;
        setDockTab("browser");
      }
      if (!next.loaded) browserAutoSwitchedRef.current = false;
    };

    // 挂载时对齐：本组件卸载期间（切会话）该会话可能已经加载过浏览器
    void window.banyan
      .invoke("browser.state.get", { sessionId })
      .then(apply)
      .catch(() => undefined);

    const off = window.banyan.on("browser.state", (state) => {
      if (state.sessionId === sessionId) apply(state);
    });
    return () => {
      disposed = true;
      off();
    };
  }, [sessionId]);

  // 量工作区可用宽度，用于把右栏「建议宽度」钳制到不挤压中栏
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (node === null) return;
    const measure = (): void => setDockSpace(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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

  /** 把 File（粘贴 / 拖拽 / 选择）读成 base64 附件；非图片与超限的直接拒绝并说明原因 */
  const addFiles = useCallback(async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    setError(null);
    const accepted: Attachment[] = [];
    for (const file of images.slice(0, MAX_ATTACHMENTS)) {
      const label = file.name || "剪贴板图片";
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`图片过大：${label}（${(file.size / 1024 / 1024).toFixed(1)}MB，上限 4MB）`);
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(`读取图片失败：${label}`));
        reader.readAsDataURL(file);
      });
      // 去掉 "data:image/png;base64," 前缀，只保留 base64 主体
      const comma = dataUrl.indexOf(",");
      accepted.push({
        name: label,
        mimeType: file.type || "image/png",
        data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
      });
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS));
    }
  }, []);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    // 纯文本模型下适配器会按 model.input 静默丢弃图片。这里直接拦下并说明，
    // 避免用户看到"图发出去了但 AI 毫无反应"。
    if (attachments.length > 0 && view && !view.imageInput) {
      setError(
        `当前模型（${view.model}）不支持图片输入，图片会被丢弃。请先切换到支持视觉的模型。`,
      );
      return;
    }
    const images = attachments.map((item) => ({ data: item.data, mimeType: item.mimeType }));
    setInput("");
    setAttachments([]);
    setError(null);
    try {
      await window.banyan.invoke("session.prompt", {
        sessionId,
        text,
        images: images.length > 0 ? images : undefined,
        // 主进程凭 cwd 在 worker 被空闲回收后自动重建会话进程
        cwd,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [input, attachments, view, sessionId, cwd]);

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
      const { provider: providerId, model: modelId } = splitModelRef(value);
      if (!providerId || !modelId) return;
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
  const { provider: currentProviderId, model: currentModelId } = splitModelRef(view?.model ?? "");
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
    // 两列三行：左列「会话头 / 消息流 / 输入区」，右列是满高的工作区（页签容器）。
    // 用网格而不是嵌套，确保输入区不会横向伸到工作区下方（高保真的分栏模型）。
    <div
      ref={rootRef}
      className="grid h-full grid-rows-[auto_1fr_auto] overflow-hidden"
      style={{ gridTemplateColumns: `minmax(0, 1fr) ${dockWidth}px` }}
    >
      <div className="conv-head col-start-1 row-start-1 flex shrink-0 items-center justify-between gap-2 border-b border-line px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="ch-ctx flex min-w-0 items-center gap-1.5 text-[11.5px] text-text-muted"
            title="工作目录"
          >
            <Folder {...ICON.xs} className="shrink-0" />
            <span className="c truncate font-mono text-text-secondary">{cwd}</span>
          </span>
          {git?.isRepo && (git.branch || git.detached) && (
            <button
              type="button"
              title={git.detached ? "游离 HEAD：当前不在任何分支上" : "当前 git 分支"}
              className={cn(
                "ch-ctx branch flex h-[22px] shrink-0 items-center gap-1.5 rounded-[6px] border px-1.5 text-[11.5px] transition",
                git.detached
                  ? "border-warning/50 text-warning"
                  : "border-line text-text-muted hover:border-line-strong hover:text-text-primary",
              )}
            >
              <GitBranch {...ICON.xs} className="shrink-0" />
              <span
                className={cn(
                  "c font-mono",
                  git.detached ? "text-warning" : "text-text-secondary",
                )}
              >
                {git.detached ? "游离 HEAD" : git.branch}
              </span>
              {!git.detached && <ChevronDown {...ICON.xs} className="shrink-0" />}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
          <PanelToggle
            active={panel === "rules"}
            icon={<ShieldCheck {...ICON.sm} />}
            label="规则"
            title="查看并管理本次会话记住的审批规则"
            onClick={() => togglePanel("rules")}
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

            {/* 流式中的助手内容：思考轨 + 流式文本 + 运行中工具，
                与完成态 MessageBubble 共用 AssistantRow 骨架，保证左边缘一致 */}
            {(view?.thought || view?.streamingText || (view?.runningTools.length ?? 0) > 0) && (
              <AssistantRow>
                {view?.thought && <ThinkingRail text={view.thought} />}
                {view?.streamingText && (
                  <div className="relative">
                    <Markdown>{view.streamingText}</Markdown>
                    <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle" />
                  </div>
                )}
                {view?.runningTools.map((tool) => (
                  <ToolCard
                    key={tool.id}
                    name={tool.name}
                    args={tool.args}
                    running
                    result={{ output: tool.output, isError: false }}
                  />
                ))}
              </AssistantRow>
            )}

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
        {panel === "rules" && <RulesPanel sessionId={sessionId} onClose={() => setPanel("none")} />}
      </div>

      <div className="conv-center col-start-1 row-start-3 min-w-0 shrink-0">
        <div className="mx-auto max-w-[796px] px-[18px] pb-3.5">
          {/* 输入卡片：对齐高保真 .cbox（边框圆角卡片，内含输入区与工具行） */}
          <div
            className="rounded-[12px] border border-line bg-surface-raised px-3 pb-2 pt-2.5 transition focus-within:border-line-strong"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              const files = [...e.dataTransfer.files];
              if (files.length === 0) return;
              e.preventDefault();
              void addFiles(files);
            }}
          >
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {attachments.map((item, index) => (
                  <span
                    key={`${item.name}-${index}`}
                    className="inline-flex items-center gap-2 rounded-[8px] border border-line bg-surface-overlay py-1 pl-1 pr-2"
                  >
                    <img
                      src={`data:${item.mimeType};base64,${item.data}`}
                      alt={item.name}
                      className="h-10 w-10 rounded-[5px] border border-line object-cover"
                    />
                    <span className="max-w-[140px] truncate text-[11px] text-text-secondary">
                      {item.name}
                    </span>
                    <button
                      type="button"
                      aria-label="移除图片"
                      onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                      className="text-text-muted transition hover:text-danger-fg"
                    >
                      <X {...ICON.xs} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachments.length > 0 && view && !view.imageInput && (
              <p className="mb-1.5 text-[11px] text-warning">
                当前模型不支持图片输入，发送前请切换到支持视觉的模型（如
                deepseek-v4-flash-vision-exp）
              </p>
            )}

            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = [...e.clipboardData.items]
                  .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => file !== null);
                if (files.length === 0) return;
                e.preventDefault();
                void addFiles(files);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={1}
              placeholder={
                running
                  ? "运行中：Enter 发送插话，按钮停止"
                  : "帮你编写代码、调试 Bug、优化性能等开发工作，交付生产级代码产物。"
              }
              className="max-h-[180px] w-full resize-none bg-transparent px-0.5 py-1 text-[12.5px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted"
            />

            {/* 工具行：附件 / 访问模式（左），模型 / 发送（右） */}
            <div className="comp-tools mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <label
                title="添加图片（也可直接粘贴或拖入输入框）"
                className="flex h-7 shrink-0 cursor-pointer items-center rounded-[6px] px-2 text-text-secondary transition hover:bg-surface-overlay hover:text-text-primary"
              >
                <ImagePlus {...ICON.sm} />
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void addFiles([...(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
              </label>

              <Picker
                title="访问模式"
                value={mode}
                label={MODE_LABEL[mode]}
                options={MODE_OPTIONS}
                icon={<ShieldCheck {...ICON.sm} className="text-warning" />}
                onChange={(value) => void switchMode(value as ApprovalMode)}
              />

              <span className="cpush flex-1" />

              <div className="cright flex shrink-0 items-center gap-2">
                <Picker
                  title="当前模型"
                  value={`${currentProviderId}/${currentModelId}`}
                  label={currentModelLabel}
                  options={modelOptions}
                  plain
                  className="model"
                  onChange={(value) => void switchModel(value)}
                />
                {running ? (
                  <button
                    type="button"
                    onClick={() => void abort()}
                    title="停止"
                    className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-danger text-white transition hover:opacity-90"
                  >
                    <Square {...ICON.sm} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={!input.trim() && attachments.length === 0}
                    title="发送"
                    className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowUp {...ICON.sm} />
                  </button>
                )}
              </div>
            </div>
          </div>

          {view && view.queuedCount > 0 && (
            <p className="mt-1.5 text-[11px] text-text-muted">
              队列中还有 {view.queuedCount} 条待处理
            </p>
          )}

          {/* 现场状态栏（Live Bar）：置于输入框下方，只留运行态观测（⑥-A 只读区不放操作） */}
          <div
            className={cn(
              "flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5 pt-[7px] text-[11.5px] text-text-secondary",
              stale && "stale",
            )}
          >
            {contextWindow > 0 && (
              <span className="flex items-center gap-1.5" title="上下文占用">
                <span className="lb-opt text-text-muted">上下文</span>
                <span className="lb-track h-[5px] overflow-hidden rounded-full bg-surface-overlay">
                  <span
                    className={cn("block h-full rounded-full", contextBarClass)}
                    style={{ width: `${Math.min(100, contextRatio * 100)}%` }}
                  />
                </span>
                <span className="font-mono">
                  {(contextRatio * 100).toFixed(0)}% · {formatTokens(contextUsed)} /{" "}
                  {formatTokens(contextWindow)}
                </span>
              </span>
            )}

            {contextWindow > 0 && <span className="lb-opt h-[12px] w-px bg-line" />}

            {view && view.stats.costUsd > 0 && (
              <span className="lb-opt font-mono" title="本次会话累计成本">
                ${view.stats.costUsd.toFixed(4)}
              </span>
            )}

            <span className="h-[12px] w-px bg-line" />

            <span className="flex items-center gap-2.5">
              {running ? (
                <>
                  <span className="flex items-center gap-1.5">
                    <span className={cn("live-dot", stale && "stale-dot")} />
                    <span>运行中</span>
                    <span className="font-mono">{elapsedLabel}</span>
                  </span>
                  {lastActivity > 0 && (
                    <span className={cn("lb-idle font-mono", stale && "text-warning")}>
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
        </div>
      </div>

      {/* 右列：工作区（页签切换「正在处理」/「浏览器」），跨三行，所以输入区不会压到它下面 */}
      <div className="col-start-2 row-span-3 row-start-1 flex min-h-0 min-w-0">
        <WorkspaceDock
          sessionId={sessionId}
          view={view}
          highlightPath={hoveredFile}
          onOpenChanges={() => setPanel("changes")}
          browser={browser}
          tab={dockTab}
          onTab={setDockTab}
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
  icon,
  plain,
  className,
  onChange,
}: {
  title: string;
  value: string;
  label: string;
  options: { value: string; label: string; hint?: string }[];
  icon?: ReactNode;
  plain?: boolean;
  className?: string;
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
          "cbtn flex h-7 items-center gap-1.5 rounded-[6px] border px-2 text-[12px] text-text-secondary transition",
          plain
            ? "border-transparent hover:border-transparent hover:bg-surface-overlay hover:text-text-primary"
            : "border-line hover:border-line-strong hover:text-text-primary",
          className,
        )}
      >
        {icon}
        <span className="lbl max-w-[180px] truncate">{label}</span>
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
                "block w-full px-2.5 py-1 text-left text-[11.5px] transition hover:bg-surface-raised",
                option.value === value ? "text-text-primary" : "text-text-secondary",
              )}
            >
              <span className="block truncate">{option.label}</span>
              {option.hint && (
                <span className="mt-0.5 block truncate text-[10.5px] text-text-muted">
                  {option.hint}
                </span>
              )}
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
