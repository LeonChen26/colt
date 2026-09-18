/**
 * 被「钉住」的会话：系统不再自动回收它们。
 *
 * 为什么需要：切走不再杀 worker 之后，回收只剩两条路径——空闲超时与进程池淘汰。
 * 两条都是**系统替用户做的主**，而用户未必同意（他可能正要去喝杯咖啡再回来接着看）。
 * 钉住就是把「这条别收」这个决定交回用户手里。
 *
 * 语义由 `worker-pool.ts` 的两条**纯**决策落实（也由它单测钉死）：
 * 空闲回收**跳过**钉住的；进程池满时钉住的**最后**才淘汰（不是绝不淘汰——
 * 若所有会话都钉住就再也开不出新会话了）。
 *
 * 只存在内存里、只活本次运行：与 worker 同寿命。跨重启没有意义——worker 本来就不跨重启，
 * 重启后一切都是冷的、都要重放 JSONL，钉不钉没区别。故不进库、不做迁移。
 */
const pinned = new Set<string>();

export function isSessionPinned(sessionId: string): boolean {
  return pinned.has(sessionId);
}

export function setSessionPinned(sessionId: string, value: boolean): void {
  if (value) pinned.add(sessionId);
  else pinned.delete(sessionId);
}

/** 渲染层挂载时用它把图钉状态对齐回来（比如 dev 下 reload 之后） */
export function listPinnedSessions(): string[] {
  return [...pinned];
}

/** 会话被删除时清掉，别为一个不存在的会话留着标记 */
export function dropSessionPin(sessionId: string): void {
  pinned.delete(sessionId);
}
