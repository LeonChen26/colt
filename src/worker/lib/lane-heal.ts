// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 存量 lane 的**工具清单愈合**。
 *
 * 为什么需要：内核只对**新建** lane 套用 create 时的 seed（`activeToolNames`），
 * 已存在的会话在恢复时**原样采纳自己持久化的配置**（`restore.js` 取
 * `stored.configuration.value`，不看本次 seed）。于是「会话建在这个工具存在之前」的
 * 老会话，清单里永远没有它——模型看不到也用不了，而装载、告警、计数、typecheck 全绿，
 * 是彻头彻尾的静默失败（`AGENTS.md` §四「接了一半也能跑」的同族）。
 *
 * 与模型 / 思考等级的愈合同一个位置、同一个理由，故三件事挨着写。
 *
 * **只补不删**：主 lane 的清单理应就是全量，缺的只可能是「会话后来新增的工具」。
 * 不删是给将来留余地——若哪天真要按模式裁剪主 lane 工具，这里不能反着把它加回去。
 */
import type { AgentLane, Context } from "@earendil-works/pi-agent-core";

export async function healLaneTools(
  lane: AgentLane,
  expected: readonly string[],
  context: Context,
): Promise<void> {
  const current = await lane.getActiveTools(context);
  const missing = expected.filter((name) => !current.includes(name));
  // 相等就**不写**：`setActiveTools` 不做等值短路，无条件调用会让每次开会话都多一条配置事件
  if (missing.length === 0) return;
  await lane.setActiveTools([...new Set([...current, ...missing])], context);
}
