/**
 * 右栏（`⑦`）宽度计算。
 *
 * 抽出来的理由不是「好看」，而是本仓库 `AGENTS.md` §3.3 记下的一次真实翻车：
 * 拖拽把手的宽度计算里，「取负」取错了对象（`const px = -raw` 而非只对**位移**取负），
 * 导致结果被钳到下限、拖拽看起来「完全没反应」。当时定的铁律是：
 * **涉及坐标/位移的计算，必须拿具体数值代入跑一遍** —— 而这段数学以前困在组件里
 * （`Conversation/index.tsx` 的 `useCallback`），`tests/` 零引用，根本没法验。
 *
 * 现在它是纯函数：入参进、数值出，不碰 DOM、不碰 React。
 */

/** 右栏宽度下限（规则 ⑦-B）：允许拖到接近折叠条，「正在处理」这类窄内容也够用 */
export const MIN_DOCK_WIDTH = 220;

/** 中栏可读下限：右栏最宽只能到「可用宽度 − 360」，否则会话流无法阅读（规则 ⑦-B） */
export const MIN_CENTER_WIDTH = 360;

/**
 * 把宽度钳到 `[MIN_DOCK_WIDTH, space − MIN_CENTER_WIDTH]`。
 *
 * `space` 是工作区可用宽度（`rootRef` 的 `clientWidth`）。空间过窄时上限会算到下限之下，
 * 此时以**下限**为准 —— 不让上下限打架（否则 `Math.min(max, ...)` 会产生比下限还小的值）。
 *
 * `space <= 0`（尚未量到宽度 / 元素未挂载）时只兜下限，不做上限判断。
 */
export function clampDockWidth(px: number, space: number): number {
  if (space <= 0) return Math.max(MIN_DOCK_WIDTH, px);
  const max = Math.max(MIN_DOCK_WIDTH, space - MIN_CENTER_WIDTH);
  return Math.min(Math.max(MIN_DOCK_WIDTH, px), max);
}

/**
 * 拖拽位移 → 未钳制的新宽度。
 *
 * 把手就在中栏↔右栏的边界上，所以**只对位移取负**：
 * 向左拖（`currentX < startX`）→ 右栏变宽；向右拖 → 变窄。
 *
 * ⚠️ 这里正是 §3.3 翻车的位置。当年写成「对不变量取负」（`-raw`，`raw` 里混了
 * `startWidth`），于是 300 宽 + 左拖 20 算出 −320、被钳到下限。
 * 正确做法是**先把两个量拆开**：位移 = `currentX − startX`，再从 `startWidth` 里减它。
 */
export function dockWidthFromDrag(startWidth: number, startX: number, currentX: number): number {
  const dx = currentX - startX;
  return startWidth - dx;
}
