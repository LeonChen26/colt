// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 长会话的「消息窗口」算术：**只挂最近一段**，更早的按需展开。
 *
 * 为什么要窗口：渲染成本与**挂载的条数**成正比，而且这个数可以很大。
 * 实测（冒烟 `perf`）一条消息 ≈ 25 个 DOM 节点、≈ 1.5ms；真实库里最长的那个会话
 * 有 **2937 条**可渲染消息（143 用户 + 2794 助手，带 2693 个工具结果）——
 * 一次性挂上去要**好几秒**，界面全程不能动。而其余会话都在 31 条以内，
 * 也就是说这是一条「几乎总是无所谓、偶尔卡到不能用」的路径。
 *
 * 这里只做算术，不知道 React 的存在（判据见 `tests/lib.test.ts` 的 `messageWindow` 两节）：
 * 把「窗口从哪开始」这件事从组件里挖出来，是为了让它的边界（空会话、比窗口还短、
 * 展开到底、流式追加时窗口要不要跟着挪）能被单测逐条钉死——这些正是最容易悄悄错的地方。
 *
 * 三处刻意选定的行为：
 * - **没有显式展开时「跟随底部」**（`FOLLOW_BOTTOM`）：窗口永远是**最新**的一段。
 *   流式期间新消息不断追加，窗口跟着走，用户看到的就是正在写的那一段。
 * - **显式展开之后不再跟随**：窗口起点变成一个具体下标，新消息只会在**末尾**把
 *   切片撑长，不会把用户正在读的那几行挤掉（那会表现为「内容在眼皮底下消失」）。
 * - **窗口起点只增不减**（除了切会话）：已经挂出来的内容不卸掉。卸载能省内存，
 *   但会让 `innerText` 一类的查询与「翻回去再看一眼」变得不可靠，
 *   而长会话真正难受的是**打开那一下**，不是长期内存。
 *
 * 外加一档**浮动段**（`windowEnd` 起）：跳到某一轮去看时，窗口既不能「跟到末尾」
 * （两千多条一起挂，等于没做窗口），也不该把用户钉在那儿——只挂目标那一小段，上下翻页。
 */

/** 首屏挂多少条消息；之后的「载入更早」也按这个粒度加 */
export const WINDOW_CHUNK = 50;

/**
 * 「跟随底部」——没有任何显式展开时窗口起点的哨兵值。
 * 用 `Infinity` 而不是 `-1`：下面的钳制直接取 `min`，哨兵自然落到「最新的那一段」上，
 * 不必为它写一条分支（少一条分支就少一处能写错的地方）。
 */
export const FOLLOW_BOTTOM = Number.POSITIVE_INFINITY;

/** 滚到距顶多少像素之内就自动再展开一段 */
export const LOAD_MORE_AT_TOP_PX = 24;

/** 距底多少像素之内算「停在底部」（与 `index.tsx` 的自动吸底同一个阈值） */
export const NEAR_BOTTOM_PX = 80;

/**
 * 窗口起点（含）：`[0, start)` 这段留在外面不挂。
 *
 * 两条钳制各自防一件事：
 * - `min(head, total - WINDOW_CHUNK)`：**任何情况下都不隐藏到少于一个窗口**。
 *   它同时兜住了「换会话但视图还是上一份」的中间态——那时 `head` 是按旧会话算的，
 *   只有这条钳制能在新会话比它短时把窗口拉回来（否则会 `slice` 出空列表）。
 * - `max(0, …)`：展开到底时起点就是 0。
 */
export function windowStart(total: number, head: number): number {
  const newest = Math.max(0, total - WINDOW_CHUNK);
  if (head === FOLLOW_BOTTOM) return newest;
  return Math.max(0, Math.min(head, newest));
}

/** 再往前展开一段（供「载入更早」与滚到顶时调用） */
export function earlierStart(total: number, head: number): number {
  return Math.max(0, windowStart(total, head) - WINDOW_CHUNK);
}

/** 还没挂出来的条数（= 窗口起点）；界面据此决定要不要给「载入更早」这个出口 */
export function hiddenCount(total: number, head: number): number {
  return windowStart(total, head);
}

/**
 * 这一次展开会补上多少条（= 当前起点 − 展开后的起点）。
 * 界面上的那个数字与它同源——各算一遍必然会漂（本仓有过这类翻车）。
 */
export function chunkSize(total: number, head: number): number {
  return windowStart(total, head) - earlierStart(total, head);
}

// ---- 浮动段：跳到某一轮去看 ----

/** 浮动段的上沿（不含）。不浮动时就是末尾——「一直挂到末尾」正是另外两档的行为 */
export function windowEnd(total: number, head: number, floating: boolean): number {
  if (!floating) return total;
  return Math.min(total, windowStart(total, head) + WINDOW_CHUNK);
}

/** 浮动段**下方**还有多少条。不浮动时恒为 0：下面就是末尾 */
export function belowCount(total: number, head: number, floating: boolean): number {
  return total - windowEnd(total, head, floating);
}

/** 浮动段往下翻一页 */
export function laterStart(total: number, head: number): number {
  const newest = Math.max(0, total - WINDOW_CHUNK);
  return Math.min(newest, windowStart(total, head) + WINDOW_CHUNK);
}

/** 跳到第 `index` 条所在的那一段。上界交给 `windowStart` 兜（它会钳到「不许少于一个窗口」） */
export function jumpHead(index: number): number {
  return Math.max(0, index);
}

/**
 * 往下翻一页之后的状态；**翻到底就不再浮动**，交回「跟随底部」。
 *
 * 这条不是优化而是必需：浮动段的下沿是定死的，翻到底若还保持浮动，
 * 之后流式追加的新消息会全部落在窗口外——表现为「明明已经在最新处，界面却不再更新」。
 */
export function afterLater(total: number, head: number): { head: number; floating: boolean } {
  const next = laterStart(total, head);
  if (belowCount(total, next, true) <= 0) return { head: FOLLOW_BOTTOM, floating: false };
  return { head: next, floating: true };
}
