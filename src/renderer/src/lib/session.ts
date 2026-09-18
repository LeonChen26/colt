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
 * 渲染层的规矩是「**草稿只当当前会话用，不进侧栏**」：它不在库里，`session.list` 也就
 * 永远不会返回它。切项目时靠这个判断把手里的草稿留住（否则会被换成该项目的第一个会话，
 * 用户刚点出来的输入框会莫名跑到别的会话上去）。
 */
export function isDraftSession(session: { jsonlPath: string }): boolean {
  return session.jsonlPath === "";
}

/**
 * 当前是否该「就地给一条草稿」——即中间区没有会话可显示，却又确实有项目在跟前。
 *
 * 为什么要有它：没有会话时中间区本来只有一句「新建一个会话开始对话」，用户得先跑到侧栏
 * 点「+」才见得到输入框。现在改成直接自动建一条草稿，打开就见输入框。
 *
 * 三种情况必须分开（`sessions` 为 `undefined` 表示**还没拉到**，不是「空」）：
 * ① 列表还没到 → 等。否则每次启动都会先抢建一条，白建；
 * ② 项目下已有落库会话 → 不需要（那些会话自己就能显示）；
 * ③ 当前会话已经是本项目的一条（含草稿）→ 已经有了，不能再建，否则会无限建下去。
 */
export function shouldOfferDraft(
  projectId: string | undefined,
  sessions: readonly SessionInfo[] | undefined,
  active: { projectId: string } | null,
): boolean {
  if (!projectId) return false;
  if (sessions === undefined || sessions.length > 0) return false;
  return active?.projectId !== projectId;
}
