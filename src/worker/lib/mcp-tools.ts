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

/**
 * 单个 server 的**连接 / 列工具**超时：挂死的 server 不许拖住会话启动。
 * 交给 SDK 原生的 `timeout` 选项（`RequestOptions.timeout`，超时会真取消请求并抛
 * `RequestTimeout`），**不用 `Promise.race`**——后者超时后底层请求还在跑，只是我们
 * 提前认输；只有 `callTool` 不传这个值，走 SDK 默认的 60s（`DEFAULT_REQUEST_TIMEOUT_MSEC`）。
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * 自动翻页的页数上限，钉在 `Client` 上（`ClientOptions.listMaxPages`，触顶抛错、
 * 不缓存半份聚合）。v2 的 `listTools()` **不传 cursor 时会自己翻完所有页**，所以这个
 * 上限是唯一的分页兜底——留它是为了兜住「server 永远回同一个 cursor」这种坏实现。
 * 显式写出来是为了让人一眼看到这个数，而不是去翻 SDK 默认值（默认 64）。
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

/** 按**解析后**的配置造传输：stdio 走子进程，远程走 Streamable HTTP / SSE（headers 透传）。
 *  入参必须是 `interpolateConfig` 的产物——`${VAR}` 在这里才被换成真实值，且**只**在这里。 */
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

/**
 * 拉全量工具。
 *
 * v2 的 `listTools()` **不传 cursor 时会自己翻完所有页并聚合**（实测：夹具 5 工具 / 每页 2 个，
 * 一次调用拿回 5 条、`nextCursor` 为 undefined；只有显式传 `cursor` 才回单页）。所以这里
 * **不写循环**——客户端侧也没法「主动要第一页」（省略 cursor 就等于「全给我」），自己写循环
 * 只会得到一段**永远只跑一轮的死代码**（v2 迁移前那段按 `nextCursor` 翻页的循环正是如此，
 * `MAX_TOOL_PAGES` 根本没被读到）。非收敛（cursor 重复）停了、页数触顶抛错，都由 SDK 兜。
 */
async function listAllTools(client: Client): Promise<ListedTool[]> {
  const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
  return listed.tools as unknown as ListedTool[];
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

/** 无参能力工具的入参：空对象（裸 JSON Schema，与工具同款透传） */
const NO_ARGS_SCHEMA = { type: "object", properties: {} };

/** `resources/read` 的入参 */
const READ_RESOURCE_SCHEMA = {
  type: "object",
  properties: {
    uri: { type: "string", description: "资源 URI（先用 list_resources 拿）" },
  },
  required: ["uri"],
};

/** `prompts/get` 的入参 */
const GET_PROMPT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "提示词名（先用 list_prompts 拿）" },
    arguments: {
      type: "object",
      description: "提示词参数（键值都是字符串；哪个必填见 list_prompts）",
      additionalProperties: { type: "string" },
    },
  },
  required: ["name"],
};

/** 结构化的返回序列化成给模型读的文本（清单类结果不是富媒体，没必要拆内容块） */
function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** 资源内容块 → 内核内容块：文本原样；二进制**不展开**（base64 塞进上下文既费 token 又读不了） */
function mapResourceContents(entry: unknown): TextContent | ImageContent {
  const item = entry as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown };
  if (typeof item.text === "string") return { type: "text", text: item.text };
  if (typeof item.blob === "string") {
    return {
      type: "text",
      text:
        `[mcp] 资源 ${String(item.uri ?? "")} 是二进制（${String(item.mimeType ?? "unknown")}，` +
        `${item.blob.length} 字节 base64），未展开`,
    };
  }
  return { type: "text", text: `[mcp] 资源 ${String(item.uri ?? "")} 没有可读内容` };
}

/** 提示词消息 → 文本：`<role>: <内容>`；图片/资源块压成文字标记，别丢信息、也不假装能看 */
function promptMessagesText(messages: unknown): string {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .map((raw) => {
      const message = raw as { role?: unknown; content?: unknown };
      const role = typeof message.role === "string" ? message.role : "unknown";
      const text = mapMcpContent({ content: [message.content] })
        .map((block) => (block.type === "text" ? block.text : "[图片]"))
        .join("\n");
      return `${role}: ${text}`;
    })
    .join("\n\n");
}

/**
 * 把 server **声明的** `resources` / `prompts` 能力包成内核工具。
 *
 * 为什么不走内核的 `resources.promptTemplates` + `lane.promptFromTemplate`（那条路存在且活着，
 * 见 `lane.js`）：它要求「模板正文在客户端、参数由**客户端**格式化」，而 MCP 的 prompt 是
 * **服务端**按类型化参数渲染的（`prompts/get`）——硬塞会得到一个「参数根本传不进服务端」的假接口。
 * 包成工具则天然过 `before_tool` 审批闸门，与 `tools` 面**同一套**安全模型（零例外）。
 *
 * 只在 server **主动声明**该能力时才加（`getServerCapabilities()`）：没声明就不往清单里塞
 * 用不上的入口——与技能/子代理同一条「别放死控件」的纪律（AGENTS.md §3.6）。
 * 调用超时走 SDK 默认（60s，同 `callTool`），这些是**按需**发起的，不卡会话启动那条 15s 线。
 */
function capabilityTools(
  serverName: string,
  client: Client,
  capabilities: { resources?: unknown; prompts?: unknown } | undefined,
): AgentHarnessTool<ExecutionToolContext, TSchema, undefined>[] {
  const tools: AgentHarnessTool<ExecutionToolContext, TSchema, undefined>[] = [];
  const label = (suffix: string): string => `MCP ${serverName}: ${suffix}`;
  if (capabilities?.resources !== undefined) {
    tools.push({
      name: mcpToolName(serverName, "list_resources"),
      label: label("list_resources"),
      description: `列出 MCP server "${serverName}" 暴露的资源与资源模板（URI / 名称 / MIME 类型）。`,
      parameters: NO_ARGS_SCHEMA as unknown as TSchema,
      async execute() {
        const listed = await client.listResources();
        let templates: unknown = [];
        try {
          templates = (await client.listResourceTemplates()).resourceTemplates;
        } catch {
          // 有「声明了 resources 却不支持模板列举」的 server；模板是附加信息，取不到就留空
        }
        return {
          content: [
            { type: "text", text: jsonText({ resources: listed.resources, resourceTemplates: templates }) },
          ],
          details: undefined,
        };
      },
    });
    tools.push({
      name: mcpToolName(serverName, "read_resource"),
      label: label("read_resource"),
      description: `读取 MCP server "${serverName}" 上某个 URI 的资源内容（URI 从 list_resources 拿）。`,
      parameters: READ_RESOURCE_SCHEMA as unknown as TSchema,
      async execute(_toolCallId, params) {
        const { uri } = params as { uri: string };
        const result = await client.readResource({ uri });
        const contents = Array.isArray(result.contents) ? result.contents : [];
        return {
          content:
            contents.length > 0
              ? contents.map(mapResourceContents)
              : [{ type: "text", text: "[mcp] 该资源没有内容" }],
          details: undefined,
        };
      },
    });
  }
  if (capabilities?.prompts !== undefined) {
    tools.push({
      name: mcpToolName(serverName, "list_prompts"),
      label: label("list_prompts"),
      description: `列出 MCP server "${serverName}" 提供的提示词（名称 / 说明 / 参数）。`,
      parameters: NO_ARGS_SCHEMA as unknown as TSchema,
      async execute() {
        const listed = await client.listPrompts();
        return { content: [{ type: "text", text: jsonText(listed.prompts) }], details: undefined };
      },
    });
    tools.push({
      name: mcpToolName(serverName, "get_prompt"),
      label: label("get_prompt"),
      description: `按名取 MCP server "${serverName}" 的一条提示词（由服务端按 arguments 渲染后返回）。`,
      parameters: GET_PROMPT_SCHEMA as unknown as TSchema,
      async execute(_toolCallId, params) {
        const { name, arguments: args } = params as {
          name: string;
          arguments?: Record<string, string>;
        };
        const result = await client.getPrompt({ name, arguments: args });
        const text = promptMessagesText(result.messages);
        return {
          content: [{ type: "text", text: text === "" ? "[mcp] 该提示词没有内容" : text }],
          details: undefined,
        };
      },
    });
  }
  return tools;
}

/** 一个 server 的运行态：连上了就有 client + tools；失败（或连上后掉线）则带 error */
interface ServerState {
  name: string;
  /**
   * **声明值**——配置文件里那串原样的，**没展开 `${VAR}`**。两处都靠它，缺一不可：
   * - 热重载的变更判定（`configKey(next) !== configKey(state.config)`）：若存解析值，
   *   凡是用 `${VAR}` 的配置就**永远**与文件里的声明不相等，于是每次「重新加载」都把它
   *   关掉重连一次——决策 7 明说「已连好的不重连」；
   * - `status()` 的 `target`（设置页画的就是它）：若存解析值，`args: ["--token", "${TOKEN}"]`
   *   会把**真实密钥**画在设置页上。声明值则原样显示 `${TOKEN}`，既如实又不泄密。
   * 解析值只在 `connectServer` 的 `resolved` 参数里活一次，进 `buildTransport` 造传输，
   * 别落到这个字段上。
   */
  config: McpServerConfig;
  client?: Client;
  tools: AgentHarnessTool<ExecutionToolContext, TSchema, undefined>[];
  /** server 自报的用法说明（握手时的 `InitializeResult.instructions`）；没报就没有这项 */
  instructions?: string;
  error?: string;
  /** 我们主动关的（reload / dispose）：此时 SDK 的 onclose 不算「掉线」 */
  closing?: boolean;
}

async function connectServer(
  name: string,
  declared: McpServerConfig,
  resolved: McpServerConfig,
): Promise<ServerState> {
  const client = new Client({ name: "colt", version: "0.0.1" }, { listMaxPages: MAX_TOOL_PAGES });
  // config 存声明值（见 ServerState.config）：resolved 只用于造传输
  const state: ServerState = { name, config: declared, client, tools: [] };
  try {
    await client.connect(buildTransport(resolved), { timeout: CONNECT_TIMEOUT_MS });
    const listed = await listAllTools(client);
    // 工具面 + 该 server **声明了**的 resources / prompts 能力面（没声明就不加，见 capabilityTools）
    state.tools = [
      ...listed.map((tool) => wrapTool(name, tool, client)),
      ...capabilityTools(name, client, client.getServerCapabilities()),
    ];
    // server 自报的「怎么用我」。这里只**保留**；拼进系统提示词是另一处的事
    // （见 `lib/mcp-reload.ts` 的 composeMcpInstructions）——SDK 只给取值口，不会替你塞。
    const instructions = client.getInstructions()?.trim();
    if (instructions !== undefined && instructions !== "") state.instructions = instructions;
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
  /**
   * 各 server 在握手里自报的用法说明（`InitializeResult.instructions`），按 server 名排序。
   * 拼进系统提示词**由应用自己做**（`lib/mcp-reload.ts` 的 `composeMcpInstructions`）——
   * SDK 只提供 `client.getInstructions()` 这个取值口，一处都不会替你调（见该函数注释）。
   */
  instructions(): { server: string; text: string }[];
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
        states.set(name, await connectServer(name, declared, resolved));
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
    instructions: () =>
      [...states.values()]
        .flatMap((state) =>
          state.instructions === undefined
            ? []
            : [{ server: state.name, text: state.instructions }],
        )
        .sort((a, b) => a.server.localeCompare(b.server)),
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
