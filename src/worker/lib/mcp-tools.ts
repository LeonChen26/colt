// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { TSchema } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { McpServerView } from "@shared/worker-protocol";
import {
  configKey,
  interpolateConfig,
  loadMcpConfig,
  targetOf,
  transportOf,
  type McpServerConfig,
} from "@shared/mcp-config";

// 配置层与纯函数从 shared 透传：`worker/lib/mcp-tools` 是既有的引用入口
// （单测从它 import），不为搬文件去改一票调用点。
export {
  configKey,
  interpolateConfig,
  loadMcpConfig,
  mcpConfigPath,
  parseServerConfig,
  targetOf,
  transportOf,
  type McpServerConfig,
} from "@shared/mcp-config";

/** 工具名前缀：注册名、审批签名、界面展示同源 */
export const MCP_TOOL_PREFIX = "mcp__";

/** LLM API 对工具名普遍有 64 字符上限（含前缀），超长的截断并记诊断 */
export const MAX_TOOL_NAME_CHARS = 64;

/** 单个 server 的**连接 / 列工具**超时：挂死的 server 不许拖住会话启动 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * `listTools` 分页上限。绝大多数 server 一页给全；留一个有限页数只为兜住
 * 「server 永远回同一个 cursor」这种坏实现——否则我们会在这里转圈。
 */
const MAX_TOOL_PAGES = 100;

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

/** listTools 返回的单条工具（只取本模块用到的字段） */
interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** 活着的客户端：worker 退出时统一回收（正常 dispose 会走 runtime.close） */
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

/** 关掉全部 MCP 连接（测试与强杀前的兜底用） */
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms),
    ),
  ]);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

/** 按配置造传输：stdio 走子进程，远程走 Streamable HTTP / SSE（headers 透传） */
function buildTransport(config: McpServerConfig): AnyTransport {
  if (config.command !== undefined) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...config.env },
    });
  }
  const url = new URL(config.url ?? "");
  const requestInit = config.headers === undefined ? undefined : { headers: config.headers };
  return config.transport === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

/** 拉全量工具：跟随 `nextCursor` 翻页（页数有上限，见 MAX_TOOL_PAGES） */
async function listAllTools(client: Client, serverName: string): Promise<ListedTool[]> {
  const all: ListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const listed = await withTimeout(
      client.listTools(cursor === undefined ? undefined : { cursor }),
      CONNECT_TIMEOUT_MS,
      `列出 "${serverName}" 的工具`,
    );
    all.push(...(listed.tools as unknown as ListedTool[]));
    cursor = listed.nextCursor;
    if (cursor === undefined) return all;
  }
  throw new Error(`列出 "${serverName}" 的工具超过 ${MAX_TOOL_PAGES} 页，疑似分页游标未推进`);
}

/** 把一个 MCP 工具包成内核工具（名字前缀、裸 schema 透传、失败要 throw） */
function wrapTool(
  serverName: string,
  tool: ListedTool,
  client: Client,
): AgentHarnessTool<ExecutionToolContext, TSchema, undefined> {
  return {
    name: mcpToolName(serverName, tool.name),
    label: `MCP ${serverName}: ${tool.name}`,
    description: tool.description ?? `MCP server "${serverName}" 的 ${tool.name} 工具`,
    // 裸 JSON Schema 原样透传：pi-ai 的 validateToolArguments 对非 typebox
    // schema 有专门的 coercion + 编译路径（见文件头注释）
    parameters: tool.inputSchema as unknown as TSchema,
    async execute(_toolCallId, params) {
      const result = (await client.callTool(
        { name: tool.name, arguments: params as Record<string, unknown> }
      )) as unknown as McpCallResult;
      // 内核约定：失败要 throw，由内核转成错误工具结果（与 host-bridge 同款）
      if (result.isError === true) throw new Error(resultText(result));
      return { content: mapMcpContent(result), details: undefined };
    },
  };
}

/** 一个 server 的运行态：连上了就有 client + tools；失败（或连上后掉线）则带 error */
interface ServerState {
  name: string;
  config: McpServerConfig;
  client?: Client;
  tools: AgentHarnessTool<ExecutionToolContext, TSchema, undefined>[];
  error?: string;
  /** 我们主动关的（reload / dispose）：此时 SDK 的 onclose 不算「掉线」 */
  closing?: boolean;
}

async function connectServer(name: string, config: McpServerConfig): Promise<ServerState> {
  const client = new Client({ name: "colt", version: "0.0.1" });
  const state: ServerState = { name, config, client, tools: [] };
  try {
    await withTimeout(client.connect(buildTransport(config)), CONNECT_TIMEOUT_MS, `连接 MCP server "${name}"`);
    const listed = await listAllTools(client, name);
    state.tools = listed.map((tool) => wrapTool(name, tool, client));
    // 连上**之后**掉线要如实反映：否则设置页会一直显示「已连接」、而工具调用早已失败——
    // 持续撒谎比没有信号更糟（AGENTS.md §四）。两个约束：
    // ① SDK 的 `onclose` 在**我们主动 close() 时同样触发**，所以先看 closing 标记，
    //    别把 reload / dispose 自己的关闭误报成「断开」；
    // ② 刻意**不**接 `onerror`：SDK 明说那里的 error「不一定是致命的」，拿它翻状态
    //    会把健康 server 误标成红点，那种假信号比没有信号更贵。掉线一律以 onclose 为准。
    client.onclose = () => {
      if (state.closing === true) return;
      state.error = "连接已断开（server 进程退出或网络中断）";
    };
    liveClients.add(client);
    armExitHook();
    return state;
  } catch (error) {
    state.closing = true;
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function closeState(state: ServerState): Promise<void> {
  const client = state.client;
  if (client === undefined) return;
  state.closing = true;
  state.client = undefined;
  liveClients.delete(client);
  await client.close().catch(() => undefined);
}

/** 热重载 / 首次装载的产物：新工具清单 + 各 server 现状 + 一行摘要 */
export interface McpReloadResult {
  tools: AgentHarnessTool<ExecutionToolContext>[];
  statuses: McpServerView[];
  /** 空串 = 无事可报（没配、也没告警）；非空则调用方原样发 notice */
  summary: string;
}

/** 一个会话（= 一个 worker 进程）持有的 MCP 运行态 */
export interface McpRuntime {
  readonly tools: AgentHarnessTool<ExecutionToolContext>[];
  reload(): Promise<McpReloadResult>;
  status(): McpServerView[];
  close(): Promise<void>;
}

/**
 * 建一个 MCP runtime 并就地装载。
 *
 * 与技能同一条隐式信任通道：MCP server 是**会话启动时即执行的本地代码**，
 * 装了什么、坏在哪里必须如实告知（摘要由调用方按 security 类发 notice）。
 */
export async function createMcpRuntime(
  cwd: string,
  notify: (message: string) => void,
): Promise<McpRuntime> {
  const states = new Map<string, ServerState>();
  const diagnostics: string[] = [];

  /**
   * 汇总全量工具，并按**注册名**去重。
   *
   * 去重不是可选项：内核 `validateToolNames` 见到重名会直接 `TypeError`——
   * 两个 server 撞名（或同一 server 的两个工具清洗后撞名）会让整个
   * `AgentHarness.create` 崩掉，那比"少一个工具"严重得多。这里保留先到的、
   * 把后到的记进通知，让人去改配置。
   */
  const buildTools = (): { tools: AgentHarnessTool<ExecutionToolContext>[]; collisions: string[] } => {
    const owner = new Map<string, string>();
    const tools: AgentHarnessTool<ExecutionToolContext>[] = [];
    const collisions: string[] = [];
    for (const state of states.values()) {
      for (const tool of state.tools) {
        const existing = owner.get(tool.name);
        if (existing !== undefined) {
          collisions.push(
            `「${existing}」与「${state.name}」都声明了工具 ${tool.name}，保留「${existing}」的那份`,
          );
          continue;
        }
        owner.set(tool.name, state.name);
        tools.push(tool);
      }
    }
    return { tools, collisions };
  };

  const status = (): McpServerView[] =>
    [...states.values()].map((state) => ({
      name: state.name,
      transport: transportOf(state.config) ?? "stdio",
      target: targetOf(state.config),
      status: state.error === undefined ? ("connected" as const) : ("error" as const),
      tools: state.tools.map((tool) => tool.name),
      ...(state.error === undefined ? {} : { error: state.error }),
    }));

  const reload = async (): Promise<McpReloadResult> => {
    const config = await loadMcpConfig(cwd);
    diagnostics.length = 0;
    diagnostics.push(...config.diagnostics);

    // 关掉：不再声明的、或配置变了的（含"上次连失败、这次配置仍不同"的必然重试）
    for (const [name, state] of [...states]) {
      const next = config.servers[name];
      if (next === undefined || configKey(next) !== configKey(state.config)) {
        await closeState(state);
        states.delete(name);
      }
    }
    // 连接：新声明的，以及**上一轮连失败 / 连上后掉线**的——配置没变也重试。
    // 不重试的话「重新加载」对失败态就是个死按钮：server 只是起晚了（后端刚发布）、
    // 网络刚恢复、或进程崩了重启，用户点多少次都救不回来——直接推翻设置页那句
    // 「改完点「重新加载」即可生效」。已连好的不重连（那是浪费，见上面的配置等价键）。
    for (const [name, declared] of Object.entries(config.servers)) {
      const existing = states.get(name);
      if (existing !== undefined && existing.error === undefined) continue;
      if (existing !== undefined) await closeState(existing);
      const resolved = interpolateConfig(declared, process.env);
      if (typeof resolved === "string") {
        const message = `server "${name}" ${resolved}`;
        diagnostics.push(message);
        states.set(name, { name, config: declared, tools: [], error: message });
        continue;
      }
      try {
        states.set(name, await connectServer(name, resolved));
      } catch (error) {
        const message = `server "${name}" 连接失败：${describeError(error)}`;
        diagnostics.push(message);
        states.set(name, { name, config: declared, tools: [], error: message });
      }
    }

    const { tools, collisions } = buildTools();
    const connected = [...states.values()]
      .filter((state) => state.error === undefined)
      .map((state) => `${state.name}（${state.tools.length} 个工具）`);
    const parts: string[] = [];
    if (connected.length > 0) {
      parts.push(`已连接 ${connected.length} 个 MCP server：${connected.join("、")}`);
    }
    if (diagnostics.length > 0) {
      parts.push(`MCP 告警 ${diagnostics.length} 条：${diagnostics.join("；")}`);
    }
    if (collisions.length > 0) {
      parts.push(`MCP 工具重名 ${collisions.length} 条：${collisions.join("；")}`);
    }
    const summary = parts.join("；");
    if (summary !== "") notify(summary);
    return { tools, statuses: status(), summary };
  };

  await reload();
  return {
    get tools() {
      return buildTools().tools;
    },
    reload,
    status,
    close: async () => {
      const closing = [...states.values()];
      states.clear();
      await Promise.all(closing.map((state) => closeState(state)));
    },
  };
}

/**
 * 一次性装载（首次接入的简写形态，单测与外部工具用）。
 *
 * 连接登记在模块级 `liveClients` 上，`closeMcpTools()` 统一回收；要热重载 / 查状态
 * 的调用方改用 `createMcpRuntime`。
 */
export async function loadMcpTools(
  cwd: string,
  notify: (message: string) => void,
): Promise<AgentHarnessTool<ExecutionToolContext>[]> {
  const runtime = await createMcpRuntime(cwd, notify);
  return runtime.tools;
}
