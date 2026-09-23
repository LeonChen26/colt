// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 右栏工作区容器（规则 ⑦-B）：以**页签**切换视图。
 *
 * 「任务摘要」是默认视图（⑦-E，常驻不可关闭）；「浏览器」是 agent 动作对象的投影（⑦-A / ⑦-C）。
 *
 * A3-5：原先挂在中栏的观测 / 管理面板（改动 / 统计（原「用量」）/ 规则）**迁入本容器**——
 * 它们本来只是「我想看的附属内容」，正是 ⑦ 的定义（「以及我想看的任何附属内容」），
 * 放在中栏会挤掉叙事主线，还造成「改动面板 vs 代码变更视图」两处实现同一个东西。
 * 迁入后**只有页签这一个载体**：面板自身不再有「收起」（关闭由页签的 × 负责）。
 * ⑦-H（v1.31）又取消了一个：原「工具」视图的聚合与明细都并入「统计」。
 *
 * ⑦-G（v1.32）：原「改动」「文件」**两个页签整个取消**，成为「任务摘要」的下钻
 * （清单 → diff → 内容，见 `ChangeDrilldown`）——用户不需要知道「该去改动页签还是文件页签」。
 * 故本容器现在只有四个 kind，且**只管「在不在下钻」，不管下钻到哪一层**：
 * 层内跳转是那个组件自己的事，绕一圈回到这里再下去只会让状态两处维护。
 *
 * 页签可**关闭**（A3-3），但**只有可关闭的视图才有「+」菜单这条重新打开的路径**——
 * 「可关闭」与「菜单里能打开」是同一个集合，结构上就不可能出现「关了回不来」的死局；
 * ⑦-E 的默认视图因此不可关闭（`closable: false`，既不渲染关闭按钮，菜单里也没有它）。
 *
 * 浏览器本体的关键约束：它是由主进程持有的 **WebContentsView（原生视图）**，
 * 浮在渲染层之上，渲染层画不了它，也无法用 CSS 裁切。因此这里的职责是：
 *   1. 画一个「页面区域」占位 div，量出它的矩形上报给主进程（`browser.bounds`）；
 *   2. 切到别的页签 / 组件卸载时上报 null，让主进程隐藏原生视图——
 *      否则原生视图会一直浮在界面上，盖住别的页签内容（原生视图不参与 DOM 叠层）。
 */

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Activity,
  ChartColumn,
  ChevronLeft,
  ChevronRight,
  Globe,
  FolderTree,
  MonitorSmartphone,
  MoveHorizontal,
  Plus,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  X,
  ZoomOut,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import type { BrowserNavAction, BrowserViewState } from "@shared/protocol";
import type { ConversationView } from "@shared/worker-protocol";
import { cn } from "../../lib/utils";
import { FollowPanel } from "./FollowPanel";
import { ObserveDrawer } from "./ObserveDrawer";
import { ChangeDrilldown, type DrillLayer, type DrillRequest } from "./panels/ChangeDrilldown";
import { FilesPanel } from "./panels/FilesPanel";
import { RulesPanel } from "./panels/RulesPanel";
import { UsagePanel } from "./panels/UsagePanel";
import { EventsPanel } from "./panels/EventsPanel";
import { TerminalPanel } from "./panels/TerminalPanel";

/** 视图类型（kind）：决定页签里渲染什么内容 */
export type DockKind = "follow" | "browser" | "files" | "terminal" | "usage" | "rules" | "events";

/**
 * 一个**已打开**的视图实例（规则 ⑦-B：⑦ 是可插拔容器，「任务摘要」只是默认视图）。
 *
 * 当前每种 kind 只有单例，故 `id === kind`；「同 kind 多实例」的能力见
 * `docs/NEXT-PHASE.md` 的「事 B」——届时 id 改为独立生成即可，**调用方只认 id**。
 *
 * 注：「要看文件」的请求由容器外的 `fileRequest` 传入（单例下够用）；
 * 多实例时该目标会随实例走，届时并入本结构。
 */
export interface DockInstance {
  id: string;
  kind: DockKind;
}

/** 默认视图（⑦-E）：启动时即为激活页签，且不可关闭 */
export const DOCK_DEFAULT_KIND: DockKind = "follow";

/** 建实例：单例模型下 id 直接取 kind，因此重复调用是**幂等**的 */
export function createDockInstance(kind: DockKind): DockInstance {
  return { id: kind, kind };
}

/** 启动时的页签集合（与既有行为一致：两个页签都在） */
export function defaultDockInstances(): DockInstance[] {
  return [createDockInstance("follow"), createDockInstance("browser")];
}

/**
 * 每种视图的展示信息（图标在渲染处按尺寸展开，两种尺寸共用一份）。
 *
 * `closable`：能否关闭。默认视图（⑦-E）不可关闭；其余都可，且因此都会出现在「+」菜单里。
 * `desc` 只给菜单用——是菜单里那行小字说明（对齐高保真 `.dock-menu button .md`）。
 */
const DOCK_KIND_META: Record<
  DockKind,
  { label: string; Icon: typeof Activity; closable: boolean; desc?: string }
> = {
  follow: { label: "任务摘要", Icon: Activity, closable: false },
  browser: { label: "浏览器", Icon: Globe, closable: true, desc: "浏览及调试网页" },
  // 整项目只读浏览（v1.77）：与「任务摘要」下钻分工——那边是「本次动过什么」，这边是「项目里有什么」
  files: { label: "文件", Icon: FolderTree, closable: true, desc: "浏览项目内的文件" },
  // 交互终端（v1.78）：xterm.js + 主进程 PTY，跑在会话所属项目根下；用户直操作，
  // 模型工具面零入口（安全边界见 docs/SECURITY.md 的终端条目）
  terminal: { label: "终端", Icon: SquareTerminal, closable: true, desc: "在项目根下开一个 shell" },
  // A3-5 迁入、⑦-H / ⑦-G 收敛后剩下的两个附属面板：「统计」「规则」。
  // 标签沿用产品既有措辞（不改成设计稿的「代码变更」），免得同一件东西在 ② 与 ⑦ 上出现两套叫法——
  // 故 ⑦-H 把「用量」改名「统计」时，② 的按钮与本表的页签标签**同批**改（v1.30）。
  // ⑦-H 第三步（v1.31）把原「工具」视图**取消了**：它的聚合（次数 / 耗时 / 失败排行）
  // 与明细**都**并进了「统计」，故本表不再有 `tools`——它不是被藏起来，而是没有这个视图了。
  // ⑦-G（v1.32）同理取消了 `changes` 与 `file`：两者都是「本次改动」的不同粒度，
  // 合并成了「任务摘要」的下钻（`ChangeDrilldown`），不再是并列页签。
  usage: { label: "统计", Icon: ChartColumn, closable: true, desc: "本次会话的用量、工具调用与失败统计" },
  rules: { label: "规则", Icon: ShieldCheck, closable: true, desc: "本次会话记住的审批规则" },
  // F3：安全事件流（技能装载告警、同名覆盖、读取失败等）。它们发生时只弹 5 秒 toast、
  // 无从回查——主进程把它们同时落库（session_events），这个页签是持久记录的回看入口。
  events: { label: "事件", Icon: ShieldAlert, closable: true, desc: "本次会话的安全事件记录，重启后仍可回看" },
};

/** 该视图能否关闭（⑦-E：默认视图不可关闭） */
export function isDockClosable(kind: DockKind): boolean {
  return DOCK_KIND_META[kind].closable;
}

/**
 * 「+」菜单列出的视图。**由 `closable` 推导**，而不是另写一份清单——
 * 这样「可关闭」与「有重新打开的出口」在结构上恒等，将来也漏不掉。
 *
 * 只列**产品里真的存在**的视图：高保真稿的菜单还画了任务摘要 / 代码变更，
 * 但那两种在 ⑦ 里**都不是可开的页签**（⑦-G 之后「代码变更」是「任务摘要」的下钻；
 * v1.48 之后「任务摘要」这个名字归了**默认视图本身**——它不可关闭，也就不该进菜单；
 * 稿里的「终端」v1.78 起是真的，在列），列进来就是点了没反应的死菜单项——
 * 宁可少列（同 ⑦-F 那次「死控件」的教训）。
 */
const DOCK_MENU_KINDS: DockKind[] = (Object.keys(DOCK_KIND_META) as DockKind[]).filter(
  (kind) => DOCK_KIND_META[kind].closable,
);

/**
 * 右栏的**统一默认宽度**（规则 ⑦-B：宽度只由用户拖拽决定，这里是没有拖拽时的默认值）。
 *
 * 原先按视图类型各给一个建议值（任务摘要 300 / 浏览器 544 / 文件 560 / 改动 420 / …），
 * 于是**切页签就会改宽度**：中栏跟着忽宽忽窄、内容反复重排，是纯粹的视觉噪声。
 * 现统一为一个值——切页签不再改变宽度，宽度只可能因用户拖拽或窗口缩放而变。
 *
 * 取 544（原「浏览器」的建议值）：各类视图里以它最宽——页面挤窄了当场不可用，
 * 而下钻出的 diff 与文件预览也都需要横向空间。取「满足最宽需求」的那个值，
 * 窄视图只是略宽；反过来取窄值会让浏览器视图当场不可用。
 */
export const DOCK_DEFAULT_WIDTH = 544;

/** 折叠态宽度：44px 图标条（规则 ⑦-E：可折叠、保留页签与活动指示，但不提供完全关闭） */
export const DOCK_COLLAPSED_WIDTH = 44;

/**
 * 页签：激活态用强调色下边框（对齐高保真 .dock-tab）。
 *
 * 外层是 `div` 而不是 `button`——关闭按钮要作为**独立**可点目标，而 `<button>` 里嵌
 * `<button>` 是非法结构（同 MessageList 的工具卡）。关闭按钮**悬停才显形**
 * （对齐 `.dock-tab .tclose`：`opacity:0` → 页签 hover → `1`），平时不占注意力。
 *
 * `data-dock-tab` 是「这是一个工作区页签」的稳定标记：容器里会挂别的可切换控件
 * （如 B2 观测抽屉的三个页签，同样用 `aria-pressed` 表达选中），
 * 只靠 `aria-pressed` 数页签会把它们算进来。
 */
function DockTab({
  active,
  icon,
  label,
  live,
  onActivate,
  onClose,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  live?: boolean;
  onActivate: () => void;
  /** 传入才渲染关闭按钮；默认视图（⑦-E）不传 */
  onClose?: () => void;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "group flex h-7 shrink-0 items-center border-b-2 transition",
        onClose !== undefined && "pr-1",
        active ? "border-accent" : "border-transparent",
      )}
    >
      <button
        type="button"
        data-dock-tab=""
        onClick={onActivate}
        aria-pressed={active}
        className={cn(
          "flex h-full items-center gap-1.5 pl-2 text-xs whitespace-nowrap transition",
          onClose === undefined ? "pr-2" : "pr-1",
          active ? "font-medium text-text-primary" : "text-text-muted hover:text-text-secondary",
        )}
      >
        {icon}
        {label}
        {live && <span className="live-dot" />}
      </button>
      {onClose !== undefined && (
        <button
          type="button"
          onClick={onClose}
          title={`关闭${label}`}
          aria-label={`关闭${label}`}
          className="ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition hover:bg-line-soft hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
        >
          <X {...ICON.xs} />
        </button>
      )}
    </div>
  );
}

/** 折叠态图标条上的视图入口：只留图标 + 运行/激活指示（⑦-E：可折叠、保留页签与活动指示） */
function RailTab({
  active,
  icon,
  label,
  live,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  live?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-sm transition",
        active
          ? "bg-accent-soft text-text-primary"
          : "text-text-muted hover:bg-surface-overlay hover:text-text-secondary",
      )}
    >
      {icon}
      {live && <span className="live-dot absolute right-1 top-1" />}
    </button>
  );
}

export function WorkspaceDock({
  sessionId,
  view,
  highlightPath,
  browser,
  fileRequest,
  subagentRequest,
  onBrowserNav,
  onResetViewport,
  onBrowserZoom,
  instances,
  activeId,
  onActivate,
  onCloseInstance,
  onOpenKind,
  collapsed,
  onToggleCollapse,
}: {
  sessionId: string;
  view: ConversationView | null;
  highlightPath?: string | null;
  browser: BrowserViewState | null;
  /** 用户点后退 / 前进 / 刷新（B1）；发起方是用户，不走审批 */
  onBrowserNav: (action: BrowserNavAction) => void;
  /** 用户点「恢复」撤销 agent 留下的视口联调覆盖 */
  onResetViewport: () => void;
  /**
   * 开 / 关「适应宽度」（缩放）。传的是**意图**不是比例——比例由主进程算（它同时握着
   * 区域宽与页面需要多宽），渲染层只负责发起与呈现。
   */
  onBrowserZoom: (fit: boolean) => void;
  /**
   * 「要看某个文件」的请求（A3-2：点消息流工具卡上的路径）——`seq` 变化即重读。
   * ⑦-G 之后它不再切「文件」页签，而是**让「任务摘要」落到下钻的内容层**。
   */
  fileRequest: { path: string; seq: number } | null;
  /**
   * 「要看某个子代理的完整过程」的请求（点 ④ 子代理卡的按钮）——`seq` 变化即重下钻。
   * 与 `fileRequest` 同形：都让「任务摘要」落到**下钻的某一层**，只是目标从文件内容
   * 多了一种到子代理流（决策三 D5 / 决策七 D9）。
   */
  subagentRequest: { id: string; seq: number } | null;
  /** 已打开的视图实例（⑦-B：页签可以很多） */
  instances: DockInstance[];
  /** 当前激活实例的 id */
  activeId: string;
  onActivate: (id: string) => void;
  /** 关闭某个页签（A3-3）；不可关闭的视图由上层守卫，不会走到这里 */
  onCloseInstance: (id: string) => void;
  /** 从「+」菜单打开某类视图（已打开则只是激活它） */
  onOpenKind: (kind: DockKind) => void;
  /** 是否折叠为 44px 图标条（规则 ⑦-E） */
  collapsed: boolean;
  onToggleCollapse: () => void;
}): React.JSX.Element {
  const areaRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * 「页面区域」当前宽度。
   * 与主进程报来的 `contentWidth` 一比，就知道页面装不装得下——
   * 装不下时右侧会被原生视图裁掉，且页面若禁了横向滚动就**够不到**（见下方提示条）。
   */
  const [areaWidth, setAreaWidth] = useState(0);
  /**
   * 下钻**指令**；null = 停在 follow 层。
   *
   * 它是指令，不是状态：当前在下钻的哪一层由 `ChangeDrilldown` 自己持有，
   * 层内跳转（清单↔diff↔内容）不绕回容器。所以这里那份 `layer` 只描述「这次请求进哪一层」，
   * **随时可能已经滞后于界面**——容器里唯一的合法读法是「是不是 null」，
   * 别拿它去判断「现在在第几层」。要那种判断，就得把层状态整个搬上来，
   * 而那样层内跳转要绕一圈回到容器，是这个设计明确要避免的。
   */
  const [drillRequest, setDrillRequest] = useState<DrillRequest | null>(null);
  const drillNonce = useRef(0);
  /**
   * 发一条下钻指令。
   *
   * `nonce` 单调递增是**本函数的唯一职责里最关键的一条**：下钻层靠它判断「这是新请求」。
   * 之前靠「每次都是新对象」这个隐式约定——一旦有人 memo 化或复用同一个对象，
   * 重置就静默不发生（点了没反应），而代码看上去完全正常。
   */
  const sendDrill = useCallback(
    (target: {
      layer: DrillLayer;
      path?: string;
      token?: number;
      subagentId?: string;
    }): void => {
      drillNonce.current += 1;
      setDrillRequest({
        nonce: drillNonce.current,
        layer: target.layer,
        path: target.path ?? null,
        // 没显式给令牌的层（子代理流）用 `nonce` 顶：它同样是单调递增的，于是「同一个
        // 子代理再点一次」也必然换出一个新令牌，面板据此重拉——这一条不能省，否则
        // 同 id 重进时 `layer` / `subagentId` 都不变，面板不重挂、也就读不到新产出。
        token: target.token ?? drillNonce.current,
        subagentId: target.subagentId ?? null,
      });
    },
    [],
  );

  // 「要看某个文件」→ 进下钻的**内容层**（原 A3-2 的入口，行为等价，只是不再切页签）
  useEffect(() => {
    if (fileRequest === null) return;
    sendDrill({ layer: "content", path: fileRequest.path, token: fileRequest.seq });
  }, [fileRequest, sendDrill]);

  // 「要看某个子代理的完整过程」→ 进下钻的**子代理流层**（④ 卡上的按钮）
  useEffect(() => {
    if (subagentRequest === null) return;
    sendDrill({ layer: "subagent", subagentId: subagentRequest.id });
  }, [subagentRequest, sendDrill]);

  // 换会话时退出下钻：否则会停在上一个会话的文件上（那是另一个项目的路径）
  useEffect(() => {
    setDrillRequest(null);
  }, [sessionId]);

  // 点菜单外 / 按 Esc 收起「+」菜单。
  // 菜单**不能**挂在页签行里——那一行是 overflow-x-auto，绝对定位的菜单会被裁掉；
  // 所以菜单挂在 aside 上（相对 aside 定位），两者都带 data-dock-menu-root 视为「菜单内部」。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      const node = event.target;
      if (node instanceof Element && node.closest("[data-dock-menu-root]") !== null) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);
  const loaded = browser?.loaded ?? false;
  // 后退 / 前进的可用性**只**取自主进程现读的历史（见 BrowserViewState 的说明）：
  // 渲染层自己记一份历史必然与真实 webContents 走偏（页面内跳转、重定向都改历史，渲染层看不见）。
  const canGoBack = browser?.canGoBack ?? false;
  const canGoForward = browser?.canGoForward ?? false;
  /** 视口联调覆盖：非 null 时头部要显示它并给出「恢复」入口 */
  const override = browser?.viewport ?? null;
  /**
   * 页面装不下且**够不到**：内容比页面区域宽，而页面自己又禁了横向滚动
   * （主进程只在「禁了横向滚动」时才报 contentWidth > 0，见 BrowserViewState 的说明）。
   *
   * 判据是**算出来的**，不是「栏一窄就报警」：响应式页面在窄栏里会自己重排，
   * 那种页面永远不满足 contentWidth > areaWidth，也就不会挂上一条永远为真的灰条
   * （持续撒谎的提示比没有提示更糟）。
   *
   * 联调覆盖生效时不报：那时页面是按覆盖尺寸重排的，「装不装得下」已由联调标记解释，
   * 两条同时出现只会互相打架。
   */
  const contentWidth = browser?.contentWidth ?? 0;
  /**
   * 当前缩放（1 = 100%，「适应宽度」生效时小于 1）。
   *
   * 判「还看不看得到」必须**乘上它**：`contentWidth` 说的是「页面在 100% 下需要多宽」，
   * 缩放之后真正占的宽度是 `contentWidth × zoom`。少了这一乘，「适应宽度」生效后
   * 页面明明已经装下、横条却仍挂在那里说「右侧看不到」——一条立刻在撒谎的提示。
   */
  const zoom = browser?.zoom ?? 1;
  const needWidth = Math.round(contentWidth * zoom);
  const stillClipped = contentWidth > 0 && areaWidth > 0 && needWidth > areaWidth + 1;
  const clippedX = override === null && stillClipped;
  const activeInstance = instances.find((item) => item.id === activeId) ?? instances[0];
  const activeKind = activeInstance?.kind ?? DOCK_DEFAULT_KIND;
  const showBrowser = activeKind === "browser";
  const url = browser?.url ?? "";
  /**
   * 页面区域是否应该存在。折叠时**不给矩形**：原生视图浮在渲染层之上，
   * 折叠后若仍上报矩形，它会继续浮在界面上（⑦ 实现约束「折叠/切走必须上报隐藏」）。
   */
  const showArea = showBrowser && !collapsed;

  // 会话卸载（切会话 / 进设置）时必须把本会话的原生视图收起来，
  // 否则它会继续浮在界面上，盖住新会话的右栏。
  useEffect(() => {
    return () => {
      void window.colt.invoke("browser.bounds", { sessionId, rect: null }).catch(() => undefined);
    };
  }, [sessionId]);

  /**
   * 量页面区域并上报主进程。ResizeObserver 管尺寸变化，window resize 管位置变化
   * （右栏宽度 / 窗口移动）。但这两个都是**边沿触发**，而原生视图要的是
   * 「**一直**等于页面区域」这个电平状态：漏一次边沿，它就会永久错位——实测过：
   * 抽屉再展开时页面区域矮了 132px，原生视图却停在收起时的高度，于是压住观测抽屉。
   * 所以下面再周期性重申一次（useVisibleInterval）：代价是浏览器页签可见时
   * 每 400ms 一次小载荷 IPC，换来的是「任何原因导致的错位最多存在 400ms」；
   * 页签切走 effect 即卸载、窗口不可见时暂停（F11），心跳随之停止。
   */
  const report = useCallback((): void => {
    const node = areaRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    // 同时也记一份宽度：装了装不下要看它，而 getBoundingClientRect 只在 report 里量
    setAreaWidth(Math.round(rect.width));
    void window.colt
      .invoke("browser.bounds", {
        sessionId,
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      })
      .catch(() => undefined);
  }, [sessionId]);

  // 上报页面区域：只在「浏览器页签 + 未折叠 + 视图已加载 + 元素已挂载」时给矩形，其余一律 null
  useEffect(() => {
    const node = areaRef.current;
    if (!showArea || !loaded || node === null) {
      void window.colt.invoke("browser.bounds", { sessionId, rect: null }).catch(() => undefined);
      return;
    }
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [sessionId, showArea, loaded, report]);

  // 电平重申（边沿触发会漏，见上）：窗口不可见时暂停，重新可见时立即重申一次
  useVisibleInterval(report, 400, showArea && loaded);

  // 折叠态（⑦-E）：只留 44px 图标条，不渲染任何视图内容。
  // 内容一旦不渲染，页面区域 ref 即为 null，上面的 effect 会主动上报 null 收起原生视图。
  if (collapsed) {
    /**
     * 点图标条上的视图入口 = **切到该视图 + 展开**。
     * 图标条只有 44px，只切不展开的话点了没有任何可见反应（等于死控件）；
     * 这也对齐 VS Code 活动栏的惯例。本分支只会在折叠态渲染，故 toggle 必为展开。
     */
    const pick = (id: string): void => {
      onActivate(id);
      onToggleCollapse();
    };
    return (
      <aside className="flex min-h-0 w-full flex-col items-center border-l border-line bg-surface-raised">
        <div className="flex w-full flex-col items-center gap-0.5 py-1.5">
          <button
            type="button"
            onClick={onToggleCollapse}
            title="展开工作区"
            aria-label="展开工作区"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
          >
            <ChevronLeft {...ICON.sm} />
          </button>
          {instances.map((item) => {
            const meta = DOCK_KIND_META[item.kind];
            return (
              <RailTab
                key={item.id}
                active={item.id === activeId}
                icon={<meta.Icon {...ICON.sm} />}
                label={meta.label}
                live={item.kind === "follow" && (view?.running ?? false)}
                onClick={() => pick(item.id)}
              />
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className="relative flex min-h-0 w-full flex-col border-l border-line bg-surface-raised">
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1.5 pt-1.5">
        <button
          type="button"
          onClick={onToggleCollapse}
          title="折叠工作区"
          aria-label="折叠工作区"
          className="sticky left-0 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-surface-raised text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
        >
          <ChevronRight {...ICON.sm} />
        </button>
        {instances.map((item) => {
          const meta = DOCK_KIND_META[item.kind];
          return (
            <DockTab
              key={item.id}
              active={item.id === activeId}
              icon={<meta.Icon {...ICON.xs} className="shrink-0" />}
              label={meta.label}
              live={item.kind === "follow" && (view?.running ?? false)}
              onActivate={() => onActivate(item.id)}
              onClose={isDockClosable(item.kind) ? () => onCloseInstance(item.id) : undefined}
            />
          );
        })}
        {/* 「+」新增视图：贴右固定（页签超宽横向滚动时不被滚走，对齐高保真 #dockAdd） */}
        <button
          type="button"
          data-dock-menu-root=""
          onClick={() => setMenuOpen((value) => !value)}
          title="新增视图"
          aria-label="新增视图"
          aria-expanded={menuOpen}
          className={cn(
            "sticky right-0 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-surface-raised text-text-muted transition hover:bg-surface-overlay hover:text-text-primary",
            menuOpen && "bg-surface-overlay text-text-primary",
          )}
        >
          <Plus {...ICON.sm} />
        </button>
      </div>

      {/* 「+」下拉：只列**产品里真的存在**的视图（见 DOCK_MENU_KINDS 的说明） */}
      {menuOpen && (
        <div
          data-dock-menu-root=""
          className="absolute top-[calc(var(--h-panel-head)+4px)] right-2 z-50 min-w-[196px] rounded-md border border-line-strong bg-surface-overlay p-1 shadow-lg"
        >
          {DOCK_MENU_KINDS.map((kind) => {
            const meta = DOCK_KIND_META[kind];
            const opened = instances.some((item) => item.kind === kind);
            return (
              <button
                key={kind}
                type="button"
                data-dock-add={kind}
                onClick={() => {
                  onOpenKind(kind);
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-sm px-2 py-[7px] text-left text-sm text-text-secondary transition hover:bg-surface-raised hover:text-text-primary"
              >
                <span className="shrink-0 text-text-muted">
                  <meta.Icon {...ICON.sm} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{meta.label}</span>
                  {meta.desc !== undefined && (
                    <span className="truncate text-xs text-text-muted">{meta.desc}</span>
                  )}
                </span>
                {opened && <span className="shrink-0 text-2xs text-text-muted">已打开</span>}
              </button>
            );
          })}
        </div>
      )}

      {showBrowser ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 顶部信息条：原生视图压在下方，「页面区域」之外的东西由渲染层画 */}
          <div className="flex h-[var(--h-panel-head)] shrink-0 items-center gap-2 border-b border-line px-2.5">
            {/* 用户自己的浏览控制（B1）。与 agent 的 browser_act 是两条链路：那条走审批，
                这条是用户在直接操作这个浏览器、没有可审批的对象；但页面被换掉后 agent
                手里那份判断会过期，故主进程会顺带把这件事告知正在跑的 agent。 */}
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                data-browser-nav="back"
                onClick={() => onBrowserNav("back")}
                disabled={!canGoBack}
                title="后退"
                aria-label="后退"
                className="flex h-5 w-5 items-center justify-center rounded-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
              >
                <ChevronLeft {...ICON.xs} />
              </button>
              <button
                type="button"
                data-browser-nav="forward"
                onClick={() => onBrowserNav("forward")}
                disabled={!canGoForward}
                title="前进"
                aria-label="前进"
                className="flex h-5 w-5 items-center justify-center rounded-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
              >
                <ChevronRight {...ICON.xs} />
              </button>
              <button
                type="button"
                data-browser-nav="reload"
                onClick={() => onBrowserNav("reload")}
                disabled={!loaded}
                title="刷新"
                aria-label="刷新"
                className="flex h-5 w-5 items-center justify-center rounded-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary disabled:pointer-events-none disabled:opacity-35"
              >
                <RotateCw {...ICON.xs} />
              </button>
            </div>
            <Globe {...ICON.xs} className="shrink-0 text-text-muted" />
            {/* min-w-0 + flex-1：让地址先被截断，把位置留给右侧的联调标记——
                否则地址会把标记挤出可视区，那就成了「看不见的出口」（等于没有）。 */}
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary"
              title={browser?.title || url || undefined}
            >
              {loaded ? url || "about:blank" : "尚未加载"}
            </span>
            {/* 视口联调覆盖是**持久**状态（只在显式「恢复」时撤销），且会让原生视图比停靠区更大：
                实测 1280×800 的覆盖在 823×643 的停靠区里，右侧 209px 被窗口边缘裁掉、下方 157px
                压住观测抽屉。不给标记的话，用户只会以为渲染坏了。
                标记还必须**显眼到不会被漏看**：先前 10.5px、浅底、无边框那一版，用户复测时只报
                「还是超出了」，压根没注意到这行字——而它是这个状态的**唯一解释与唯一出口**，
                看不出来就等于没有出口。故加边框、抬字号、写明「联调视口」、把「恢复」做成实心按钮。
                按钮前景用 `accent-fg`：它是「实底之上的前景」令牌，深色主题下 warning 是亮琥珀（配近黑字）、
                亮色主题下是深琥珀（配白字），两个主题的对比度都够。
                但它**不能是 `shrink-0`**：标记一宽，窄栏下就会被挤出窗口右边（实测最窄 219 时
                「恢复」的命中测试取不到它——那就是一个「看得见字号、点不到」的假出口）。
                故标记本身可缩（`min-w-0`）、文案段 `truncate`、只有按钮 `shrink-0`：
                栏再窄也是「图标 + 恢复」，出口永远留在可视区内。 */}
            {override !== null && (
              <span
                data-browser-viewport={`${override.width}x${override.height}`}
                title={`响应式联调视口 ${override.width}×${override.height}（agent 设置）：页面按这个尺寸重排，超出停靠区的部分看不到。点「恢复」交还给按停靠区尺寸的自适应布局。`}
                className="flex min-w-0 items-center gap-1.5 rounded-sm border border-warning bg-warning-soft px-2 py-1 text-xs font-medium leading-none text-warning"
              >
                <MonitorSmartphone {...ICON.sm} className="shrink-0" />
                <span className="min-w-0 truncate">
                  联调视口{" "}
                  <span className="font-mono">
                    {override.width}×{override.height}
                  </span>
                </span>
                <button
                  type="button"
                  data-browser-viewport-reset=""
                  onClick={onResetViewport}
                  title="恢复自适应视口，交还给按停靠区尺寸的布局"
                  className="shrink-0 rounded-xs bg-warning px-1.5 py-[3px] text-xs font-semibold text-accent-fg transition hover:opacity-90"
                >
                  恢复
                </button>
              </span>
            )}
            {/* 「适应宽度」生效时的常驻指示 + 还原入口。
                必须**常驻**：页面一旦缩到装下，「装不下」那条横条就自己消失了（它只在还看得见
                被裁时才该在）——若把还原入口也放在那条横条上，用户一按「适应宽度」就再也找不到
                回去的路，等于给自己设了一个只能靠刷新页面才退得出的状态。
                它不进横条、常驻工具条：与联调标记抢的是一行里的同一个位置，但两者不会同时出现
                （联调覆盖生效时缩放恒为 1，见 browser-host 的 #applyFit）。 */}
            {zoom !== 1 && (
              <span
                data-browser-zoom={Math.round(zoom * 100)}
                title={`已按「适应宽度」等比缩到 ${Math.round(zoom * 100)}%，整页宽度都能看见；点「还原」回到 100%（页面会重新按停靠区尺寸重排）。`}
                className="flex min-w-0 items-center gap-1.5 rounded-sm border border-line bg-surface-overlay px-2 py-1 text-xs font-medium leading-none text-text-secondary"
              >
                <ZoomOut {...ICON.sm} className="shrink-0" />
                <span className="min-w-0 truncate font-mono">{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  data-browser-zoom-reset=""
                  onClick={() => onBrowserZoom(false)}
                  title="回到 100%"
                  className="shrink-0 rounded-xs bg-surface-raised px-1.5 py-[3px] text-xs font-semibold text-text-primary transition hover:bg-line"
                >
                  还原
                </button>
              </span>
            )}
          </div>
          {/* 页面装不下且够不到的说明。它**必须**占一条独立的横条而不是挤进 30px 的工具条：
              工具条那一行已经有地址与联调标记在抢位置，再塞一句长文案只会被截断成半个词，
              而半句话解释不了任何事。横在页面区域之上虽然吃掉约 20px 高，但换来的是一句读得完的话。
              横条同时是**出手的地方**：只解释不给出口，用户明知道右边被裁了也只能去拖窗口，
              而「拖窗口」在最小窗口下根本做不到（右栏上限就是那么宽）。故 100% 下直接给「适应宽度」。
              缩放已经生效却仍装不下时**不给按钮**：那时已经顶到最小可读比例，再按不会有任何变化，
              摆一个点了没反应的按钮比不给更伤信任（同 ⑦-F「死控件」的教训）。 */}
          {clippedX && (
            <div
              data-browser-clipped={`${needWidth}>${areaWidth}`}
              className="flex shrink-0 items-start gap-1.5 border-b border-warning/40 bg-warning-soft px-2.5 py-1.5 text-xs leading-relaxed text-warning"
            >
              <MoveHorizontal {...ICON.sm} className="mt-px shrink-0" />
              <span className="min-w-0 flex-1">
                {zoom === 1 ? (
                  <>
                    这个页面需要 {contentWidth}px 宽，可视区只有 {areaWidth}px，而它禁用了横向滚动——
                    右边 {contentWidth - areaWidth}px 现在看不到、也够不到。
                  </>
                ) : (
                  <>
                    已经缩到 {Math.round(zoom * 100)}%（再小就认不出字了）仍差 {needWidth - areaWidth}px——
                    这个页面本身就比停靠区宽，只能拖宽右栏或最大化窗口。
                  </>
                )}
              </span>
              {zoom === 1 && (
                <button
                  type="button"
                  data-browser-fit=""
                  onClick={() => onBrowserZoom(true)}
                  title="把整页等比缩小到能看见全部宽度；页面会变小，可随时在工具条上「还原」回 100%"
                  className="shrink-0 self-center rounded-xs bg-warning px-1.5 py-[3px] text-xs font-semibold text-accent-fg transition hover:opacity-90"
                >
                  适应宽度
                </button>
              )}
            </div>
          )}
          {loaded ? (
            <>
              {/* 这个 div 就是「页面区域」：主进程把 WebContentsView 精确摆在这个矩形上。
                  观测抽屉占的是它的高度，故抽屉一展开／收起，ResizeObserver 就会把新矩形报给主进程。
                  `data-browser-area` 是给冒烟用的稳定标记——「视图是否**精确**覆盖本区域」
                  只能靠两边各读一次来对，肉眼看不出（原生视图浮在渲染层之上）。
                  底色只在**视口联调**时会露出来（原生视图按覆盖尺寸摆放，盖不满本区域）：
                  给中性底而不是白，是为了让那一块一眼看出是「联调留白」而非页面没渲染出来。 */}
              <div
                ref={areaRef}
                data-browser-area=""
                className={cn("min-h-0 flex-1", override === null ? "bg-white" : "bg-surface-overlay")}
              />
              <ObserveDrawer sessionId={sessionId} />
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <Globe className="text-text-muted" style={{ width: 26, height: 26 }} />
              <p className="mt-2 text-sm text-text-secondary">浏览器尚未加载</p>
              <p className="max-w-[240px] text-xs leading-relaxed text-text-muted">
                agent 使用浏览器时会自动打开；在此之前不占用资源。
              </p>
            </div>
          )}
        </div>
      ) : activeKind === "files" ? (
        <FilesPanel sessionId={sessionId} />
      ) : activeKind === "terminal" ? (
        <TerminalPanel sessionId={sessionId} />
      ) : activeKind === "usage" ? (
        <UsagePanel sessionId={sessionId} />
      ) : activeKind === "rules" ? (
        <RulesPanel sessionId={sessionId} />
      ) : activeKind === "events" ? (
        <EventsPanel sessionId={sessionId} />
      ) : drillRequest !== null ? (
        /* 下钻中（⑦-G）：清单 → diff → 内容。只在「任务摘要」这一页签内成立 */
        <ChangeDrilldown
          sessionId={sessionId}
          changes={view?.fileChanges ?? []}
          subagents={view?.subagents ?? []}
          entry={drillRequest}
          highlightPath={highlightPath}
          menuOpen={menuOpen}
          onExit={() => setDrillRequest(null)}
        />
      ) : (
        <FollowPanel
          view={view}
          onOpenChanges={() => sendDrill({ layer: "list" })}
          onOpenStats={() => onOpenKind("usage")}
        />
      )}
    </aside>
  );
}
