// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * MCP 与系统提示词之间唯一还需要应用自己接的一根线：
 * 把 server 握手上报的 `instructions` 拼进每轮系统提示词。
 *
 * **为什么必须应用自己拼**：`instructions` 是 server 握手时自报的「怎么用我」
 * （如「调 A 之前先调 B」这类用法约定）。SDK 只提供 `client.getInstructions()` 这个取值口，
 * **自己一处都不调用**——不拼就是静默丢掉 server 的用法说明，而装载、告警、计数、typecheck、
 * 单测全绿（`AGENTS.md` §四「把库提供了函数当成库会调用它」那次翻车的同族，技能清单同坑）。
 *
 * 每请求重拼（挂在 durable worker 的 `GenerationTask.beforeRequest` 注入链上），所以
 * `reload()` 换过 server 之后下一次请求立即可见——与记忆 / 待办块同一条纪律。
 * 无 instructions 时**原样返回 `base`**、不产出多余空行，内容不变时拼出的串逐字相同，
 * 提示词缓存照常命中。
 *
 * ⚠️ 信任面：这段是 **server 自报的文本**，与工具描述同一条隐式信任通道，原样引用、不当本机指令。
 */
import type { McpRuntime } from "./mcp-tools";

export function composeMcpInstructions(base: string, mcp: McpRuntime): string {
  const entries = mcp.instructions();
  if (entries.length === 0) return base;
  const body = entries.map(({ server, text }) => `### ${server}\n${text}`).join("\n\n");
  return (
    `${base}\n\n## 已连接的 MCP server 自报的用法说明\n\n` +
    `以下内容由各 server 自行提供、原样引用，供你理解其用法：\n\n${body}`
  );
}
