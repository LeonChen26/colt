// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 消息渲染：消息气泡、思考轨、可展开的工具卡片（内嵌 diff）、流式光标。
 *
 * 布局对齐高保真：助手消息用左侧 46px 角色列 + 正文列；用户消息右对齐，
 * 角色标签在右。工具卡片走语义化图标 + 路径 + 增删行数 + 耗时 + 内嵌 diff。
 * 工具卡里若副标题**就是该工具操作的文件**，则该路径可点 → onOpenFile（A3-2「点任意文件路径」）。
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Eye,
  FileEdit,
  FilePlus,
  Globe,
  Monitor,
  PanelRight,
  ScrollText,
  Terminal,
  Wrench,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ViewFileChange, ViewMessage, ViewSubagent } from "@shared/worker-protocol";
import { mcpToolLabel } from "@shared/mcp-label";
import { Markdown } from "../../components/Markdown";
import { DiffView } from "../../components/DiffView";
import { SubagentPreview } from "./SubagentPreview";
import { TerminalOutput } from "../../components/TerminalOutput";
import { formatArgs, matchChangeByPath, parseArgsJson } from "../../lib/format";
import {
  afterLater,
  belowCount,
  chunkSize,
  earlierStart,
  FOLD_CHUNK,
  FOLLOW_BOTTOM,
  hiddenCount,
  jumpHead,
  LOAD_MORE_AT_TOP_PX,
  NEAR_BOTTOM_PX,
  windowEnd,
  windowStart,
  WINDOW_CHUNK,
} from "../../lib/message-window";
import { describeSteps, groupTurns, summarizeSteps, turnOfMessage } from "../../lib/turn-groups";
import { cn } from "../../lib/utils";

/**
 * 工具结果在渲染层的取值形态。`hasImage` 表示**图不在视图里**（已由 worker 落盘），
 * 展开卡片时用 `session.toolOutput` 读回；`image` 只用于落不了盘的图片类型。
 */
export type ToolResult = {
  output: string;
  isError: boolean;
  hasImage?: boolean;
  image?: { data: string; mimeType: string };
};

/** 按需读回的截图：三态分开，失败的原因要如实说（见 describeMissingImage） */
type FetchedImage =
  | { status: "loading" }
  | { status: "ok"; data: string; mimeType: string }
  | { status: "failed"; message: string };

/**
 * 读不回来的原因 → 界面上该说的话。
 * **不能一律说「没有」**：那会把「文件太大没保留」和「读盘失败」都说成「本来就没图」，
 * 用户据此得出的是错的结论（`docs/ERRORS.md` 的不许静默）。
 */
function describeMissingImage(status: "missing" | "too-large" | "unreadable"): string {
  if (status === "too-large") return "截图过大，未随会话保留";
  if (status === "unreadable") return "截图读取失败";
  return "截图已不可用";
}

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

/**
 * 一条消息：正文 + 其发起的工具调用卡片。
 *
 * 包 `memo` 是因为流式期间视图每 50ms 整份重推一次（`ConversationView` 是全量快照）：
 * 不包的话**每条消息**都要跟着重渲染，实测 370 条时每帧 544ms（约 5fps）、
 * 而那 370 条里真正变的往往只有 1 条。
 *
 * 敢用**默认浅比较**（而不是自定义比较器）的前提是 props 的对象引用已被
 * `useStableView` 稳定住；自定义比较器漏比一个字段就等于静默不更新，
 * 这类错比「慢」难查得多。
 *
 * 已知代价：`openState` 换引用（用户点开合某张卡）时整列表会重渲染一次。
 * 它由点击触发、不在流式路径上；要消掉得把开合状态按消息切片下发，收益不抵复杂度。
 */
export const MessageBubble = memo(function MessageBubble({
  sessionId,
  message,
  resultMap,
  changes,
  subagents,
  onHoverFile,
  onOpenFile,
  onOpenSubagent,
  onAbortSubagent,
  openState,
  onToggleOpen,
}: {
  /** 会话 id：工具卡按需读回落盘截图时要带上它（见 ToolCard） */
  sessionId: string;
  message: ViewMessage;
  resultMap: Map<string, ToolResult>;
  changes: ViewFileChange[];
  /** `toolCallId → 子代理`：`subagent` 那次调用据此特化成子代理卡 */
  subagents: ReadonlyMap<string, ViewSubagent>;
  onHoverFile?: (path: string | null) => void;
  /** 点工具卡里的文件路径 → 在右栏预览它（A3-2） */
  onOpenFile?: (path: string) => void;
  /** 点子代理卡上的「在右栏查看完整过程」→ 下钻到它的完整流 */
  onOpenSubagent?: (id: string) => void;
  /** 点运行中子代理卡上的「中止」→ 只收掉这一个子代理 */
  onAbortSubagent?: (id: string) => void;
  /** 工具卡展开状态共享表（键 = 工具调用 id），与流式区共用，完成迁移时不丢展开态 */
  openState: ReadonlyMap<string, boolean>;
  /** 卡片改了展开状态 → 回传容器（唯一真源在 `Conversation`） */
  onToggleOpen: (id: string, open: boolean) => void;
}): React.JSX.Element | null {
  // 只渲染用户与助手：工具结果已合并进各自的工具卡片（它根本不在 messages 里，
  // 见 ViewMessage.role），`other` 这类结构性消息也不单独成条
  if (message.role !== "user" && message.role !== "assistant") return null;
  // 只带图片、没有文字的消息也必须渲染
  if (!message.text && !message.image && message.toolCalls.length === 0) return null;

  if (message.role === "user") {
    // 技能调用**不是用户说的话**：正文是内核塞进来的（还带着 `<skill …>` 这层原始 XML），
    // 署名不能是「你」、也不该把整篇正文摊在对话流里。画成一张折叠卡：卡面给
    // 「哪个技能 + 那半句额外指示」，正文默认收起、可展开——展开是为了**归属透明**，
    // 用户有权看到模型实际收到了什么（`ViewMessage.skill` 是 worker 认出来的）。
    if (message.skill !== undefined) {
      const { name, instructions } = message.skill;
      const open = openState.get(message.id) === true;
      return (
        <div className="flex justify-start" data-conv-skill={message.id}>
          <div className="flex max-w-[86%] flex-col gap-1.5 rounded-[8px] border border-l-[3px] border-line border-l-accent-dim bg-surface-raised px-3 py-2">
            <div className="flex items-center gap-1.5 text-[12px]">
              <ScrollText {...ICON.sm} className="shrink-0 text-accent-dim" />
              <span className="font-medium text-text-primary">技能 {name}</span>
              <span className="text-text-muted">· 本会话装载，非你的发言</span>
            </div>
            {instructions !== undefined && (
              <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-text-primary">
                {instructions}
              </p>
            )}
            <button
              type="button"
              data-conv-skill-toggle={message.id}
              onClick={() => onToggleOpen(message.id, !open)}
              className="flex items-center gap-1 self-start text-[11px] text-text-muted transition hover:text-text-primary"
            >
              <ChevronRight {...ICON.xs} className={open ? "shrink-0 rotate-90" : "shrink-0"} />
              {open ? "收起技能正文" : "展开技能正文"}
            </button>
            {open && (
              <pre
                data-conv-skill-body={message.id}
                className="max-h-72 overflow-auto rounded-[6px] border border-line bg-surface-overlay px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-text-muted"
              >
                {message.text}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-end" data-conv-user={message.id}>
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
          sessionId={sessionId}
          openId={call.id}
          openState={openState}
          onToggleOpen={onToggleOpen}
          name={call.name}
          args={call.args}
          durationMs={call.durationMs}
          skill={call.skill}
          result={resultMap.get(call.id)}
          subagent={subagents.get(call.id)}
          change={matchChangeByPath(changes, parseArgsJson(call.args).path)}
          onHoverFile={onHoverFile}
          onOpenFile={onOpenFile}
          onOpenSubagent={onOpenSubagent}
          onAbortSubagent={onAbortSubagent}
        />
      ))}
    </AssistantRow>
  );
});

/** 窗口的两档单位。折叠与否决定用哪一档——见 `MessageWindow` 里 `unit` 那一段 */
type WindowUnit = "message" | "turn";

/**
 * 消息窗口：长会话只挂最近一段，更早的按需展开（算术见 `@/lib/message-window`）；
 * 「只看问答」时再把每轮的**过程**收成一行（分组见 `@/lib/turn-groups`）；
 * 从目录跳到某一轮时切到**浮动段**——只挂目标那一小段，上下都能继续翻。
 *
 * 为什么需要窗口：渲染成本与**挂载条数**成正比，而真实库里最长的那个会话有近 3000 条
 * 可渲染消息（带 2600+ 个工具卡）——一次性挂上去要好几秒、界面全程不能动。
 * 而绝大多数会话在 31 条以内，窗口对它们是**零影响**（还没到一个窗口）。
 *
 * 为什么需要折叠：一轮十几个工具调用就是十几行，正文被中间步骤淹掉。规则 ④-C 要求卡片
 * **不可省略、不可简化成一行纯文本**，所以收起来的那一行必须是**可展开的入口**，不是把卡片删掉。
 *
 * 三个容易做错的地方，这里都显式处理：
 * - **上翻时先把窗口钉住**：否则流式期间新消息一来、窗口跟着底部挪，
 *   用户正在读的那几行会被卸掉——表现为「内容在眼皮底下消失」。
 * - **展开时补偿滚动位置**：更早的条目插在**上方**，会把视野整体往下推，
 *   不补的话每展开一次就跳一次。
 * - **「过程」展开过的轮要记住**：展开态按**轮键**存，而不是按消息下标——
 *   流式追加会让下标整体漂移，按下标记等于「展开的轮自己换了一个」。
 *
 * 外加一条：「只看问答」换的是窗口的**单位**（条 ↔ 轮，见 `message-window.ts` 的 `FOLD_CHUNK`），
 * 而两种单位下窗口能装的范围差一个量级，所以**每种单位各记一份起点**、切回来原样还回去——
 * 见下面 `heads` 那一段。
 */
export function MessageWindow({
  sessionId,
  messages,
  resultMap,
  changes,
  subagents,
  onHoverFile,
  onOpenFile,
  onOpenSubagent,
  onAbortSubagent,
  openState,
  onToggleOpen,
  scrollRef,
  folded,
  jump,
  followNonce,
}: {
  sessionId: string;
  messages: ViewMessage[];
  resultMap: Map<string, ToolResult>;
  changes: ViewFileChange[];
  /** `toolCallId → 子代理`（④ 卡特化用；引用由 `useStableView` 稳定住） */
  subagents: Map<string, ViewSubagent>;
  onHoverFile?: (path: string | null) => void;
  onOpenFile?: (path: string) => void;
  onOpenSubagent?: (id: string) => void;
  onAbortSubagent?: (id: string) => void;
  openState: ReadonlyMap<string, boolean>;
  onToggleOpen: (id: string, open: boolean) => void;
  /** 消息流的滚动容器：窗口要知道滚到哪了，补一段/翻页时也要自己摆 `scrollTop` */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 「只看问答」：把每轮的过程（思考 + 工具卡）收成一行 */
  folded: boolean;
  /** 目录里点的某一轮：`nonce` 每次点击都变，用来认出「这是一次新请求」 */
  jump: { index: number; nonce: number } | null;
  /** 每次自增表示「回到底部」被按了一次——窗口据此从浮动段交回「跟随底部」 */
  followNonce: number;
}): React.JSX.Element {
  /**
   * 窗口起点，**每种单位各记一份**。
   *
   * 为什么不是一个数：折叠改的是「窗口按什么数」，同一个数字在两种单位下含义完全不同——
   * 只留一份的话，切模式时它要么被按新单位误读（位置乱跑），要么被换算到别处，来回切两下就回不到原处。
   * 这正是 `AGENTS.md` 点过名的「按字段名猜语义」，所以这里干脆按单位各存一个。
   *
   * 为什么「轮 → 条」不是换算而是**还回去**：折叠窗口一轮一轮地铺开，起点通常落在两三百条之前，
   * 而条的预算只有 50——换算不回去。反过来，「条」的那一份**从没被折叠动过**，
   * 所以展开时把它原样还回去，结果就等于「这个开关从没被碰过」——那正是开关该有的样子：
   * 关掉它，看到的就是打开它之前的那一屏（`perf` 冒烟有一条断言专核这件事）。
   * 折叠期间在轮世界里翻过的地方，回到条世界不作数——条的预算本来就装不下它。
   */
  const [heads, setHeads] = useState<Record<WindowUnit, number>>({
    message: FOLLOW_BOTTOM,
    turn: FOLLOW_BOTTOM,
  });
  /** 浮动段：跳到某一段之后只挂 `[起点, 起点 + 一个窗口)`，不再一直挂到末尾 */
  const [floating, setFloating] = useState(false);

  /** 整份消息的轮分组：折叠态要按轮切窗口，换算起点也要靠它 */
  const turns = useMemo(() => groupTurns(messages), [messages]);
  /** 当前单位。**由折叠开关决定**，不另存一份，免得又多一处可能不一致的状态 */
  const unit: WindowUnit = folded ? "turn" : "message";
  /** 当前单位下的总量：折叠时是**轮数**，否则是条数 */
  const total = unit === "turn" ? turns.length : messages.length;
  const chunk = unit === "turn" ? FOLD_CHUNK : WINDOW_CHUNK;
  /** 界面上「还有 N ___」那个量词：单位是给人看的，必须跟着换 */
  const unitWord = unit === "turn" ? "轮" : "条";
  const head = heads[unit];

  /**
   * 切模式的那一次渲染：把「轮」的起点按**当前这一屏**重算一遍（「条」那一份不动，理由见上）。
   *
   * 哨兵要保住——「跟随底部」时若换算成一个具体轮号，窗口就不再跟着最新消息走了。
   * 写在**渲染期**（不放进 effect）：effect 会先按旧单位提交一帧，那一帧的窗口范围是错的。
   */
  const prevUnit = useRef<WindowUnit>(unit);
  if (prevUnit.current !== unit) {
    prevUnit.current = unit;
    if (unit === "turn") {
      setHeads((current) => ({
        ...current,
        turn:
          current.message === FOLLOW_BOTTOM
            ? FOLLOW_BOTTOM
            : turnOfMessage(messages, windowStart(messages.length, current.message)),
      }));
    }
  }

  /**
   * 窗口起点（= 还没挂出来的条数/轮数）。**只算一次**：切片边界与界面上「还有 N」必须是同一个数——
   * 各算一遍必然会漂（本仓有过这类翻车）。
   */
  const start = hiddenCount(total, head, chunk);
  const end = windowEnd(total, head, floating, chunk);
  const below = belowCount(total, head, floating, chunk);

  /**
   * 这次改动提交后要怎么摆滚动位置。四种意图的摆法完全不同，写成一种就会「跳一下」：
   * - `extend`：往上补了一段，把新增的高度补回 `scrollTop`（视线**不动**）
   * - `bottom`：往上翻页，落到新页**底部**——视线是连续的（正在读的那句还在眼前）
   * - `top`：往下翻页，落到新页顶部，接着往下读
   * - `row`：跳到某一条，把它对到视口顶部
   */
  const pending = useRef<
    | { kind: "extend"; before: number }
    | { kind: "bottom" }
    | { kind: "top" }
    | { kind: "row"; id: string }
    | null
  >(null);

  /** 见下面 `onScroll` 的 ②：保证**一次上翻只补一段** */
  const armed = useRef(false);

  const loadEarlier = useCallback((): void => {
    pending.current = floating
      ? { kind: "bottom" }
      : { kind: "extend", before: scrollRef.current?.scrollHeight ?? 0 };
    setHeads((current) => ({ ...current, [unit]: earlierStart(total, current[unit], chunk) }));
  }, [chunk, floating, scrollRef, total, unit]);

  const loadLater = useCallback((): void => {
    const next = afterLater(total, head, chunk);
    pending.current = { kind: "top" };
    armed.current = false;
    setHeads((current) => ({ ...current, [unit]: next.head }));
    setFloating(next.floating);
  }, [chunk, head, total, unit]);

  /** 从浮动段回到**真正的**底部（会同时交回「跟随底部」，否则新消息会落在窗口外） */
  const gotoLatest = useCallback((): void => {
    pending.current = { kind: "bottom" };
    armed.current = false;
    setHeads((current) => ({ ...current, [unit]: FOLLOW_BOTTOM }));
    setFloating(false);
  }, [unit]);

  useLayoutEffect(() => {
    const intent = pending.current;
    pending.current = null;
    const node = scrollRef.current;
    if (intent === null || node === null) return;
    if (intent.kind === "extend") {
      node.scrollTop += node.scrollHeight - intent.before;
      return;
    }
    if (intent.kind === "bottom") {
      node.scrollTop = node.scrollHeight;
      return;
    }
    if (intent.kind === "top") {
      node.scrollTop = 0;
      return;
    }
    node.querySelector<HTMLElement>(`[data-msg-row="${intent.id}"]`)?.scrollIntoView({ block: "start" });
  }, [start, end, scrollRef]);

  /**
   * 两件都在滚动里做的事：
   * ① **离开底部就把窗口钉住**——否则流式期间新消息一来、窗口跟着底部挪，
   *    用户正读的那几行会被卸掉（表现为「内容在眼皮底下消失」）。幂等，写回同一个值不触发渲染。
   * ② **贴到顶就自动再补一段**。`armed` 保证**一次上翻只补一段**：补完的位置摆法
   *    会把 `scrollTop` 挪开顶（补偿是往下、翻页是到底），要再上翻一次才会再次触发。
   */
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const onScroll = (): void => {
      if (node.scrollHeight - node.scrollTop - node.clientHeight > NEAR_BOTTOM_PX) {
        setHeads((current) =>
          current[unit] === FOLLOW_BOTTOM
            ? { ...current, [unit]: windowStart(total, current[unit], chunk) }
            : current,
        );
      }
      if (node.scrollTop > LOAD_MORE_AT_TOP_PX) {
        armed.current = true;
      } else if (armed.current) {
        armed.current = false;
        loadEarlier();
      }
    };
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, [chunk, loadEarlier, scrollRef, total, unit]);

  /**
   * 目录里点了某一轮。`nonce` 挡住「同一次请求被重放」：这个 effect 依赖 `messages`，
   * 而流式期间它每 50ms 就换一次——不挡的话会把用户正在读的位置每秒拽回去几十次。
   */
  const handledJump = useRef(0);
  useEffect(() => {
    if (jump === null || jump.nonce === handledJump.current) return;
    const target = messages[jump.index];
    if (target === undefined) return;
    handledJump.current = jump.nonce;
    armed.current = false;
    pending.current = { kind: "row", id: target.id };
    // 目录与搜索给的是**消息**下标；折叠时窗口按轮记，先换成轮下标再交给窗口
    setHeads((current) => ({
      ...current,
      [unit]: unit === "turn" ? turnOfMessage(messages, jump.index) : jumpHead(jump.index),
    }));
    setFloating(true);
  }, [jump, messages, unit]);

  /**
   * 「回到底部」被按下。只在**浮动段**里才需要它做额外的事——那时容器的「底」不是会话的底，
   * 光滚过去只会停在一段旧内容上。不浮动时这里什么都不做，保持原有的「只是滚一下」。
   */
  const handledFollow = useRef(0);
  useEffect(() => {
    if (followNonce === handledFollow.current) return;
    handledFollow.current = followNonce;
    if (followNonce === 0 || !floating) return;
    gotoLatest();
  }, [followNonce, floating, gotoLatest]);

  /**
   * 挂出来的那些轮（渲染就照着它铺）。
   * 折叠时窗口本来就按轮切，边界自然落在整轮上；不折叠时按条切，边界可能落在轮中间，
   * 切出来的第一轮就是半截——那是「按条计数」的固有代价，维持原样。
   */
  const visibleTurns = useMemo(
    () => (unit === "turn" ? turns.slice(start, end) : groupTurns(messages.slice(start, end))),
    [unit, turns, messages, start, end],
  );

  /** 被手动展开过过程的轮（键 = 轮键）。空集 = 全收着，这是「只看问答」的常态 */
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const toggleTurn = useCallback((key: string): void => {
    setExpandedTurns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** 一行 = 一条消息。每行套一层带标记的容器：冒烟要能**按行**数「挂了多少条」、
   *  也要认得出挂的是哪几条。这层是给探针用的稳定锚点（别让用例靠层级去猜，见 AGENTS.md §五 ⑫）。 */
  const row = (message: ViewMessage): React.JSX.Element => (
    <div key={message.id} data-msg-row={message.id}>
      <MessageBubble
        sessionId={sessionId}
        message={message}
        resultMap={resultMap}
        changes={changes}
        subagents={subagents}
        onHoverFile={onHoverFile}
        onOpenFile={onOpenFile}
        onOpenSubagent={onOpenSubagent}
        onAbortSubagent={onAbortSubagent}
        openState={openState}
        onToggleOpen={onToggleOpen}
      />
    </div>
  );

  return (
    <>
      {(start > 0 || below > 0 || floating) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {start > 0 && (
            <button
              type="button"
              data-conv-earlier
              onClick={loadEarlier}
              className="rounded-[6px] border border-line px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:border-line-strong hover:text-text-primary"
            >
              载入更早的 {chunkSize(total, head, chunk)} {unitWord}（还有 {start} {unitWord}）
            </button>
          )}
          {below > 0 && (
            <button
              type="button"
              data-conv-later
              onClick={loadLater}
              className="rounded-[6px] border border-line px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:border-line-strong hover:text-text-primary"
            >
              载入更晚的 {Math.min(chunk, below)} {unitWord}（还有 {below} {unitWord}）
            </button>
          )}
          {/* 浮动段的「底」不是会话的底：得给一个回到**真正**末尾的出口，
              否则用户只能一格一格往后翻到最新 */}
          {floating && (
            <button
              type="button"
              data-conv-latest
              onClick={gotoLatest}
              className="rounded-[6px] border border-line px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:border-line-strong hover:text-text-primary"
            >
              回到最新
            </button>
          )}
        </div>
      )}
      {/* 一轮一轮地挂。折叠打开时，一轮的「过程」收成一行**可展开的入口**——
          规则 ④-C 要求工具卡不可省略、不可简化成一行纯文本，收起来也不能是把它删掉。 */}
      {visibleTurns.map((turn) => (
        <Fragment key={turn.key}>
          {turn.user !== null && row(turn.user)}
          {folded && turn.steps.length > 0 && !expandedTurns.has(turn.key) ? (
            <AssistantRow>
              <button
                type="button"
                data-conv-steps-summary={turn.key}
                onClick={() => toggleTurn(turn.key)}
                title="这一轮的中间步骤已收起，点开看思考与工具调用"
                className="flex items-center gap-1.5 self-start rounded-[8px] border border-line bg-surface-raised px-3 py-2 text-[12px] text-text-muted transition hover:border-line-strong hover:text-text-primary"
              >
                <ChevronRight {...ICON.sm} className="shrink-0" />
                {describeSteps(summarizeSteps(turn.steps))}
              </button>
            </AssistantRow>
          ) : (
            <>
              {folded && turn.steps.length > 0 && (
                <AssistantRow>
                  {/* 收起入口留在原处（过程上方），展开/收起时这一行不跳位 */}
                  <button
                    type="button"
                    data-conv-steps-collapse={turn.key}
                    onClick={() => toggleTurn(turn.key)}
                    className="flex items-center gap-1.5 self-start text-[12px] text-text-muted transition hover:text-text-secondary"
                  >
                    <ChevronRight {...ICON.sm} className="shrink-0 -rotate-90" />
                    收起过程
                  </button>
                </AssistantRow>
              )}
              {turn.steps.map(row)}
            </>
          )}
          {turn.final !== null && row(turn.final)}
        </Fragment>
      ))}
    </>
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
    // 子代理：副标题给任务（与 ④ 子代理卡的状态说的是同一件事）。**认领不到那条总账时**
    // （被 `MAX_FINISHED_SUBAGENTS` 淘汰了）走的就是这一支，别让它退化成一排空白。
    case "subagent": {
      const title = typeof args.title === "string" ? args.title : undefined;
      const task = typeof args.task === "string" ? args.task : undefined;
      return { icon: <Bot {...ICON.sm} />, subtitle: title ?? task };
    }
    default:
      return { icon: <Wrench {...ICON.sm} />, subtitle: path ?? command };
  }
}

/** 耗时展示：<1s 用毫秒，否则保留一位小数 */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 子代理终态的界面措辞（四种状态都要有名字——颜色只是辅助） */
function subagentStatusLabel(status: ViewSubagent["status"]): string {
  if (status === "running") return "运行中";
  if (status === "completed") return "完成";
  if (status === "aborted") return "已中止";
  return "失败";
}

/** 可展开的工具调用卡片：折叠时显示名称 + 参数摘要 + 增删/耗时 */
export function ToolCard({
  sessionId,
  name,
  args,
  result,
  durationMs,
  skill,
  subagent,
  change,
  running,
  openId,
  openState,
  onToggleOpen,
  onHoverFile,
  onOpenFile,
  onOpenSubagent,
  onAbortSubagent,
}: {
  /** 会话 id（按需读回落盘截图用） */
  sessionId: string;
  name: string;
  args: string;
  result?: ToolResult;
  durationMs?: number;
  /**
   * 这次 `read` 读的是某个已装载技能的文件（P3）。
   *
   * 模型不会「调用技能」——它读了技能描述后自觉去读技能文件，界面上原本只会多一张
   * 普通 `read` 卡，看不出这次读文件是技能驱动的。这个标记由 worker 投影时判定（技能路径
   * 集合在它内存里），这里只负责画一个「技能 X」徽标。
   */
  skill?: string;
  /**
   * 这次调用是个子代理（按 `toolCallId` 认领）。有它时本卡片**特化**：
   * 标题变成「子代理 · <名字>」，展开是有界预览 + 「在右栏查看完整过程」。
   */
  subagent?: ViewSubagent;
  change?: ViewFileChange;
  running?: boolean;
  /** 展开 state 共享表里的键（工具调用 id） */
  openId: string;
  /** 展开状态的唯一真源（在 `Conversation`）；本组件只读，不留本地副本 */
  openState: ReadonlyMap<string, boolean>;
  /** 改动展开状态 → 回传真源 */
  onToggleOpen: (id: string, open: boolean) => void;
  onHoverFile?: (path: string | null) => void;
  /** 点副标题里的文件路径 → 在右栏预览它（A3-2） */
  onOpenFile?: (path: string) => void;
  /** 点子代理卡的「在右栏查看完整过程」→ 下钻到它的完整流 */
  onOpenSubagent?: (id: string) => void;
  /** 点运行中子代理卡上的「中止」→ 只收掉这一个子代理（不动主对话与其它子代理） */
  onAbortSubagent?: (id: string) => void;
}): React.JSX.Element {
  /**
   * 展开状态**不放在本组件里**：同一个工具调用在「流式区」与「完成态消息」是两次挂载，
   * 本地 state 会让两个实例各持一份开合（改一个另一个不动），
   * 且完成迁移时新建的实例只会「挂载时取一次初值」，等于把挂载时机当成真源。
   *
   * 未记录过时按运行状态给初值：运行中默认展开（用户在看实时输出），
   * 已完成默认收起（结果已定，不必占屏）。
   */
  const open = openState.get(openId) ?? Boolean(running);
  const setOpen = (value: boolean): void => {
    onToggleOpen(openId, value);
  };
  /**
   * 截图按需取：视图里只留了 `hasImage` 标记（图片本身由 worker 落盘，见 `@shared/tool-output`），
   * **展开时才读回来**，且只进本组件的 state、不回填视图——它是展示数据，不该再被反复搬运。
   */
  const inlineImage = result?.image;
  const needsFetch = inlineImage === undefined && result?.hasImage === true;
  const [fetchedImage, setFetchedImage] = useState<FetchedImage | null>(null);
  useEffect(() => {
    if (!open || !needsFetch) return;
    let stale = false;
    setFetchedImage({ status: "loading" });
    void window.colt
      .invoke("session.toolOutput", { sessionId, toolCallId: openId })
      .then((res) => {
        if (stale) return;
        setFetchedImage(
          res.status === "ok"
            ? { status: "ok", data: res.image.data, mimeType: res.image.mimeType }
            : { status: "failed", message: describeMissingImage(res.status) },
        );
      })
      .catch((error: unknown) => {
        if (stale) return;
        setFetchedImage({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      stale = true;
    };
  }, [open, needsFetch, sessionId, openId]);
  const imageSrc =
    inlineImage !== undefined
      ? `data:${inlineImage.mimeType};base64,${inlineImage.data}`
      : fetchedImage?.status === "ok"
        ? `data:${fetchedImage.mimeType};base64,${fetchedImage.data}`
        : undefined;
  const parsed = useMemo(() => parseArgsJson(args), [args]);
  const base = describeTool(name, parsed);
  /**
   * 子代理卡：`subagent` 这次调用**且**它在视图总账里（按 toolCallId 认领）。
   * 认领不到时按普通工具卡渲染——宁可退化成一张普通卡，也不要凭空造一张卡。
   */
  const card = name === "subagent" ? subagent : undefined;
  const icon = card === undefined ? base.icon : <Bot {...ICON.sm} />;
  // 子代理没有路径/命令可言，副标题用任务摘要
  const subtitle = card === undefined ? base.subtitle : card.title;
  const subagentElapsed =
    card?.endedAt === undefined ? undefined : card.endedAt - card.startedAt;
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
      data-tool-card=""
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
            {card === undefined ? mcpToolLabel(name) ?? name : `子代理 · ${card.name}`}
          </span>
          {/* P3：这次读的是技能文件——模型「自己想起来用技能」的唯一可见信号 */}
          {skill !== undefined && (
            <span
              data-tool-skill={skill}
              title={`这次读取的是技能「${skill}」的文件`}
              className="flex shrink-0 items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] text-accent-dim"
            >
              <ScrollText {...ICON.xs} />
              技能 {skill}
            </span>
          )}
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
          {card !== undefined ? (
            <span
              data-subagent-card-status={card.status}
              className={cn(
                "flex items-center gap-1.5",
                card.status === "running"
                  ? "text-text-secondary"
                  : card.status === "completed"
                    ? "text-success"
                    : "text-danger-fg",
              )}
            >
              {card.status === "running" && <span className="live-dot" />}
              {subagentStatusLabel(card.status)}
              {subagentElapsed !== undefined && ` ${formatDuration(subagentElapsed)}`}
            </span>
          ) : running ? (
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
          {/* 子代理跑偏时就地收掉它（原在「任务摘要」此刻段，v1.53 挪到卡上）：
              与卡面自己的展开按钮是**兄弟**（不是嵌套），点它不会顺带开合卡片。
              只在运行中给——已经结束的卡上放一个点了没反应的按钮就是死控件。 */}
          {card !== undefined && card.status === "running" && onAbortSubagent !== undefined && (
            <button
              type="button"
              data-subagent-abort={card.id}
              onClick={() => onAbortSubagent(card.id)}
              title="中止这个子代理（不影响主对话与其它子代理）"
              className="shrink-0 rounded-[4px] px-1 text-[10.5px] text-text-muted transition hover:bg-surface-overlay hover:text-danger-fg"
            >
              中止
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className="border-t border-line bg-surface p-2">
          {card !== undefined ? (
            <>
              {/* 出口在**前**：预览可能有十来步，把唯一的深看入口排在末尾等于把它藏起来
                  （`⑦-H` 的「附属视图给结论不给流水」，出口本身就要好找） */}
              {onOpenSubagent !== undefined && (
                <button
                  type="button"
                  data-subagent-open={card.id}
                  onClick={() => onOpenSubagent(card.id)}
                  className="mb-2 flex items-center gap-1 rounded-[5px] border border-line px-2 py-1 text-[11px] text-text-secondary transition hover:border-line-strong hover:text-text-primary"
                >
                  <PanelRight {...ICON.xs} />
                  在右栏查看完整过程
                </button>
              )}
              <SubagentPreview subagent={card} />
              {result?.output ? (
                <>
                  <div className="mt-2 mb-1 text-[11px] text-text-muted">
                    作为工具结果回到主对话的内容
                  </div>
                  <pre className="max-h-60 overflow-auto rounded-[6px] bg-surface-code px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-text-secondary">
                    {result.output}
                  </pre>
                </>
              ) : null}
            </>
          ) : change?.patch ? (
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
                  {imageSrc !== undefined ? (
                    <img
                      alt="工具截图"
                      className="mb-2 max-h-80 rounded-[6px] border border-line"
                      src={imageSrc}
                    />
                  ) : needsFetch ? (
                    <p className="mb-2 px-1 text-[11px] text-text-muted">
                      {fetchedImage?.status === "failed" ? fetchedImage.message : "正在读取截图…"}
                    </p>
                  ) : null}
                  {result.output ? (
                    name === "bash" ? (
                      <TerminalOutput text={result.output} className="max-h-80" />
                    ) : (
                      <pre className="max-h-80 overflow-auto rounded-[6px] bg-surface-code px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-text-secondary">
                        {result.output}
                      </pre>
                    )
                  ) : imageSrc !== undefined || needsFetch ? null : (
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

