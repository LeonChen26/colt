// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * MCP 与 harness / 系统提示词 / 设置页之间的**接线**，三件事一处：
 *  1. `reloadMcpIntoHarness`——热重载的**写回**：把 runtime 的新工具清单落进 harness 与主 lane；
 *  2. `composeMcpInstructions`——把 server 自报的 `instructions` 拼进系统提示词；
 *  3. `handleMcpCommand`——设置页的那两个命令（查现状 / 热重载）的落点。
 *
 * 为什么单独成文件：worker 入口有体量闸（`AGENTS.md` §1.4），上面三件都各自要 3~4 个依赖
 * （runtime / harness / lane / context），塞进入口既长又难读；它们本身都是机械的
 * 「取 → 过滤 → 拼 → 写回」，自成一体，适合搬走。
 *
 * 写回的两个点**缺一不可**（理由同 `lib/lane-heal.ts`）：
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

/**
 * 把各 server 自报的 `instructions` 拼进系统提示词（没有就原样返回 `base`）。
 *
 * **为什么必须应用自己拼**：`instructions` 是 server 握手时自报的「怎么用我」
 * （如「调 A 之前先调 B」这类用法约定）。SDK 只提供 `client.getInstructions()` 这个取值口，
 * **自己一处都不调用**——不拼就是静默丢掉 server 的用法说明，而装载、告警、计数、typecheck、
 * 单测全绿（`AGENTS.md` §四「把库提供了函数当成库会调用它」那次翻车的同族，技能清单同坑）。
 *
 * 每请求重拼（挂在 `entry.ts` 的注入链上），所以 `reload()` 换过 server 之后下一次请求立即
 * 可见——与记忆 / 待办块同一条纪律。无 instructions 时**原样返回 `base`**、不产出多余空行，
 * 内容不变时拼出的串逐字相同，提示词缓存照常命中（空清单不产出东西，与 `renderTodoBlock` 同款）。
 *
 * ⚠️ 信任面：这段是 **server 自报的文本**，与工具描述同一条隐式信任通道，原样引用、不当本机指令。
 */
export function composeMcpInstructions(base: string, mcp: McpRuntime): string {
  const entries = mcp.instructions();
  if (entries.length === 0) return base;
  const body = entries.map(({ server, text }) => `### ${server}\n${text}`).join("\n\n");
  return (
    `${base}\n\n## 已连接的 MCP server 自报的用法说明\n\n` +
    `以下内容由各 server 自行提供、原样引用，供你理解其用法：\n\n${body}`
  );
}

/**
 * 设置页那两个 MCP 命令的落点：查现状 / 热重载。
 *
 * 与 `reloadMcpIntoHarness` 同属「MCP 与 harness / 设置页的接线」，所以一起住在这里
 * （搬出 `entry.ts` 的理由同文件头：worker 入口有体量闸）。
 * 语义与搬来之前**逐字一致**：未初始化时**查现状回空、热重载报错**（设置页可能早于 init 到来）。
 */
export async function handleMcpCommand(
  kind: "mcpStatus" | "mcpReload",
  state:
    | { mcp: McpRuntime; harness: AgentHarness<ExecutionToolContext>; lane: AgentLane }
    | undefined,
  context: Context,
): Promise<McpServerView[]> {
  if (kind === "mcpStatus") return state?.mcp.status() ?? [];
  if (state === undefined) throw new Error("会话尚未初始化");
  return reloadMcpIntoHarness(state.mcp, state.harness, state.lane, context);
}
