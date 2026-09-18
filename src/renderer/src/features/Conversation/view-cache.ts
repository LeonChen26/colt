/**
 * 会话视图缓存（仅渲染层、仅本次运行）。
 *
 * 为什么需要它：会话历史**只活在 worker 的投影里**——`session.view` 只从 worker 池取，
 * 库里没有消息表，也没有别处可以读。而 Conversation 是按会话 id 重挂载的
 * （`<Conversation key={sessionId}>`），于是每次「切走再切回 / worker 被回收 / 应用重启」
 * 都会把 `view` 归零：在 worker 重放完 JSONL 之前，界面只剩**纯白 + 转圈**，
 * 长会话可能要数十秒（见主进程 `READY_TIMEOUT_MS` 的注释）。
 *
 * 缓存最后一份视图后，重挂**立刻**能画出上次的内容；重放 / 重开都在幕后进行，
 * 不再是「等它好了才有东西看」。这是刻意的「响应优先」取舍：多花一点渲染层内存，
 * 换掉那次白屏。
 *
 * 只保留最近 `MAX_ENTRIES` 个会话：内存可以多花，但不是无限。
 */
import type { ConversationView } from "@shared/worker-protocol";

const MAX_ENTRIES = 30;
const cache = new Map<string, ConversationView>();

/**
 * 订阅 `session.view` 并持续更新缓存。
 *
 * 订阅挂在**模块级**而不是某个 Conversation 里：视图是主进程按会话推来的，
 * 只挂在当前会话上就缓存不到**后台会话**——而它们恰恰是切走之后要能立刻回来的那些。
 */
let subscribed = false;
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  window.colt.on("session.view", (view) => remember(view));
}

function remember(view: ConversationView): void {
  // 重新插入让它排到末尾（Map 保序 = LRU 顺序），超上限时从最旧的一端淘汰
  cache.delete(view.sessionId);
  cache.set(view.sessionId, view);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 取该会话缓存的最后一份视图；没有则 null，调用方回落到「等 worker 推来」 */
export function getCachedView(sessionId: string): ConversationView | null {
  ensureSubscribed();
  return cache.get(sessionId) ?? null;
}

/** 会话被删除时丢掉缓存，别留着再也读不到的整份历史 */
export function dropCachedView(sessionId: string): void {
  cache.delete(sessionId);
}
