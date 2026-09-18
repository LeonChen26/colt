/**
 * 轮次点链（④ 会话流的左缘）——把「会话目录」从浮层收成常驻的快速导航。
 *
 * 形态借鉴左栏的会话分支（点 + 活跃高亮），但语义是**目录**：
 * 只有 一条线性的点列、没有分叉；点击走 `history.jumpTo`——**只读定位**
 * （滚过去看，落成浮动段；绝不做 `session.navigate` 那种会分叉的跳转）。
 *
 * 交互四条：
 * - **离开顶部才浮现**：停在会话开头时没有「找历史」的需求，rail 反而碍事。
 * - **默认可见 11 个点**：rail 视口高度固定，轮次更多时 rail 自己滚
 *   （`overscroll-contain`：滚到头不带动外层会话滚动）。
 * - **悬停展示用户输入**：第 N 轮 + 提问摘要（`labelOf` 的输出）。
 *   tooltip 挂在**壳层**而不是点内——滚动容器会裁剪溢出的绝对定位后代，
 *   放点里会被裁掉；壳层不滚动，tooltip 用 JS 定到悬停点旁边。
 * - **当前点跟着会话滚动走**：可见行给的是消息 id，`turnAt` 归轮后高亮，
 *   当前点不在 rail 视口内时手动调 `rail.scrollTop`（不用 `scrollIntoView`——
 *   它会连带滚动外层会话容器，rail 联动反过来抢走用户正在读的位置）。
 *
 * 数据全在渲染层（同 HistoryPanel 的理由）：`messages` 整份已推过来，
 * rail 只做算术与 DOM 读数，零新 IPC。组件**自治**：自己挂 scroll 监听、
 * 自己算当前轮次，`index.tsx` 只需一行挂载——那是体量棘轮盯着的文件。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { outlineOf, turnAt, type OutlineItem } from "../../lib/session-outline";
import { cn } from "../../lib/utils";
import type { ViewMessage } from "@shared/worker-protocol";

/** 离开顶部多少像素后浮现 */
const SHOW_AFTER_PX = 120;
/** rail 视口里默认可见的点数（轮次更少时按实际数给） */
const VISIBLE_DOTS = 11;
/** 相邻两个点的步距（= 每个点的命中行高） */
const DOT_GAP = 18;
/** 视口的上下内边距：高度必须把它算进去（border-box），否则最后一个点会被底边裁掉一半 */
const RAIL_PAD = 3;

type Hovered = { turn: number; label: string; y: number };

export function TurnRail({
  messages,
  scrollRef,
  onJump,
}: {
  messages: ViewMessage[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onJump: (index: number) => void;
}): React.JSX.Element {
  const items = useMemo(() => outlineOf(messages), [messages]);
  // 可见行给的是消息 id，轮次算术吃的是下标——换算表按消息列表建
  const indexOfId = useMemo(() => new Map(messages.map((m, i) => [m.id, i] as const)), [messages]);

  const shellRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState(0); // 轮次号（1 起）；0 = 还没有可归的轮
  const [hovered, setHovered] = useState<Hovered | null>(null);

  // 最新值走 ref：scroll 监听只挂一次，回调永远读到最新的，不在流式期间反复挂卸
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const indexOfIdRef = useRef(indexOfId);
  indexOfIdRef.current = indexOfId;

  /** 由滚动容器的现状重算：显隐 + 当前轮次。rAF 节流，一帧至多一次 */
  const recompute = useCallback((): void => {
    const node = scrollRef.current;
    const shell = shellRef.current;
    if (node === null || shell === null) return;
    setVisible(node.scrollTop > SHOW_AFTER_PX);
    const nodeTop = node.getBoundingClientRect().top;
    // 视口顶部压着的第一条消息就是「正在看的」那条；窗口只挂一段，遍历的行数有限
    let visibleId: string | null = null;
    for (const row of node.querySelectorAll<HTMLElement>("[data-msg-row]")) {
      if (row.getBoundingClientRect().bottom > nodeTop + 1) {
        visibleId = row.getAttribute("data-msg-row");
        break;
      }
    }
    if (visibleId === null) return;
    const messageIndex = indexOfIdRef.current.get(visibleId);
    if (messageIndex === undefined) return;
    setCurrent(turnAt(itemsRef.current, messageIndex));
  }, [scrollRef]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    let raf = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    recompute();
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [scrollRef, recompute]);

  // 新消息追加不触发 scroll 事件，但当前轮次可能已经变了——随消息列表重算一次
  useEffect(() => {
    recompute();
  }, [messages, recompute]);

  // 当前点不在 rail 视口内时把它滚进来（居中）。只动 rail 自己的 scrollTop
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || current === 0) return;
    const dot = viewport.querySelector<HTMLElement>(`[data-turn="${current}"]`);
    if (dot === null) return;
    const viewportRect = viewport.getBoundingClientRect();
    const dotRect = dot.getBoundingClientRect();
    if (dotRect.top < viewportRect.top || dotRect.bottom > viewportRect.bottom) {
      viewport.scrollTop += dotRect.top - viewportRect.top - viewportRect.height / 2 + dotRect.height / 2;
    }
  }, [current]);

  const showTip = useCallback((item: OutlineItem, el: HTMLElement): void => {
    const shell = shellRef.current;
    if (shell === null) return;
    const y = el.getBoundingClientRect().top + el.offsetHeight / 2 - shell.getBoundingClientRect().top;
    setHovered({ turn: item.turn, label: item.label, y });
  }, []);

  // 高度 = 可见点数 × 步距 + 上下内边距：少算这 6px，第 11 个点会被底边裁掉一半
  // （实测 198 高只完整装下 10 个点，冒烟按「完整可见」数出来是 10 不是 11）
  const viewportHeight = Math.min(VISIBLE_DOTS, items.length) * DOT_GAP + RAIL_PAD * 2;

  return (
    <div
      ref={shellRef}
      data-turn-rail-shell
      onMouseLeave={() => setHovered(null)}
      className={cn(
        "absolute top-0 bottom-0 left-1 z-20 flex items-center transition-opacity duration-200",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <div
        ref={viewportRef}
        data-turn-rail
        className="scrollbar-none overflow-y-auto overscroll-contain rounded-full"
        style={{ height: viewportHeight, paddingBlock: RAIL_PAD }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-turn-rail-dot
            data-turn={item.turn}
            data-turn-index={item.index}
            data-current={item.turn === current ? "true" : undefined}
            onClick={() => onJump(item.index)}
            onMouseEnter={(event) => showTip(item, event.currentTarget)}
            title={`第 ${item.turn} 轮`}
            className="group relative flex items-center justify-center"
            style={{ height: DOT_GAP, width: 20 }}
          >
            <span
              className={cn(
                "block rounded-full transition-all",
                item.turn === current
                  ? "h-[9px] w-[9px] bg-accent"
                  : "h-[6px] w-[6px] bg-text-muted/60 group-hover:bg-text-secondary",
              )}
            />
          </button>
        ))}
      </div>

      {hovered !== null && (
        <div
          className="pointer-events-none absolute left-full z-30 ml-1.5 w-64 -translate-y-1/2 rounded-[8px] border border-line bg-surface-raised px-2.5 py-1.5 shadow-xl"
          style={{ top: hovered.y }}
        >
          <span className="block text-[10.5px] text-text-muted">第 {hovered.turn} 轮</span>
          <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-text-secondary">
            {hovered.label}
          </span>
        </div>
      )}
    </div>
  );
}
