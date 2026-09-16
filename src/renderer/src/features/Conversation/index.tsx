/**
 * 对话面板：消息流 + 流式文本 + 工具实时输出 + 状态栏（Live Bar）+ 右侧面板编排。
 * 具体的改动 / 统计 / 工具 / 分支面板已拆到 panels/ 与 BranchTree。
 * 会话头（②）的入口按 ⑦-H 收敛为**两个**（统计 / 规则）：「改动」由「正在处理」底部的总账接管（⑦-G）、
 * 「工具」的聚合与明细都并入「统计」；两者仍可从 ⑦ 的「+」菜单打开（删的是入口，不是能力）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChartColumn,
  ChevronDown,
  Folder,
  GitBranch,
  ImagePlus,
  Loader2,
  ShieldCheck,
  Shrink,
  Square,
  X,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ConversationView } from "@shared/worker-protocol";
import type { ApprovalMode, ApprovalRequest, BrowserNavAction, BrowserViewState, GitStatus, ProviderConfig } from "@shared/protocol";
import { displayModelRef, resolveSessionModel, splitModelRef } from "@shared/model-ref";
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  isThinkingLevel,
  type ThinkingLevel,
} from "@shared/thinking-level";
import { cn } from "../../lib/utils";
import { runStateOf } from "../../lib/format";
import { parseSlashCommand } from "../../lib/slash-command";
import { Markdown } from "../../components/Markdown";
import { AssistantRow, MessageBubble, ThinkingRail, ToolCard } from "./MessageList";
import { ApprovalCard } from "./ApprovalCard";
import {
  createDockInstance,
  defaultDockInstances,
  DOCK_COLLAPSED_WIDTH,
  DOCK_DEFAULT_KIND,
  DOCK_DEFAULT_WIDTH,
  isDockClosable,
  WorkspaceDock,
  type DockInstance,
  type DockKind,
} from "./WorkspaceDock";
import type { ReactNode } from "react";

/** 「长时间无事件」判定阈值：超过该秒数视为可能卡住 */
const STALE_IDLE_SEC = 30;

/** 右栏宽度下限（规则 ⑦-B）：允许拖到接近折叠条，「正在处理」这类窄内容也够用 */
const MIN_DOCK_WIDTH = 220;
/** 中栏可读下限：右栏最宽只能到「可用宽度 − 360」，否则会话流无法阅读（规则 ⑦-B） */
const MIN_CENTER_WIDTH = 360;

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
  { value: "full-access", label: "全权执行模式", hint: "本会话内一律放行；已弹出的卡片仍需逐条确认" },
];

const MODE_LABEL: Record<ApprovalMode, string> = {
  approval: "审批模式",
  auto: "自动审批模式",
  "full-access": "全权执行模式",
};

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) {
    // 999.95k 起 toFixed(1) 会四舍五入进位成「1000.0k」，直接升档显示
    const k = value / 1_000;
    return k >= 999.95 ? "1.0M" : `${k.toFixed(1)}k`;
  }
  return String(value);
}

/** 思考等级的下拉文案。等级由内核定义（见 shared/thinking-level.ts），这里只负责措辞 */
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "不思考",
  low: "低",
  medium: "中",
  high: "高",
};

/** 「不思考」要写明风险：「始终思考」的模型会直接拒绝它，连带压缩与自动放行一起失败 */
const THINKING_LEVEL_HINTS: Record<ThinkingLevel, string> = {
  off: "最快，但「始终思考」的模型不支持，会让压缩与自动放行失败",
  low: "少量思考",
  medium: "中等思考",
  high: "最多思考（默认）",
};

export function Conversation({
  sessionId,
  cwd,
  sessionModelRef,
  sessionThinkingLevel,
  providers,
  onModelSelected,
  onThinkingLevelSelected,
}: {
  sessionId: string;
  cwd: string;
  /** 会话上次选定的模型（"providerId/modelId"，未选过为 null），用于判断本次能否自动打开 */
  sessionModelRef: string | null;
  /** 会话上次选定的思考等级（未选过为 null，按默认值回显） */
  sessionThinkingLevel: ThinkingLevel | null;
  providers: ProviderConfig[];
  /**
   * 模型选择已落库。父组件需据此刷新会话的 model_ref——否则切走再回来（重挂载）
   * 会退回旧值，用户又看到「选了没生效」。
   */
  onModelSelected?: (modelRef: string) => void;
  /** 思考等级已落库，同 onModelSelected：父组件要刷新缓存，否则重挂载会退回旧值 */
  onThinkingLevelSelected?: (level: ThinkingLevel) => void;
}): React.JSX.Element {
  const [view, setView] = useState<ConversationView | null>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * 「还差一步就能用」的提示（黄），与真错误（红）分开：
   * 选了尚未配密钥的服务、或没配密钥就打不开会话，都不是失败，只是需要用户去填密钥。
   * 全塞进红色错误框，会让正常的第一步操作看上去像出了事故。
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 压缩完成的瞬时提示（绿色，几秒后自动消失）。
   * 与黄条语义不同：黄条是「还差一步」的待办，会一直挂着；成功提示挂久了反而像没消失的异常。
   */
  const [compactNotice, setCompactNotice] = useState<string | null>(null);
  /**
   * 附件被拒/被跳过的说明，**贴在输入卡片里**而不是顶部的消息区。
   *
   * 用户在输入框旁边拖入文件，反馈就必须出现在拖入的地方：
   * 顶部那条 error 在消息滚到底时根本不在视野内，等于没说。
   */
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [mode, setMode] = useState<ApprovalMode>("auto");
  /** 跟随线联动：hover 工具卡片时高亮它碰的文件 */
  const [hoveredFile, setHoveredFile] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  /** 右栏工作区**已打开**的视图实例（⑦-B：页签可以很多；启动时挂上既有两个） */
  const [dockInstances, setDockInstances] = useState<DockInstance[]>(defaultDockInstances);
  /** 当前激活实例的 id（默认落在「正在处理」，规则 ⑦-E） */
  const [dockActiveId, setDockActiveId] = useState<string>(DOCK_DEFAULT_KIND);
  /** 「要看某个文件」的请求（A3-2）；null = 尚未点过；seq 用于「同一文件再点一次也重读」。
   *  ⑦-G 之后它不再切「文件」页签，而是让「正在处理」落到下钻的**内容层**。 */
  const [dockFile, setDockFile] = useState<{ path: string; seq: number } | null>(null);
  /** 内嵌浏览器视图状态（loaded 为 false 表示尚未创建 WebContents） */
  const [browser, setBrowser] = useState<BrowserViewState | null>(null);
  /** 右栏可用宽度：用于把「建议宽度」钳制到不挤压中栏（⑦-B 中栏下限 360px） */
  const [dockSpace, setDockSpace] = useState(0);
  /** 用户拖拽后的右栏宽度；null = 尚未拖过（此时才用视图建议值，规则 ⑦-B） */
  const [dockWidthUser, setDockWidthUser] = useState<number | null>(null);
  /** 是否正在拖拽右栏把手（用于驱动光标与选中抑制） */
  const [dockDragging, setDockDragging] = useState(false);
  /** 右栏是否折叠为 44px 图标条（规则 ⑦-E：可折叠，但不提供完全关闭） */
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 工作区根节点：量它才能知道右栏能宽到哪 */
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * 拖拽起点。startX 是按下时的指针横坐标，startWidth 是按下时的**实际**右栏宽度。
   * 两者刻意分开存——别把「当前宽度」和「位移」揉进一个数里（AGENTS.md 3.3 的翻车点）。
   */
  const dockDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  /** 当前生效的右栏宽度，供拖拽开始时取起点，避免闭包读到旧值 */
  const dockWidthRef = useRef(0);
  /** 是否已自动切过一次浏览器页签（规则 ⑦-F 只在「首次使用」切） */
  const browserAutoSwitchedRef = useRef(false);
  /**
   * 工具卡的展开状态，以工具调用 id 为键。
   * 同一个工具调用在「流式区」与「完成态消息」是两个树位置——完成的瞬间旧实例卸载、
   * 新实例挂载，实例本地的 useState 会把用户手动展开的状态丢掉（正在读实时输出被收起）。
   * 展开状态挂在这个组件外的 Map 上，两个渲染点共用，切换时状态跟着 id 走。
   */
  const toolOpenStateRef = useRef(new Map<string, boolean>());

  /** 当前激活实例的 kind —— 决定渲染哪个视图、以及用哪个建议宽度 */
  const dockActiveKind =
    dockInstances.find((item) => item.id === dockActiveId)?.kind ?? DOCK_DEFAULT_KIND;

  /** 激活某个**已打开**的实例 */
  const activateDockInstance = useCallback((id: string) => {
    setDockActiveId(id);
  }, []);

  /**
   * 打开某类视图并激活它（⑦-F 用：agent 动到哪个视图的对象就切过去）。
   * 单例模型下 `createDockInstance` 的 id 取 kind，故重复调用**不会重复建页签**。
   */
  const ensureDockInstance = useCallback((kind: DockKind) => {
    const instance = createDockInstance(kind);
    setDockInstances((list) =>
      list.some((item) => item.id === instance.id) ? list : [...list, instance],
    );
    setDockActiveId(instance.id);
  }, []);

  /**
   * 关闭某个页签（A3-3）。
   *
   * ⑦-E 的「默认视图不可关闭」是**规则**，所以守卫就放在这里，而不是只靠「不渲染关闭按钮」——
   * 规则不该依赖调用方自觉。关掉当前激活项时要把激活位交还给默认视图，
   * 否则右栏会指向一个已不存在的实例。
   *
   * ⑦-G 之后不再需要「关闭即清空文件目标」：那个目标已经不在页签上，
   * 而是「正在处理」的下钻状态（随会话切换自愈，见 `WorkspaceDock`）。
   */
  const closeDockInstance = useCallback(
    (id: string) => {
      const target = dockInstances.find((item) => item.id === id);
      if (target === undefined || !isDockClosable(target.kind)) return;
      setDockInstances((list) => list.filter((item) => item.id !== id));
      setDockActiveId((active) => (active === id ? DOCK_DEFAULT_KIND : active));
    },
    [dockInstances],
  );

  /**
   * 打开某类视图页签并展开右栏（A3-5）：② 会话头的「统计 / 规则」（⑦-H 后只剩这两个）
   * 以及 ⑦ 的「+」菜单都走这里。
   *
   * 必须**同时展开**右栏：只切页签而右栏还收着，等于点了没反应（同 ⑦-F）。
   */
  const openDockKind = useCallback(
    (kind: DockKind) => {
      ensureDockInstance(kind);
      setDockCollapsed(false);
    },
    [ensureDockInstance],
  );

  /**
   * 打开文件预览（A3-2）：点「正在处理」里的文件路径走这里。
   *
   * `seq` 每次自增，保证**同一路径再点一次也会重读**——agent 可能刚改过它，
   * 只比较路径的话第二次点击不会有任何反应（React 认为状态没变）。
   *
   * ⑦-G：不再打开「文件」页签，而是切回**「正在处理」**并由容器把下钻落到内容层——
   * 文件与「本次改动」本就是同一个东西的不同粒度，不该分成两个并列页签让用户选。
   */
  const openFile = useCallback(
    (path: string) => {
      setDockFile((prev) => ({ path, seq: (prev?.seq ?? 0) + 1 }));
      openDockKind(DOCK_DEFAULT_KIND);
    },
    [openDockKind],
  );

  /**
   * 用户操作内嵌浏览器（B1：后退 / 前进 / 刷新）。
   *
   * 不走审批：这条链路由用户的点击发起，没有模型参与，也就没有可裁决的入参。
   * 这里**不写回**返回值——`browser.navigate` 给的是**发起时**的状态，而导航是异步的；
   * 真正的新状态由主进程在 did-navigate 时经 `browser.state` 推回来（上面的订阅已处理）。
   */
  const browserNav = useCallback(
    (action: BrowserNavAction) => {
      void window.colt.invoke("browser.navigate", { sessionId, action }).catch(() => undefined);
    },
    [sessionId],
  );

  /**
   * 撤销 agent 留下的「视口联调」覆盖（用户点浏览器头部的「恢复」）。
   *
   * 覆盖是持久状态，只有显式撤销才结束；不给这个出口，用户就只能看着一个
   * 比停靠区更大、右侧被窗口裁掉、下方压住观测抽屉的面板而不知道该怎么办。
   * 与 agent 的 `browser_act viewport`（不给尺寸即恢复）是同一件事，只是发起方是用户。
   */
  const resetBrowserViewport = useCallback(() => {
    void window.colt.invoke("browser.viewport.reset", { sessionId }).catch(() => undefined);
  }, [sessionId]);

  /**
   * 开 / 关「适应宽度」：把装不下的页面等比缩小，让整个宽度都能看见。
   *
   * 这里发的是**意图**（要不要适应）而不是比例——比例由主进程算，因为它同时握着
   * 「页面区域多宽」（它自己摆的原生视图矩形）与「页面需要多宽」（它自己量的 contentWidth），
   * 而渲染层只有一个估算的 `areaWidth`。发比例等于把这段算术复制到两个进程里。
   */
  const browserZoom = useCallback(
    (fit: boolean) => {
      void window.colt.invoke("browser.zoom", { sessionId, fit }).catch(() => undefined);
    },
    [sessionId],
  );

  /**
   * 右栏宽度（规则 ⑦-B）：**只由用户拖拽决定**。
   * 没有拖拽时用**统一默认宽度**（`DOCK_DEFAULT_WIDTH`）——不按页签取建议值，
   * 否则切页签就会改宽度、中栏跟着重排。一旦拖过，`dockWidthUser` 优先，其余一律不覆盖它。
   * 无论来源如何，都按当前可用空间钳制，保证中栏不被挤到 360px 以下、右栏也不越界。
   */
  const dockWidth = useMemo(() => {
    // 折叠态优先：宽度固定为图标条宽度，用户拖拽值保留在 dockWidthUser 里，展开时恢复
    if (dockCollapsed) return DOCK_COLLAPSED_WIDTH;
    const base = dockWidthUser ?? DOCK_DEFAULT_WIDTH;
    if (dockSpace <= 0) return base;
    const max = Math.max(MIN_DOCK_WIDTH, dockSpace - MIN_CENTER_WIDTH);
    return Math.min(Math.max(MIN_DOCK_WIDTH, base), max);
  }, [dockCollapsed, dockWidthUser, dockSpace]);

  useEffect(() => {
    dockWidthRef.current = dockWidth;
  }, [dockWidth]);

  /** 把任意宽度钳到 [220, 可用宽度 − 360]；窗口过窄时上限回退到下限，不与下限打架 */
  const clampDockWidth = useCallback((px: number): number => {
    const space = rootRef.current?.clientWidth ?? 0;
    if (space <= 0) return Math.max(MIN_DOCK_WIDTH, px);
    const max = Math.max(MIN_DOCK_WIDTH, space - MIN_CENTER_WIDTH);
    return Math.min(Math.max(MIN_DOCK_WIDTH, px), max);
  }, []);

  const onDockGripDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dockDragRef.current = { startX: event.clientX, startWidth: dockWidthRef.current };
    setDockDragging(true);
  }, []);

  /** 双击把手：丢弃用户宽度，回到统一默认宽度 */
  const resetDockWidth = useCallback(() => setDockWidthUser(null), []);

  // 拖拽期间在 window 上跟随指针：把手指移出把手（甚至出窗口）也不会丢事件（原型同款做法）。
  // 位移计算见 AGENTS.md 3.3：只对「位移」取负，宽度本身恒正。
  useEffect(() => {
    if (!dockDragging) return;
    const onMove = (event: MouseEvent): void => {
      const start = dockDragRef.current;
      if (start === null) return;
      // 把手在中栏↔右栏边界上：向左拖（dx<0）→ 右栏变宽，向右拖（dx>0）→ 变窄
      const next = start.startWidth - (event.clientX - start.startX);
      setDockWidthUser(clampDockWidth(next));
    };
    const onUp = (): void => setDockDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.classList.add("resizing");
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
    };
  }, [dockDragging, clampDockWidth]);

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

  /**
   * 运行态的 ref 镜像。`running` 的派生值在组件靠后处（⑥ 那一段）才算出来，
   * 而 `compact`（由输入框的斜杠命令调用，位置更靠前）需要读它——用 ref 避开
   * 依赖倒挂：直接把 `running` 当依赖会迫使 `compact` / `submit` 都跟着重建。
   */
  const runningRef = useRef(false);
  runningRef.current = view?.running ?? false;

  // 会话头展示工作目录的 git 分支（规则 ②-B）；非仓库或读取失败则隐藏。
  // 用户可能在应用外部切换分支，故除 cwd 变化外，窗口重新获焦时也刷新一次。
  useEffect(() => {
    let disposed = false;
    const refresh = (): void => {
      void window.colt
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
  // 若右栏当时是折叠态，同时展开它：只切页签而右栏还收着，等于没被看到。
  useEffect(() => {
    let disposed = false;
    browserAutoSwitchedRef.current = false;
    setBrowser(null);
    // 会话切换：页签集合与激活项都回到初始（与 A1 的宽度语义一致，不做持久化）
    setDockInstances(defaultDockInstances());
    setDockActiveId(DOCK_DEFAULT_KIND);
    // 文件预览目标也清掉：路径是相对本会话工作目录的，跨会话沿用会指向别的项目
    setDockFile(null);

    const apply = (next: BrowserViewState): void => {
      if (disposed) return;
      setBrowser(next);
      if (next.loaded && !browserAutoSwitchedRef.current) {
        browserAutoSwitchedRef.current = true;
        // 幂等：已打开就只激活，不会重复建页签
        ensureDockInstance("browser");
        setDockCollapsed(false);
      }
      if (!next.loaded) browserAutoSwitchedRef.current = false;
    };

    // 挂载时对齐：本组件卸载期间（切会话）该会话可能已经加载过浏览器
    void window.colt
      .invoke("browser.state.get", { sessionId })
      .then(apply)
      .catch(() => undefined);

    const off = window.colt.on("browser.state", (state) => {
      if (state.sessionId === sessionId) apply(state);
    });
    return () => {
      disposed = true;
      off();
    };
  }, [sessionId, ensureDockInstance]);

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
    setNotice(null);
    setCompactNotice(null);
    setApprovals([]);

    const offView = window.colt.on("session.view", (next) => {
      if (disposed || next.sessionId !== sessionId) return;
      setView(next);
    });
    const offError = window.colt.on("session.error", (payload) => {
      if (!disposed && payload.sessionId === sessionId) setError(payload.message);
    });
    // 压缩完成由 worker 在**真的压缩完**后推来（invoke 提前返回的是「已入队」，不可作数）。
    // 提示是瞬时的：几秒后自动消失，不占用黄条的位置。
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const offNotice = window.colt.on("session.notice", (payload) => {
      if (disposed || payload.sessionId !== sessionId) return;
      setCompactNotice(payload.message);
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => setCompactNotice(null), 5000);
    });
    const offApproval = window.colt.on("approval.pending", (payload) => {
      if (disposed || payload.sessionId !== sessionId) return;
      setApprovals(payload.requests);
    });

    void (async () => {
      try {
        // 审批模式是会话级状态：读的是本会话的设定（无全局设定）
        const current = await window.colt.invoke("approval.mode.get", { sessionId });
        if (!disposed) setMode(current.mode);

        // 缺密钥时**不**发 session.open（必然失败），但也不能就此静默返回：旧行为下
        // 直接 return，界面停在空白态——发不出消息、看不到原因，切模型又报「会话未运行」，
        // 三者叠加就是“选不了模型”那个死循环。
        // 现在给一条可操作的提示，且是**黄**的提示不是红错——这只是还差一步填密钥。
        const providerList = await window.colt.invoke("providers.list", undefined);
        const { providerId } = resolveSessionModel(sessionModelRef, providerList);
        const target = providerList.find((item) => item.id === providerId);
        // 只有**确实需要密钥**的服务才拦：本地 / 自建 endpoint 没密钥也能跑
        if (target && target.requiresKey && !target.hasKey) {
          // 顺带取一份快照：**有** worker 时才拿得到（`session.view` 只从 worker 池取，
          // 没有 worker 就是 null），无 worker 时历史确实显示不出来，只能提示原因。
          const snapshot = await window.colt.invoke("session.view", { sessionId });
          if (!disposed) {
            if (snapshot) setView(snapshot);
            setNotice(
              `尚未配置 ${target.name} 的 API Key，暂时无法对话。请到设置中填写，或在上方切换到其他已配置的模型。`,
            );
          }
          return;
        }

        await window.colt.invoke("session.open", { sessionId, cwd });
        const snapshot = await window.colt.invoke("session.view", { sessionId });
        if (!disposed && snapshot) setView(snapshot);
        // 重新打开时可能已有堆积的待审，需主动拉一次
        const pending = await window.colt.invoke("approval.list", { sessionId });
        if (!disposed) setApprovals(pending);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!disposed) setOpening(false);
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(noticeTimer);
      offView();
      offError();
      offNotice();
      offApproval();
      // 卸载时释放该会话的 worker。运行中会被主进程拒绝，交给空闲回收兼顾；
      // 重新打开时靠 JSONL 重放恢复，代价仅是一次启动延迟。
      void window.colt.invoke("session.close", { sessionId }).catch(() => undefined);
    };
  }, [sessionId, cwd]);

  // 新内容到达时自动滚到底（审批卡片出现时也要滚，否则用户看不到）。
  // 跟随**只在用户本就停在底部附近**时发生：流式期间每 50ms 一次投影更新，
  // 无条件拉底的话，用户上翻读历史会被不断拽回去，「回到底部」按钮也跟着闪烁。
  // 审批卡片例外——它是阻塞点、必须被看到，出现（计数增加）时强制拉底。
  const approvalsCountRef = useRef(0);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const approvalAppeared = approvals.length > approvalsCountRef.current;
    approvalsCountRef.current = approvals.length;
    if (distance <= 80 || approvalAppeared) node.scrollTop = node.scrollHeight;
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
        await window.colt.invoke("approval.resolve", {
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

  /**
   * 把 File（粘贴 / 拖拽 / 选择）读成 base64 附件。
   *
   * 附件通道只承载图片（对应内核的 imageInput 语义），非图片一律走不通——但**不能静默**：
   * 往输入框拖一个 PDF 却什么都没发生，用户只会以为程序坏了。
   * 所有「没进来」的原因都汇总成一条贴在输入卡片里的提示。
   */
  const addFiles = useCallback(async (files: File[]) => {
    const notes: string[] = [];
    const skipped = files.filter((file) => !file.type.startsWith("image/"));
    if (skipped.length > 0) {
      notes.push(
        `已跳过非图片文件：${skipped.map((file) => file.name || "未命名文件").join("、")}。请把它们放进项目目录，让 Agent 按路径读取。`,
      );
    }
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      setAttachNotice(notes.join(" ") || null);
      return;
    }
    const accepted: Attachment[] = [];
    for (const file of images.slice(0, MAX_ATTACHMENTS)) {
      const label = file.name || "剪贴板图片";
      if (file.size > MAX_ATTACHMENT_BYTES) {
        notes.push(`图片过大：${label}（${(file.size / 1024 / 1024).toFixed(1)}MB，上限 4MB）`);
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
    setAttachNotice(notes.join(" ") || null);
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_ATTACHMENTS));
    }
  }, []);

  /**
   * 手动压缩上下文（⑥ 的按钮与 `/compact` 命令共用）。
   *
   * 运行中不允许：压缩会**重写 transcript**（worker 里 compact 之后要重新取快照），
   * 与在飞的 run 撞在一起会让分流与工具配对错乱。运行中直接给出说明而不是静默丢队列。
   */
  const compact = useCallback(async () => {
    setError(null);
    if (runningRef.current) {
      setError("运行中无法压缩上下文：请先停止当前运行，或等它跑完。");
      return;
    }
    try {
      await window.colt.invoke("session.compact", { sessionId, cwd });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, cwd]);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    // 斜杠命令：只认白名单（`/compact` / `/skill`），未知的 `/xxx` 回落成普通提问照常发出。
    // 命令一律**被消费**（清空输入）、但**不消耗附件**（附件留给下一条消息）。
    const command = parseSlashCommand(text);
    if (command?.name === "compact") {
      setInput("");
      await compact();
      return;
    }
    if (command?.name === "skill") {
      // 注意：**这里判断不了成败**。`invoke` 返回的是「已投递」，worker 的校验与失败
      // 走 `session.error` 推送（见下面的事件订阅）——所以名字打错时，那半句额外指示会
      // 跟着输入一起没掉。代价可接受：错误里会**列出可用技能名**，改一个字重敲即可。
      // 想彻底避免这个损失，得让渲染层拿到技能清单（`ConversationView` 目前没有这个字段），
      // 那样就能在本地先校验再决定清不清——那也正是将来做技能选择器要补的那一块。
      setInput("");
      setError(null);
      try {
        await window.colt.invoke("session.skill", {
          sessionId,
          name: command.skillName,
          instructions: command.instructions,
          // 主进程凭 cwd 在 worker 被空闲回收后自动重建会话进程
          cwd,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
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
    setAttachNotice(null);
    try {
      await window.colt.invoke("session.prompt", {
        sessionId,
        text,
        images: images.length > 0 ? images : undefined,
        // 主进程凭 cwd 在 worker 被空闲回收后自动重建会话进程
        cwd,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [input, attachments, view, sessionId, cwd, compact]);

  const abort = useCallback(async () => {
    try {
      await window.colt.invoke("session.abort", { sessionId });
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
      setNotice(null);
      try {
        // 带 cwd：主进程据此在 worker 已被空闲回收时自愈重建（同 prompt / compact）
        const result = await window.colt.invoke("session.setModel", {
          sessionId,
          providerId,
          modelId,
          cwd,
        });
        // 选择已落库（无 worker 时也只落库、不拉会话）。必须立刻把结果回写到上层缓存：
        // 这种会话可能根本没有 worker，`view.model` 永远不会更新，界面会一直显示旧模型，
        // 用户看到的就是「选了没反应」。
        onModelSelected?.(`${providerId}/${modelId}`);
        // 选中的服务还没配密钥：这不是失败，只是一步待办——用黄色提示而非红框，
        // 免得用户对着一行红字反复重选。
        if (result.needsKey) {
          const name = providers.find((item) => item.id === providerId)?.name ?? providerId;
          setNotice(`已选择 ${name}，但它尚未配置 API Key，请到设置中填写后再发送消息。`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId, cwd, providers, onModelSelected],
  );

  const switchThinkingLevel = useCallback(
    async (value: string) => {
      if (!isThinkingLevel(value)) return;
      setError(null);
      setNotice(null);
      try {
        await window.colt.invoke("session.setThinkingLevel", { sessionId, level: value, cwd });
        // 同 switchModel：可能压根没有 worker（会话未打开 / 已空闲回收），view 永远不会更新，
        // 不回写父组件缓存的话，切走再回来就会显示回旧等级。
        onThinkingLevelSelected?.(value);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId, cwd, onThinkingLevelSelected],
  );

  const switchMode = useCallback(
    async (next: ApprovalMode) => {
      setError(null);
      try {
        const result = await window.colt.invoke("approval.mode.set", { mode: next, sessionId });
        setMode(result.mode);
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

  // 当前会话所用 provider 与模型。
  // 取值规则见 displayModelRef：**落库的选择优先**，但已失效时必须改显示「实际会用」的那个，
  // 否则界面会一直展示一个永远不会被使用的模型（用户以为在用 A，实际跑的是 B）。
  // 没有 worker 的会话（未打开 / 已空闲回收）根本没有 view，只认 view.model 会把
  // 「已经选好并落库」显示成空——那正是「选不了模型」的来源。
  const display = displayModelRef(sessionModelRef, providers, view?.model);
  const selectedModelRef = display.modelRef;
  const { provider: currentProviderId, model: currentModelId } = splitModelRef(selectedModelRef);
  // 跨 provider 选择：列出**所有** provider 的模型，值带上 provider 前缀。
  // **不过滤掉无密钥的 provider**：用户常常是先选定模型服务、再去设置里填它的密钥，
  // 下拉里看不到就无从选起。选中无密钥项时主进程只落库不报错（回 needsKey），
  // 前端给一条黄色提示引导去填密钥。
  // 「未配置密钥」只对**确实需要密钥**的服务标注：本地 / 自建 endpoint 本就没有密钥，
  // 给它挂上这个后缀会让人以为还得去配点什么。
  const modelOptions = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      value: `${provider.id}/${model.id}`,
      label:
        provider.requiresKey && !provider.hasKey ? `${model.name}（未配置密钥）` : model.name,
    })),
  );
  // 思考等级：worker 在就以它的投影为准（运行时切换会立刻回推），否则认会话上落库的值，
  // 都没有才回落到默认值。**默认值不能是 off**——off 会被 provider 兼容层翻译成
  // 「显式关闭思考」，对「始终思考」的模型会让压缩 / 审批这类无工具请求直接失败。
  const currentThinkingLevel: ThinkingLevel =
    view?.thinkingLevel ?? sessionThinkingLevel ?? DEFAULT_THINKING_LEVEL;
  const thinkingLevelOptions = THINKING_LEVELS.map((level) => ({
    value: level,
    label: THINKING_LEVEL_LABELS[level],
    hint: THINKING_LEVEL_HINTS[level],
  }));
  // 会话头上显示的文案直接取「当前选中项」的标签，与下拉选项**同源**：
  // 两处各算一遍必然漂移（冒烟实测过：选项写着「（未配置密钥）」，选中后抬头却把标记
  // 丢了——那等于选完就不再提醒这个服务还没配密钥）。选项里找不到时（provider 被删、
  // 模型下线、providers 尚未加载）回落到原始引用，至少让人看得出会话选的是什么。
  const currentModelLabel =
    modelOptions.find((option) => option.value === selectedModelRef)?.label ??
    (selectedModelRef || "—");

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

  /**
   * ⑥ 的状态段（C1 / C2）。运行中之外，只有**中断**与**失败**值得单独留一行——
   * 正常跑完与「还没跑过」一样是「空闲」（判定见 `runStateOf`）。
   * 状态是**电平**不是边沿：它会一直留到下一轮开始（v3 §6 要求结束时「清除所有转圈」，但没说要清掉状态本身）。
   */
  const runState = runStateOf(running, view?.lastRun ?? null);
  const runError = view?.lastRun?.error ?? null;

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
      className="relative grid h-full grid-rows-[auto_1fr_auto] overflow-hidden"
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
          <PanelToggle
            active={dockActiveKind === "usage"}
            icon={<ChartColumn {...ICON.sm} />}
            label="统计"
            title="在右栏查看本次会话的统计（费用、用量、工具调用与失败）"
            onClick={() => openDockKind("usage")}
          />
          <PanelToggle
            active={dockActiveKind === "rules"}
            icon={<ShieldCheck {...ICON.sm} />}
            label="规则"
            title="在右栏查看并管理本次会话记住的审批规则"
            onClick={() => openDockKind("rules")}
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
            <div
              data-conv-error
              className="mb-3 rounded-[8px] border border-danger/50 bg-danger-soft px-3 py-2 text-[12.5px] text-danger-fg"
            >
              {error}
            </div>
          )}

          {notice && (
            <div
              data-conv-notice
              className="mb-3 rounded-[8px] border border-warning/50 bg-warning-soft px-3 py-2 text-[12.5px] text-warning"
            >
              {notice}
            </div>
          )}

          {compactNotice && (
            <div
              data-conv-compact-notice
              className="mb-3 rounded-[8px] border border-success/50 bg-success-soft px-3 py-2 text-[12.5px] text-success-fg"
            >
              {compactNotice}
            </div>
          )}

          {/*
            选定已失效（服务被删 / 模型下线）：抬头显示的是**实际会被使用**的模型，
            因此要明说原来的选择去哪了，否则用户会以为自己切错了模型。
          */}
          {display.driftedFrom && (
            <div
              data-conv-drift
              className="mb-3 rounded-[8px] border border-warning/50 bg-warning-soft px-3 py-2 text-[12.5px] text-warning"
            >
              原选定模型 {display.driftedFrom} 已不可用（服务或模型已被删除），本会话实际使用{" "}
              {selectedModelRef}。可在上方切换其他模型。
            </div>
          )}

          {/*
            `view` 为 null（无 worker，如草稿会话）时也要显示空态：用 `?? 0` 兜底，
            否则 null === 0 为 false，用户会看到一个既没有空态文案、也没有报错的空白区。
          */}
          {(view?.messages.length ?? 0) === 0 && !opening && !error && (
            <div className="flex h-full flex-col items-center justify-center gap-2.5">
              <div className="mb-1 text-[10px] uppercase tracking-[2px] text-text-muted">
                Colt · 本地编码 Agent
              </div>
              <h2 className="m-0 text-[22px] font-semibold tracking-[-.3px] text-text-primary">
                今天要修哪个 bug？
              </h2>
              <p className="m-0 text-[12.5px] text-text-secondary">
                描述你想做的事，Colt 会先给你一份计划。
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
                onOpenFile={openFile}
                openState={toolOpenStateRef.current}
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
                    openId={tool.id}
                    openState={toolOpenStateRef.current}
                    name={tool.name}
                    args={tool.args}
                    running
                    result={{ output: tool.output, isError: false }}
                    onOpenFile={openFile}
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
            {attachNotice && (
              <p data-conv-attach-notice className="mb-1.5 text-[11px] text-warning">
                {attachNotice}
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

              {/*
                `/compact` 的可发现入口：命令是**前端本地识别**的（`parseSlashCommand`），
                但只靠 placeholder / 文档告知用户等于“隐形”。这里做成**真能点**的按钮
                （点它与在输入框敲 `/compact` 回车走同一条 `compact()`），不是只写一行提示文字。
                运行中禁用并给出原因，与 `compact()` 的守卫一致。
              */}
              <button
                type="button"
                onClick={() => void compact()}
                disabled={running}
                data-slash-command="compact"
                title={
                  running
                    ? "运行中无法压缩上下文（压缩会重写会话记录）"
                    : "压缩上下文（也可在输入框敲 /compact 回车）"
                }
                className="flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2 font-mono text-[11.5px] text-text-secondary transition hover:bg-surface-overlay hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Shrink {...ICON.sm} className="shrink-0" />
                /compact
              </button>

              <span className="cpush flex-1" />

              <div className="cright flex shrink-0 items-center gap-2">
                <Picker
                  title="思考等级：越高越能想、越低越快越省。默认「高」"
                  value={currentThinkingLevel}
                  label={THINKING_LEVEL_LABELS[currentThinkingLevel]}
                  options={thinkingLevelOptions}
                  plain
                  className="thinking"
                  onChange={(value) => void switchThinkingLevel(value)}
                />
                <Picker
                  title={
                    modelOptions.length > 0
                      ? "当前模型"
                      : "没有可选的模型：请先到设置中添加模型服务并填写 API Key"
                  }
                  value={`${currentProviderId}/${currentModelId}`}
                  label={currentModelLabel}
                  options={modelOptions}
                  disabled={modelOptions.length === 0}
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

            {/* data-run-state 是「这一段是 ⑥ 的运行状态」的稳定标记（给冒烟读状态用） */}
            <span data-run-state={runState} className="flex items-center gap-2.5">
              {runState === "running" ? (
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
                // 非运行态：静止的点 + 文字。点的颜色跟着语义走（灰=静止，红=失败），
                // 但颜色只是辅助——旁边永远有文字（v3 §5「颜色必须配文字」）。
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn("live-dot", runState === "failed" ? "danger-dot" : "idle-dot")}
                  />
                  <span className={cn("shrink-0", runState === "failed" && "text-danger")}>
                    {runState === "aborted" ? "已中断" : runState === "failed" ? "已失败" : "空闲"}
                  </span>
                  {/* 失败原因就地可读，不必去消息流里翻；窄栏按容器查询收紧，悬停看全文 */}
                  {runState === "failed" && runError !== null && (
                    <span
                      className="lb-err truncate font-mono text-[11px] text-danger-fg"
                      title={runError}
                    >
                      {runError}
                    </span>
                  )}
                </span>
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
          browser={browser}
          onBrowserNav={browserNav}
          onResetViewport={resetBrowserViewport}
          onBrowserZoom={browserZoom}
          fileRequest={dockFile}
          instances={dockInstances}
          activeId={dockActiveId}
          onActivate={activateDockInstance}
          onCloseInstance={closeDockInstance}
          onOpenKind={ensureDockInstance}
          collapsed={dockCollapsed}
          onToggleCollapse={() => setDockCollapsed((value) => !value)}
        />
      </div>

      {/* 中栏 ↔ 右栏拖拽把手（规则 ⑦-B：右栏宽度只由用户拖拽决定）。
          绝对定位、不参与网格布局，浮在两栏分隔线上：right 取当前右栏宽度，
          再右移半个身位（translateX 50%）让把手中心正落在边界上。
          折叠态不渲染：图标条不需要调宽，也不该出现拖拽命中区。 */}
      {!dockCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整右栏宽度"
          title="拖拽调整右栏宽度（双击复位）"
          onMouseDown={onDockGripDown}
          onDoubleClick={resetDockWidth}
          className={cn("dock-grip", dockDragging && "dragging")}
          style={{ right: dockWidth, transform: "translateX(50%)" }}
        />
      )}
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
  disabled,
  className,
  onChange,
}: {
  title: string;
  value: string;
  label: string;
  options: { value: string; label: string; hint?: string }[];
  icon?: ReactNode;
  plain?: boolean;
  /** 无选项时置灰：否则点下去没任何反馈，用户会当成“点了没反应” */
  disabled?: boolean;
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
        disabled={disabled}
        title={title}
        className={cn(
          "cbtn flex h-7 items-center gap-1.5 rounded-[6px] border px-2 text-[12px] text-text-secondary transition",
          plain
            ? "border-transparent hover:border-transparent hover:bg-surface-overlay hover:text-text-primary"
            : "border-line hover:border-line-strong hover:text-text-primary",
          disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-text-secondary",
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
