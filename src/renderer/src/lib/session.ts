// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 会话（`SessionInfo`）列表相关的小工具。
 *
 * 这里只放**能单测的纯函数**——不碰 IPC、不碰 React，便于给边界情况补用例。
 */
import type { SessionInfo } from "@shared/protocol";

/**
 * 是否是**草稿**会话：`session.create` 返回、但首次发消息才落库的那一种。
 *
 * 判别依据是 `jsonlPath` 为空串。这不是凑出来的规则——主进程构造草稿时就按此约定：
 * 「与真实会话同形，界面无需特殊分支；jsonlPath 为空串——文件要等首次发消息才存在」
 * （见 `src/main/ipc/index.ts` 的 `session.create`）。故渲染层可以放心用它当判别依据。
 *
 * 为什么需要这个判断：`session.list` 只读库，**不会返回草稿**。渲染层若拿它的结果
 * 整份替换本地列表，侧栏里那条草稿就会凭空消失、用户再也点不回来。
 */
export function isDraftSession(session: { jsonlPath: string }): boolean {
  return session.jsonlPath === "";
}

/**
 * 把「库里的会话列表」与「本地尚未落库的草稿」合并成侧栏该显示的那一份。
 *
 * - `previous`：当前缓存（可能含草稿）
 * - `fromDb`：`session.list` 的结果（只读库，草稿不在其中）
 *
 * 规则：只保留 `previous` 里**是草稿且 `fromDb` 里没有**的那些，放在最前。这样：
 * ① 草稿不会因一次刷新而消失；② 已删除的真实会话能被正确地剔除（非草稿项一律以库为准）；
 * ③ 草稿一旦落库，就会出现在 `fromDb` 里，此处不再重复保留（不会出现两条）。
 *
 * 放头部而非尾部：草稿的 `updatedAt` 是创建时间，落库时又会刷新一次，排序上本就最靠前，
 * 放在头部才与它落库后的位置一致，不会「刷新一下跳到别处」。
 */
export function mergeSessionList(
  previous: readonly SessionInfo[],
  fromDb: readonly SessionInfo[],
): SessionInfo[] {
  const persisted = new Set(fromDb.map((item) => item.id));
  const drafts = previous.filter((item) => !persisted.has(item.id) && isDraftSession(item));
  return [...drafts, ...fromDb];
}
