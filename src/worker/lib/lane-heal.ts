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
 * **对齐方向是「清单 = 本地实际持有的工具」，两端都要动**（2026-09-19 由「只补不删」
 * 改成全量对齐）：
 * - 缺的**补上**——老会话看不到后加的工具（原理由）。
 * - 多的**删掉**——内核在生成前算 `activeToolNames.filter(n => !toolsByName.has(n))`，
 *   非空就以 `configured_tools_unavailable` 直接失败（`harness/runtime/drive/generation.js`）。
 *   而 **MCP 工具是用户配置驱动的、会消失**：某会话用过 server A，之后用户把 A 从
 *   `.colt/mcp.json` 删掉再打开该会话，清单里那条 `mcp__A__*` 就成了「清单里有、工具已不在」
 *   ——只补不删的话，**这个会话的每一条消息都会失败**。
 *   原注释怕的是「将来按模式裁剪主 lane 工具时不能反着加回来」；那个将来并未发生，
 *   而**已经发生**的是删 MCP server 把老会话弄坏。两者取重，选全量对齐。
 *
 * 相等就**不写**：`setActiveTools` 不做等值短路，无条件调用会让每次开会话都多一条配置事件。
 */
import type { AgentLane, Context } from "@earendil-works/pi-agent-core";

export async function healLaneTools(
  lane: AgentLane,
  expected: readonly string[],
  context: Context,
): Promise<void> {
  const current = await lane.getActiveTools(context);
  // 集合相等即无事可做。顺序以 expected 为准——它是 harness 的 create 顺序，跨次稳定
  const same =
    current.length === expected.length && expected.every((name) => current.includes(name));
  if (same) return;
  await lane.setActiveTools([...expected], context);
}
