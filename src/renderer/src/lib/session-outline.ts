/**
 * 会话目录（提问列表）与历史搜索——都只在**已经拿到的视图**上做算术。
 *
 * 为什么不走主进程接口：`ConversationView` 本来就整份推给渲染层（流式期间每 50ms 一次），
 * 消息窗口限制的只是**挂多少**、不是**拿到多少**。所以目录与搜索是纯客户端的，
 * 既不需要新的 IPC，也不需要让 worker 参与——一条「按内容找历史」的路不该牵动会话进程。
 *
 * 判据同 `turn-groups.ts`：只做算术、不知道 React，边界（空会话、只有图片没文字、
 * 超长提问、命中在开头/结尾、查询为空）才能被单测逐条钉死。
 */
import type { ViewMessage } from "@shared/worker-protocol";

/** 目录里一行显示多少字（界面上就是一行，多了只能截） */
export const LABEL_MAX = 72;

/** 搜索命中处两侧各留多少字符做上下文 */
export const SNIPPET_RADIUS = 30;

export type OutlineItem = {
  /** 该消息在 `messages` 里的下标——跳转就是把它换成窗口起点 */
  index: number;
  id: string;
  /** 提问摘要（单行） */
  label: string;
  /** 第几轮，从 1 开始（供界面显示「第 N / M 轮」） */
  turn: number;
};

export type SearchHit = {
  index: number;
  id: string;
  role: ViewMessage["role"];
  /** 命中处的上下文 */
  snippet: string;
};

/**
 * 取一行摘要：**第一行非空文字**、把连续空白压平、超长截断。
 *
 * 取第一行而不是整段：提问动辄几十行，界面上那一行要给的是「我要找的是哪一问」，
 * 开头几个字的信息量最大（人写东西也是把主旨放最前面）。
 */
export function labelOf(text: string, max = LABEL_MAX): string {
  const line = text.split("\n").find((row) => row.trim() !== "") ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 目录：只列**用户提问**，一条一轮 */
export function outlineOf(messages: ViewMessage[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  let turn = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    turn += 1;
    // 只有图片、没有文字的提问也要在目录里占一行——否则它在目录上「不存在」，
    // 而用户明明记得问过（位置比文字重要）
    items.push({
      index,
      id: message.id,
      label: labelOf(message.text) || `（第 ${turn} 轮：只有图片）`,
      turn,
    });
  }
  return items;
}

/** 命中处两侧各留一点；被截掉的一端加省略号，好让人知道这里不是开头/结尾 */
function clip(flat: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * 按**文字**搜历史（提问与回复都搜）。
 *
 * 先压平空白再匹配：正文里换行很多，直接匹配会让「相邻两行」的查询永远搜不到，
 * 而用户心里的「连续文本」是不带换行的。
 */
export function searchHistory(messages: ViewMessage[], query: string, limit = 50): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const hits: SearchHit[] = [];
  for (let index = 0; index < messages.length && hits.length < limit; index += 1) {
    const message = messages[index]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const flat = message.text.replace(/\s+/g, " ");
    const at = flat.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    hits.push({ index, id: message.id, role: message.role, snippet: clip(flat, at, needle.length) });
  }
  return hits;
}
