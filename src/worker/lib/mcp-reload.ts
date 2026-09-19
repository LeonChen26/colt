// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * MCP 配置热重载的**写回**一步：把 runtime 的新工具清单落进 harness 与主 lane。
 *
 * 为什么单独成文件：worker 入口有体量闸（`AGENTS.md` §1.4），这段逻辑要 4 个依赖
 * （runtime / harness / lane / context），塞进入口既长又难读；它本身是机械的
 * 「取 → 过滤 → 拼 → 写回」，自成一体，适合搬走。
 *
 * 两个写回点**缺一不可**（理由同 `lib/lane-heal.ts`）：
 *  - `harness.setTools` 换掉**工具定义**——内核 `lane.readConfig().tools` 是活取的，
 *    下一次生成立即按新定义解析；
 *  - `lane.setActiveTools` 换掉**清单**——内核只对新建 lane 套用 seed，存量 lane 沿用
 *    自己持久化的那份。
 * 只写第二个，模型看不到新工具；只写第一个，清单里的名字在 `toolsByName` 里查不到，
 * 生成会以 `configured_tools_unavailable` 直接失败——**删掉的工具尤其要连清单一起删**。
 * 第二步复用 `healLaneTools`（它做的是**全量对齐**，不是只补不删），于是「清单与
 * harness 一致」这条不变量只有一处实现。
 */
import type { AgentHarness, AgentLane, Context, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { McpServerView } from "@shared/worker-protocol";
import { healLaneTools } from "./lane-heal";
import { MCP_TOOL_PREFIX, type McpRuntime } from "./mcp-tools";

export async function reloadMcpIntoHarness(
  mcp: McpRuntime,
  harness: AgentHarness<ExecutionToolContext>,
  lane: AgentLane,
  context: Context,
): Promise<McpServerView[]> {
  const { tools, statuses } = await mcp.reload();
  const current = await harness.getTools(context);
  const others = current.filter((tool) => !tool.name.startsWith(MCP_TOOL_PREFIX));
  const next = [...others, ...tools];
  await harness.setTools(next, context);
  await healLaneTools(
    lane,
    next.map((tool) => tool.name),
    context,
  );
  return statuses;
}
