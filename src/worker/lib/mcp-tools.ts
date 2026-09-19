// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * MCP（Model Context Protocol）工具接入——验证性原型。
 *
 * 定位：把 `<cwd>/.colt/mcp.json` 里声明的 stdio MCP server 的工具包成内核
 * `AgentHarnessTool`，塞进 `AgentHarness.create({ tools })`。名字带 `mcp__` 前缀，
 * 不在 READONLY_TOOLS / 提问 / 子代理任何一份豁免名单里——所以它们**天然过
 * `before_tool` 审批闸门**，落到 policy 的「未知工具，按需确认」（moderate → ask），
 * 一行审批代码都不用改。这正是「不自建扩展宿主」路线的兑现方式：生态工具以
 * 普通工具的身份进入，安全模型零例外。
 *
 * 与 pi 生态的关系：刻意**不**适配 `pi-mcp-adapter` 之类的扩展包——它们 29% 的
 * 代码是 TUI 同意面板与宿主生命周期，对本仓是死重；直接用官方
 * `@modelcontextprotocol/sdk` 的 Client，反而更薄。
 *
 * schema 处理：MCP 工具的 `inputSchema` 是**裸 JSON Schema**，原样交给内核。
 * 这不靠运气——pi-ai 的 `validateToolArguments` 显式区分 typebox / 非 typebox
 * schema（查 `TYPEBOX_KIND` 符号），对后者走纯 JSON Schema 的 coercion + 编译校验；
 * 模型侧拿到的也是这份原样 schema。测试里有专门一条钉住这个契约。
 *
 * 已知限制（原型边界，别当bug修）：
 * - 只支持 stdio 传输；远程（HTTP/SSE）server 未接。
 * - `listTools` 不分页（绝大多数 server 一次返回全量）。
 * - worker 被主进程**强杀**（dispose 3s 宽限超时 / 崩溃）时 MCP 子进程会成为孤儿；
 *   正常 dispose 路径走 `process.on("exit")` 兜底回收。
 * - 配置里不做环境变量插值（`${VAR}`），env 只支持字面量。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { CompatibilityCallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TSchema } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** 工具名前缀：注册名、审批签名、界面展示同源 */
export const MCP_TOOL_PREFIX = "mcp__";

/** LLM API 对工具名普遍有 64 字符上限（含前缀），超长的截断并记诊断 */
export const MAX_TOOL_NAME_CHARS = 64;

/** 单个 server 的连接 + 列工具超时：挂死的 server 不许拖住会话启动 */
const CONNECT_TIMEOUT_MS = 15_000;

/** `.colt/mcp.json` 里单个 server 的声明（stdio） */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
}

/** callTool 返回里本模块关心的最小形状（SDK 的 zod 联合类型用起来反而绕） */
interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

interface McpContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { text?: string; blob?: string; mimeType?: string };
}

/** 活着的客户端：worker 退出时统一回收（正常 dispose 会走 process exit） */
const liveClients = new Set<Client>();
let exitHookArmed = false;

function armExitHook(): void {
  if (exitHookArmed) return;
  exitHookArmed = true;
  process.on("exit", () => {
    // exit 事件里不能 await；Client.close 内部 kill 子进程的信号发出是同步的，尽力而为
    for (const client of liveClients) void client.close().catch(() => undefined);
  });
}

/** 关掉全部 MCP 连接（测试与将来的 dispose 路径用） */
export async function closeMcpTools(): Promise<void> {
  const clients = [...liveClients];
  liveClients.clear();
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
}

/** server / 工具名清洗成 LLM API 接受的字符集（`[A-Za-z0-9_-]`） */
export function mcpToolName(serverName: string, toolName: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `${MCP_TOOL_PREFIX}${clean(serverName)}__${clean(toolName)}`;
  return full.length <= MAX_TOOL_NAME_CHARS ? full : full.slice(0, MAX_TOOL_NAME_CHARS);
}

/** MCP 内容块 → 内核内容块；图片块会随 tool-image-spill 照常落盘，不特殊处理 */
export function mapMcpContent(result: McpCallResult): (TextContent | ImageContent)[] {
  const blocks = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];
  const out: (TextContent | ImageContent)[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      out.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else if (block.type === "resource" && typeof block.resource?.text === "string") {
      out.push({ type: "text", text: block.resource.text });
    } else {
      out.push({ type: "text", text: `[mcp] 不支持的内容块类型：${block.type ?? "unknown"}` });
    }
  }
  if (out.length === 0 && result.structuredContent !== undefined) {
    out.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  }
  if (out.length === 0) out.push({ type: "text", text: "[mcp] 工具返回了空结果" });
  return out;
}

/** 内容块里的文本拼起来，作为报错消息（isError 时） */
function resultText(result: McpCallResult): string {
  return mapMcpContent(result)
    .map((block) => (block.type === "text" ? block.text : "[图片]"))
    .join("\n");
}

/** 校验并归一一个 server 声明；不合法返回诊断字符串 */
export function parseServerConfig(name: string, raw: unknown): McpServerConfig | string {
  if (typeof raw !== "object" || raw === null) return `server "${name}" 的配置不是对象`;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.command !== "string" || candidate.command.trim() === "") {
    return `server "${name}" 缺少 command`;
  }
  const config: McpServerConfig = { command: candidate.command };
  if (candidate.args !== undefined) {
    if (!Array.isArray(candidate.args) || candidate.args.some((a) => typeof a !== "string")) {
      return `server "${name}" 的 args 必须是字符串数组`;
    }
    config.args = candidate.args as string[];
  }
  if (candidate.env !== undefined) {
    if (
      typeof candidate.env !== "object" ||
      candidate.env === null ||
      Object.values(candidate.env).some((v) => typeof v !== "string")
    ) {
      return `server "${name}" 的 env 必须是字符串字典`;
    }
    config.env = candidate.env as Record<string, string>;
  }
  return config;
}

/** 读 `<cwd>/.colt/mcp.json`；文件不存在 → 空配置（不吵），解析失败 → 诊断 */
export async function loadMcpConfig(
  cwd: string,
): Promise<{ servers: Record<string, McpServerConfig>; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  let raw: string;
  try {
    raw = await readFile(join(cwd, ".colt", "mcp.json"), "utf8");
  } catch {
    return { servers: {}, diagnostics }; // 没配就是没配，不是错误
  }
  let parsed: McpConfigFile;
  try {
    parsed = JSON.parse(raw) as McpConfigFile;
  } catch (error) {
    return {
      servers: {},
      diagnostics: [`.colt/mcp.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
    const config = parseServerConfig(name, value);
    if (typeof config === "string") diagnostics.push(config);
    else servers[name] = config;
  }
  return { servers, diagnostics };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms),
    ),
  ]);
}

/**
 * 连接一个 server 并把它的工具包成内核工具。
 * 失败（连不上 / 超时 / listTools 报错）抛错，由调用方收成诊断——一个坏 server 不拦会话。
 */
async function connectServer(
  name: string,
  config: McpServerConfig,
): Promise<AgentHarnessTool<ExecutionToolContext>[]> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...getDefaultEnvironment(), ...config.env },
  });
  const client = new Client({ name: "colt", version: "0.0.1" });
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 MCP server "${name}"`);
    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `列出 "${name}" 的工具`);
    liveClients.add(client);
    armExitHook();
    return listed.tools.map((tool) => {
      const wrapped: AgentHarnessTool<ExecutionToolContext, TSchema, undefined> = {
        name: mcpToolName(name, tool.name),
        label: `MCP ${name}: ${tool.name}`,
        description: tool.description ?? `MCP server "${name}" 的 ${tool.name} 工具`,
        // 裸 JSON Schema 原样透传：pi-ai 的 validateToolArguments 对非 typebox
        // schema 有专门的 coercion + 编译路径（见文件头注释）
        parameters: tool.inputSchema as unknown as TSchema,
        async execute(_toolCallId, params) {
          const result = (await client.callTool(
            { name: tool.name, arguments: params as Record<string, unknown> },
            CompatibilityCallToolResultSchema,
          )) as unknown as McpCallResult;
          // 内核约定：失败要 throw，由内核转成错误工具结果（与 host-bridge 同款）
          if (result.isError === true) throw new Error(resultText(result));
          return { content: mapMcpContent(result), details: undefined };
        },
      };
      return wrapped;
    });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/**
 * 装载 `<cwd>/.colt/mcp.json` 声明的全部 MCP 工具。
 *
 * 与技能同一条隐式信任通道：MCP server 是**会话启动时即执行的本地代码**，
 * 装了什么、坏在哪里必须如实告知（notice 由调用方按 security 类发出）。
 */
export async function loadMcpTools(
  cwd: string,
  notify: (message: string) => void,
): Promise<AgentHarnessTool<ExecutionToolContext>[]> {
  const { servers, diagnostics } = await loadMcpConfig(cwd);
  const tools: AgentHarnessTool<ExecutionToolContext>[] = [];
  const loaded: string[] = [];
  for (const [name, config] of Object.entries(servers)) {
    try {
      const wrapped = await connectServer(name, config);
      tools.push(...wrapped);
      loaded.push(`${name}（${wrapped.length} 个工具）`);
    } catch (error) {
      diagnostics.push(
        `server "${name}" 连接失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const parts: string[] = [];
  if (loaded.length > 0) parts.push(`已连接 ${loaded.length} 个 MCP server：${loaded.join("、")}`);
  if (diagnostics.length > 0) parts.push(`MCP 告警 ${diagnostics.length} 条：${diagnostics.join("；")}`);
  if (parts.length > 0) notify(parts.join("；"));
  return tools;
}
