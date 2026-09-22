// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「把主对话的历史指针挪到某个节点上」——`navigate` 命令里**做决定的那一步**。
 *
 * 为什么单独抽出来：这段原来长在 `worker/entry.ts` 的 `case "navigate"` 里，而那是 worker
 * 入口——测试一 import 就把进程引导跑起来了，等于没法单测。可它有两条语义**只有这里能保证**：
 *   ① **拒绝子 lane 的节点**。`ownedEntries` / `foreignLaneTips` 那套纯函数有单测（见
 *      `lane-ownership.ts`），但「集合里有它时**一次都不去** navigate」是调用点的职责——
 *      放过去就把主对话的指针挪到了子代理（或记忆整理）的链上；
 *   ② **顺序**：先把指针挪过去，**再**重拍快照（反了就是拿旧快照当新快照推给界面）。
 *
 * 依赖全按回调注入：单测拿假实现就能钉住「有没有调用」「以什么顺序调用」「异常往哪走」，
 * 而 worker 那边只是把 `state` 上的真家伙接上（见 `entry.ts` 的同名调用点）。
 */

/** 一次导航的结果。失败**走返回值、不走异常**——它是产品语义（用户要看那条提示）。 */
export type NavigateOutcome<S> = { ok: true; snapshot: S } | { ok: false; message: string };

export interface NavigateDeps<S> {
  /** 属于子 lane 的条目 id 集合。判据必须与分支树排除**共用同一个**（见 `lane-ownership`） */
  foreignLaneEntryIds: () => Promise<ReadonlySet<string>>;
  /** 移动历史指针（`lane.navigateTree`） */
  navigateTree: (targetId: string) => Promise<void>;
  /** 结构性变更后重建快照（`state.resnapshot`） */
  resnapshot: () => Promise<S>;
}

/**
 * 把指针挪到 `targetId`；成功后回传**新快照**（由调用方写回自己的 state）。
 *
 * 三条不变量：
 * - 目标属于子 lane → 拒绝，且 **`navigateTree` / `resnapshot` 一次都不碰**；
 * - 成功 → 先 `navigateTree` 再 `resnapshot`（顺序即语义：快照必须拍在指针挪动**之后**）；
 * - `navigateTree` 抛错 → **原样抛出**（调用方按命令失败处理），**不**去重拍快照——
 *   否则会把「没跳成的旧快照」当成新状态推给界面。
 */
export async function applyNavigate<S>(
  targetId: string,
  deps: NavigateDeps<S>,
): Promise<NavigateOutcome<S>> {
  if ((await deps.foreignLaneEntryIds()).has(targetId)) {
    return {
      ok: false,
      message: "这个节点属于子代理（或记忆整理）的运行记录，不属于主对话，不能切过去。",
    };
  }
  await deps.navigateTree(targetId);
  return { ok: true, snapshot: await deps.resnapshot() };
}
