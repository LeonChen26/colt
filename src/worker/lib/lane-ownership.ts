// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「哪些条目属于**子 lane**」——分支树排除与导航守卫共用的**纯函数**。
 *
 * 为什么需要它：持久化里 lane **就是命名分支**，而 `session.findEntries` 扫的是
 * **会话级**全部条目（内核 `EntryQuery` 上没有任何 lane 维度；`Entry` 本体也不带 lane
 * 字段——lane 身份只存在分支指针上）。于是子 lane（记忆整理、子代理）产生的条目会
 * 混进主对话的分支树：`fresh` 子 lane 的起点是 `null`，它的链**自成一条根**，
 * 在左栏表现为一个凭空多出来的对话根节点，且**可点**——一点就把主 lane 的历史指针
 * 挪到子 lane 的节点上。
 *
 * ⚠️ **只处理 `fresh`（`createAt: null`）这一种**：它的链与主对话**没有共享祖先**，
 * 所以「从 tip 沿 `parentId` 上溯到根」收集到的条目**整条**都是它的。
 * 刻意不写通用算法（例如「排除到分叉点为止」）——那是为 `fork` 这种**还不存在**的
 * 上下文模式修路（同一个理由见 `docs/DESIGN-subagents.md` 决策二）。
 * 将来真要加 `fork`，调用方必须先停下来把这里重写一遍，而不是指望它「大概也对」。
 *
 * 调用方口径：`tips` 只传**非主 lane** 的 tip（主 lane 的链一条都不能排除）。
 */

/** 计算归属只需要这两个字段——用最窄的入参面，便于单测与复用 */
export interface OwnershipEntry {
  id: string;
  parentId: string | null;
}

/**
 * 从各 `fresh` 子 lane 的 tip 上溯，收集**整条链**上的条目 id。
 *
 * 防御两件事：
 * - **未知 tip**（`null` / 找不到）直接跳过——会话刚建、lane 还没有内容时是常态；
 * - **环**：持久化一旦被写坏（或将来有人手工造出循环 parentId），上溯必须能停，
 *   否则这里会死循环、整条分支树查询永远不返回（界面上表现为「左栏一直转圈」）。
 */
export function ownedEntries(
  tips: readonly (string | null | undefined)[],
  entries: readonly OwnershipEntry[],
): Set<string> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const owned = new Set<string>();
  for (const tip of tips) {
    let cursor: string | null = tip ?? null;
    while (cursor !== null && !owned.has(cursor)) {
      const entry = byId.get(cursor);
      if (entry === undefined) break;
      owned.add(cursor);
      cursor = entry.parentId;
    }
  }
  return owned;
}

/**
 * 分支树要展示的条目：会话级全部条目**减去**子 lane 拥有的那些。
 *
 * 导出成单独一步（而不是让调用方自己拼两行）是为了让「排除」只有一个写法——
 * 分支树查询与导航守卫必须**按同一个集合**判断，各写一遍迟早走偏：
 * 那时会出现「树里看不到、却能导航过去」的幽灵节点。
 */
export function visibleEntries<T extends OwnershipEntry>(
  entries: readonly T[],
  owned: ReadonlySet<string>,
): T[] {
  return entries.filter((entry) => !owned.has(entry.id));
}

/**
 * 非主 lane 的 tip 列表——`harness.lanes()` 的投影。
 *
 * 内核在装配 harness 时会**恢复全部已配置的 lane**（含上次运行留下的子代理 lane），
 * 所以这份清单是完整的：worker 重启后子 lane 的条目照样能被排除，
 * 不必在应用侧另记一份「我开过哪些 lane」（那份记录会随进程一起丢）。
 */
export function foreignLaneTips(
  lanes: readonly { name: string; tipId: string | null }[],
  mainLaneName: string,
): (string | null)[] {
  return lanes.filter((lane) => lane.name !== mainLaneName).map((lane) => lane.tipId);
}
