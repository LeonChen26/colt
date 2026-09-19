// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * MCP 工具注册名的**展示名**。
 *
 * 注册名是 `mcp__<server>__<tool>`（见 `worker/lib/mcp-tools.ts` 的 `mcpToolName`），
 * 那是给 LLM API 看的标识符——界面直接画它就露出开发者黑话。本模块把它翻译成
 * `MCP <server>: <tool>`，供审批卡 / 工具卡 / 提示用。
 *
 * ⚠️ 展示名里的 server / 工具名来自**注册名**，而注册名把非 `[A-Za-z0-9_-]` 的字符
 * 清洗成了下划线（`my server` → `my_server`）——所以它**可能与用户配置里写的名字不同**。
 * 这是有意的：展示名与模型看到的注册名、审批签名同源，避免同一工具在界面上有两个说法。
 *
 * 本模块**不 import 任何 node 内置**：列表它会被渲染层（浏览器侧）直接引用，必须是纯字符串函数。
 */

/** 注册名前缀：注册名、审批签名、界面展示**同源** */
export const MCP_TOOL_PREFIX = "mcp__";

/** 注册名 → 展示名；不是 MCP 工具（或形状不完整）时返回 `undefined`，调用方据此回落到原名 */
export function mcpToolLabel(name: string): string | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return undefined;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (tool === "") return undefined;
  return `MCP ${server}: ${tool}`;
}
