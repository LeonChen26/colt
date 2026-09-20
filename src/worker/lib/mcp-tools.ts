// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { TSchema } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { McpServerView } from "@shared/worker-protocol";
import { MCP_STARTUP_BUDGET_MS, MCP_STEP_TIMEOUT_MS } from "@shared/limits";
import { MCP_TOOL_PREFIX, mcpToolLabel } from "@shared/mcp-label";
import {
  callTimeoutOf,
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
  callTimeoutOf,
  configKey,
  interpolateConfig,
  loadMcpConfig,
  mcpConfigPath,
  mcpUserHome,
  parseServerConfig,
  targetOf,
  transportOf,
  userMcpConfigPath,
  type McpServerConfig,
} from "@shared/mcp-config";

/** 工具名前缀：注册名、审批签名、界面展示**同源**（定义在 `@shared/mcp-label`，渲染层也要用） */
export { MCP_TOOL_PREFIX };

/** LLM API 对工具名普遍有 64 字符上限（含前缀），超长的截断并记诊断 */
export const MAX_TOOL_NAME_CHARS = 64;

/**
 * 单个 server 的**连接 / 列工具**超时：挂死的 server 不许拖住会话启动。
 * 交给 SDK 原生的 `timeout` 选项（`RequestOptions.timeout`，超时会真取消请求并抛
 * `RequestTimeout`），**不用 `Promise.race`**——后者超时后底层请求还在跑，只是我们
 * 提前认输。
 *
 * **调用**（`callTool` / `readResource` / `getPrompt` 等）是另一条线：不传就是 SDK
 * 默认的 60s（`DEFAULT_REQUEST_TIMEOUT_MSEC`），由配置的 `timeout` / `toolTimeouts`
 * 放宽（见 `callTimeoutOf`）——编译、下载这类正当长工具不该被 60s 就地掐断。
 *
 * 值定义在 `@shared/limits`：主进程「等 MCP 回话」的预算要按它算（那里记着为什么
 * 不能让两侧各写一份）。
 */

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
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
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
    } else if (block.type === "resource" && block.resource !== undefined) {
      // 内嵌资源（工具结果 / `prompts/get` 消息里的 EmbeddedResource）一律交给
      // `mapResourceContents`：文本直取，二进制只说清「二进制 + MIME + 长度」、**不展开**。
      // 刻意复用同一个函数是为了与 `read_resource` 同一口径——此前这里只认 `.text`，
      // blob 会掉进下面那个 else、被说成「不支持的内容块类型：resource」：明明是支持的
      // 类型，却在说反话（同一条资源，`read_resource` 说得好好的，工具结果里就说反了）。
      out.push(mapResourceContents(block.resource));
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
 *  入参必须是 `interpolateConfig` 的产物——`${VAR}` 在这里才被换成真实值，且**只**在这里。
 *
 *  `cwd` 是**会话的项目根**，作为 stdio 子进程的工作目录（`StdioServerParameters.cwd`；
 *  不传则「继承当前进程的 cwd」）。这一步不能省：worker 是
 *  `utilityProcess.fork(workerPath, [], {…})` 起的、**没带 `cwd`**，于是它自己的 cwd 是
 *  **应用进程的**（dev 下就是仓库根，打包后是应用目录），跟用户的项目毫无关系。而
 *  `args: ["."]` / `["src"]` / `["dist"]` 这类**相对路径正是最主流的写法**（官方
 *  `server-filesystem` 的例子就写着 `.`），用户把它写在项目里的 `.colt/mcp.json`，当然指望
 *  相对项目根解析。实测（2026-09-19 审计 ⑧）：相对参数被解析成 `E:\code\tests\…`（从仓库根
 *  退了两级），server 直接 `Cannot find module`、连不上——而设置页只会说「连接失败」。 */
function buildTransport(config: McpServerConfig, cwd: string): AnyTransport {
  if (config.command !== undefined) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...config.env },
      cwd,
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
  const listed = await client.listTools(undefined, { timeout: MCP_STEP_TIMEOUT_MS });
  return listed.tools as unknown as ListedTool[];
}

/** 按 server 原始工具名解析调用超时（毫秒）；未配置返回 undefined（交给 SDK 默认 60s） */
type ToolTimeoutResolver = (toolName: string) => number | undefined;

/** 把一个 MCP 工具包成内核工具（名字前缀、裸 schema 透传、失败要 throw） */
function wrapTool(
  serverName: string,
  tool: ListedTool,
  client: Client,
  timeout: number | undefined,
): AgentHarnessTool<ExecutionToolContext, TSchema, undefined> {
  return {
    name: mcpToolName(serverName, tool.name),
    label: mcpToolLabel(mcpToolName(serverName, tool.name)) ?? `MCP ${serverName}: ${tool.name}`,
    description: tool.description ?? `MCP server "${serverName}" 的 ${tool.name} 工具`,
    // 裸 JSON Schema 原样透传：pi-ai 的 validateToolArguments 对非 typebox
    // schema 有专门的 coercion + 编译路径（见文件头注释）
    parameters: tool.inputSchema as unknown as TSchema,
    async execute(_toolCallId, params) {
      const result = (await client.callTool(
        { name: tool.name, arguments: params as Record<string, unknown> },
        { timeout },
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
 * 调用超时同 `callTool`：走配置的 `timeout` / `toolTimeouts`（键就是能力工具名，
 * 如 `read_resource`），未配置退回 SDK 默认 60s——这些是**按需**发起的，不卡会话启动那条 15s 线。
 */
function capabilityTools(
  serverName: string,
  client: Client,
  capabilities: { resources?: unknown; prompts?: unknown } | undefined,
  timeoutFor: ToolTimeoutResolver,
): AgentHarnessTool<ExecutionToolContext, TSchema, undefined>[] {
  const tools: AgentHarnessTool<ExecutionToolContext, TSchema, undefined>[] = [];
  const label = (suffix: string): string =>
    mcpToolLabel(mcpToolName(serverName, suffix)) ?? `MCP ${serverName}: ${suffix}`;
  if (capabilities?.resources !== undefined) {
    tools.push({
      name: mcpToolName(serverName, "list_resources"),
      label: label("list_resources"),
      description: `列出 MCP server "${serverName}" 暴露的资源与资源模板（URI / 名称 / MIME 类型）。`,
      parameters: NO_ARGS_SCHEMA as unknown as TSchema,
      async execute() {
        const timeout = timeoutFor("list_resources");
        const listed = await client.listResources(undefined, { timeout });
        let templates: unknown = [];
        try {
          templates = (await client.listResourceTemplates(undefined, { timeout })).resourceTemplates;
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
        const result = await client.readResource({ uri }, { timeout: timeoutFor("read_resource") });
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
        const listed = await client.listPrompts(undefined, { timeout: timeoutFor("list_prompts") });
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
        const result = await client.getPrompt(
          { name, arguments: args },
          { timeout: timeoutFor("get_prompt") },
        );
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

/**
 * 掉线（连上**之后**断开）的说明文字，只此一份：设置页的 `error` 与那条 notice 都用它，
 * 免得同一件事在界面上有两种说法。
 */
const MCP_DROPPED = "连接已断开（server 进程退出或网络中断）";

/** 纯等待。计时器 `unref`：预算只是个上限，不该由它把进程吊住 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 后台收尾那一次的告知文案（连接结果已经拿到了，这里只负责说清） */
function lateSummary(settled: { name: string; error?: string }[]): string {
  const ok = settled.filter((entry) => entry.error === undefined).map((entry) => entry.name);
  const bad = settled.filter((entry) => entry.error !== undefined);
  const parts: string[] = [];
  if (ok.length > 0) parts.push(`${ok.join("、")} 已连上，工具已补挂生效`);
  if (bad.length > 0) {
    parts.push(bad.map((entry) => `${entry.name}：${entry.error}`).join("；"));
  }
  return `MCP 后台连接结束：${parts.join("；")}`;
}

async function connectServer(
  name: string,
  declared: McpServerConfig,
  resolved: McpServerConfig,
  cwd: string,
  notify: (message: string) => void,
): Promise<ServerState> {
  const client = new Client({ name: "colt", version: "0.0.1" }, { listMaxPages: MAX_TOOL_PAGES });
  // config 存声明值（见 ServerState.config）：resolved 只用于造传输
  const state: ServerState = { name, config: declared, client, tools: [] };
  try {
    await client.connect(buildTransport(resolved, cwd), { timeout: MCP_STEP_TIMEOUT_MS });
    const listed = await listAllTools(client);
    // 调用超时按 server 的**声明值**解析（`timeout` / `toolTimeouts`）——连接用 15s 那条线，
    // 与调用无关；这里解析一次，包进每个工具的 execute 里。
    const timeoutFor: ToolTimeoutResolver = (toolName) => callTimeoutOf(declared, toolName);
    // 工具面 + 该 server **声明了**的 resources / prompts 能力面（没声明就不加，见 capabilityTools）
    state.tools = [
      ...listed.map((tool) => wrapTool(name, tool, client, timeoutFor(tool.name))),
      ...capabilityTools(name, client, client.getServerCapabilities(), timeoutFor),
    ];
    // server 自报的「怎么用我」。这里只**保留**；拼进系统提示词是另一处的事
    // （见 `lib/mcp-reload.ts` 的 composeMcpInstructions）——SDK 只给取值口，不会替你塞。
    const instructions = client.getInstructions()?.trim();
    if (instructions !== undefined && instructions !== "") state.instructions = instructions;
    // 连上**之后**掉线要如实反映：否则设置页会一直显示「已连接」、而工具调用早已失败——
    // 持续撒谎比没有信号更糟（AGENTS.md §四）。三个约束：
    // ① SDK 的 `onclose` 在**我们主动 close() 时同样触发**，所以先看 closing 标记，
    //    别把 reload / dispose 自己的关闭误报成「断开」；
    // ② 刻意**不**接 `onerror`：SDK 明说那里的 error「不一定是致命的」，拿它翻状态
    //    会把健康 server 误标成红点，那种假信号比没有信号更贵。掉线一律以 onclose 为准；
    // ③ **同时作声**（`notify`）：光翻状态等于要用户自己打开设置页才知道。掉线时工具仍留在
    //    清单里（决策 11：不伪造成功结果），于是用户唯一的线索是「某个调用莫名失败」。
    //    这条走 security 类 notice：toast 之外**同时落 session_events**（与装载摘要同一条通道），
    //    所以 5 秒后仍能在「事件」里回查。
    client.onclose = () => {
      if (state.closing === true) return;
      // 只报一次：HTTP 传输会重复触发 onclose（SDK 自己注释：`HTTP transports re-fire onclose`），
      // 而掉线是一次事件，不是一串
      if (state.error !== undefined) return;
      state.error = MCP_DROPPED;
      notify(
        `MCP server "${name}" 连上后掉线：${MCP_DROPPED}。` +
          `它的工具仍在清单里、调用会失败；在设置页点「重新加载」可恢复。`,
      );
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
  /** 后台连接全部落定后回调；首次装载**没超预算**则不回调（下面实现里记着为什么） */
  onSettled(cb: () => void): void;
  close(): Promise<void>;
}

/**
 * 建一个 MCP runtime 并就地装载。
 *
 * 与技能同一条隐式信任通道：MCP server 是**会话启动时即执行的本地代码**，
 * 装了什么、坏在哪里必须如实告知（摘要由调用方按 security 类发 notice）。
 *
 * `home` 传用户主目录即启用**用户级配置**（`~/.colt/mcp.json`，见 `loadMcpConfig`）；
 * 省略则只读项目级——单测默认走这条，结论不随开发者的机器漂移。
 *
 * `options.startupBudgetMs` 覆盖**首次装载**的启动预算（默认 `MCP_STARTUP_BUDGET_MS`）：
 * 会话启动路径不给它配一台慢 server 就能拖死整个会话的能力。传 `Infinity` = 不设预算
 * （等到全部落定为止），只有单测需要这种确定性。
 */
export async function createMcpRuntime(
  cwd: string,
  notify: (message: string) => void,
  home?: string,
  options?: { startupBudgetMs?: number },
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

  /** 正在进行中的那一次重载（互斥用，见下面 `reload` 的注释） */
  let reloadInFlight: Promise<McpReloadResult> | undefined;
  /**
   * 上一轮**没等完**的收尾（只有首次装载超预算时才会有）。
   * 新一轮重载先等它落定——两轮同时改 `states` 会把同一台 server 连两遍。
   */
  let tail: Promise<unknown> = Promise.resolve();
  /** `close()` 已发生：后台连接落定后要就地回收，不能再写进 `states` */
  let closed = false;
  /** 还在跑的后台连接数（`onSettled` 判「全部落定」用） */
  let busy = 0;
  /** 本轮启动是否**真的**欠过一次后台收尾——没欠过就不该有「补挂」这回事（见 `onSettled`） */
  let hasLatePass = false;
  const idleWaiters: (() => void)[] = [];

  /**
   * 连一批 server：**并行**，且不抛。
   *
   * 并行而不是逐台串行：串行时每台的耗时（连接 ≤ `MCP_STEP_TIMEOUT_MS` + 列工具 ≤ 同值）
   * 会**叠加**成 N×30s，而主进程等 worker ready 只有 `READY_TIMEOUT_MS`——4 台连不上
   * 就能把会话拖成「打不开」，且报错指向启动超时而不是那台 server（后者此刻根本没机会
   * 报出来）。并行后总耗时回到「一台的最坏值」，叠加消失。
   *
   * 返回每台的结果（失败也返回结果、不抛）：调用方据此决定要不要转后台。
   * 诊断**在这里就地记**，不等调用方收集——超预算那一支拿不到结果（见 `doReload`），
   * 若靠返回值出诊断，「预算内已经快速失败」的那几台就会被整批丢弃（症状：设置页启动
   * 摘要少一条真告警，只剩每台卡片上的红字）。
   */
  const connectPass = async (
    servers: Record<string, McpServerConfig>,
  ): Promise<{ name: string; error?: string }[]> => {
    const jobs = Object.entries(servers).map(
      async ([name, declared]): Promise<{ name: string; error?: string }> => {
        // 连接：新声明的，以及**上一轮连失败 / 连上后掉线**的——配置没变也重试。
        // 不重试的话「重新加载」对失败态就是个死按钮：server 只是起晚了（后端刚发布）、
        // 网络刚恢复、或进程崩了重启，用户点多少次都救不回来——直接推翻设置页那句
        // 「改完点「重新加载」即可生效」。已连好的不重连（那是浪费，见配置等价键）。
        const existing = states.get(name);
        if (existing !== undefined && existing.error === undefined) return { name };
        if (existing !== undefined) await closeState(existing);
        const resolved = interpolateConfig(declared, process.env);
        if (typeof resolved === "string") {
          const message = `server "${name}" ${resolved}`;
          diagnostics.push(message);
          states.set(name, { name, config: declared, tools: [], error: message });
          return { name, error: message };
        }
        try {
          const state = await connectServer(name, declared, resolved, cwd, notify);
          // 会话已经在连接途中关掉：就地回收，别留下一个没人管的 client 与子进程
          if (closed) {
            await closeState(state);
            return { name };
          }
          states.set(name, state);
          return { name };
        } catch (error) {
          const message = `server "${name}" 连接失败：${describeError(error)}`;
          diagnostics.push(message);
          states.set(name, { name, config: declared, tools: [], error: message });
          return { name, error: message };
        }
      },
    );
    return Promise.all(jobs);
  };

  /**
   * 真身：把配置重读一遍、对齐 `states`。别直接调它——外部一律走 `reload`（要互斥）。
   *
   * `budgetMs` 只由**首次装载**传（会话启动路径）：等不到就带着已连上的那部分先返回，
   * 剩下的转后台（`reload` 的注释里记着为什么这样不会连两遍）。
   */
  const doReload = async (budgetMs?: number): Promise<McpReloadResult> => {
    // 已经关掉的会话不再对齐配置：后台那一支落定后 `onSettled` 会来叫补挂，而 `states`
    // 已被 `close()` 清空——不挡在这里就会**照着配置再连一遍**，给一个已死的会话重新
    // spawn 子进程（`connectPass` 里的 `closed` 分支只回收连上的那台，不拦这次装载）。
    if (closed) return { tools: [], statuses: [], summary: "" };
    const config = await loadMcpConfig(cwd, home);
    diagnostics.length = 0;
    diagnostics.push(...config.diagnostics);

    // 关掉：不再声明的、或配置变了的（含"上次连失败、这次配置仍不同"的必然重试）。
    // 并行也安全——每台各关各的，且这一阶段跑完才进入连接。
    await Promise.all(
      [...states].map(async ([name, state]) => {
        const next = config.servers[name];
        if (next === undefined || configKey(next) !== configKey(state.config)) {
          await closeState(state);
          states.delete(name);
        }
      }),
    );

    const passed = connectPass(config.servers);
    let late: Promise<{ name: string; error?: string }[]> | undefined;
    let lateBudget = 0;
    // `Infinity` = 不设预算（单测要的就是「等到全部落定」这种确定性）：
    // 直接拿它去 `sleep` 会被 setTimeout 当成 1ms，转手就把连接全判成超时
    const budget = budgetMs !== undefined && Number.isFinite(budgetMs) ? budgetMs : undefined;
    if (budget === undefined) {
      await passed;
    } else {
      // 预算到期 = 「先欠着」，不是失败：连接照常在后台跑完。
      // race 只问「赶上了没有」，不收集逐台结果——诊断已由 `connectPass` 就地记好，
      // 在这里收集会在超预算那一支被整批丢弃，丢掉的正是「预算内已经失败」的那几台。
      const inTime = await Promise.race([
        passed.then(() => true),
        sleep(budget).then(() => false),
      ]);
      if (!inTime) {
        late = passed;
        lateBudget = budget;
      }
    }

    if (late !== undefined) {
      const pending = Object.keys(config.servers).filter((name) => !states.has(name));
      busy += 1;
      hasLatePass = true;
      tail = late
        .then((settled) => {
          // 后台那一支的结论**不靠** `diagnostics`：那是本轮摘要的输入，摘要早在预算到期
          // 时就发出去了，此刻写进去没有人再读（下一次重载开头还会清空）。所以这里自己
          // 报一次，且**只报后台那几台**——预算内已连上的首轮 summary 刚说过，重复是噪音。
          const behind = settled.filter((entry) => pending.includes(entry.name));
          if (!closed && behind.length > 0) notify(lateSummary(behind));
        })
        .finally(() => {
          busy -= 1;
          if (busy === 0) for (const cb of idleWaiters.splice(0)) cb();
        });
      // 会话已经可用了，但要说清还有谁没到：否则用户只看到「少了几台」而不知道它们在路上
      if (pending.length > 0) {
        diagnostics.push(
          `${pending.join("、")} 未在 ${lateBudget / 1000}s 内就绪，已转后台继续连接` +
            `（会话照常可用，连上后自动生效）`,
        );
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

  /**
   * 重载（**互斥**）：并发调用**复用同一次**，不排队等第二次。
   *
   * 为什么必须互斥：worker 的命令入口是 `void handle(command)`、**不排队**（`entry.ts`），
   * 两条 `mcpReload` 能交错执行；而重载会跨 `await` 改共享的 `states`——两个重叠时，同一台
   * 「配置变了」的 server 会被连**两遍**：后写进 `states` 的那个赢，先那个 client 只剩
   * `liveClients` 还引用着（连带一个子进程），要等 worker 退出才被收掉。
   *
   * 为什么是「复用」而不是「排队」：重载是幂等的「把现状对齐到配置」，第二次跑拿不到新信息，
   * 只会多连一轮；复用的结果对两个调用方都成立。
   *
   * 可达性说明（2026-09-19 审计 ⑤）：当前设置页在重载期间禁用按钮，所以从界面点不出来；
   * 但 IPC 面本身没设防（渲染层任何代码都能连调两次），这里把约束写进结构而不是靠界面拦。
   */
  const reload = (): Promise<McpReloadResult> => {
    if (reloadInFlight !== undefined) return reloadInFlight;
    reloadInFlight = (async () => {
      // 上一轮若因预算提前返回、收尾还在跑，先让它落定——两轮同时跑会把同一台连两遍
      await tail;
      return doReload();
    })().finally(() => {
      reloadInFlight = undefined;
    });
    return reloadInFlight;
  };

  // 首次装载**走预算**：会话启动不该被任何一台 server 拖住（见 `MCP_STARTUP_BUDGET_MS`）。
  // 这里直接调 doReload（不是 reload）：此刻 `state` 还不存在，设置页的命令还打不进来，
  // 用不着互斥那层包装。
  await doReload(options?.startupBudgetMs ?? MCP_STARTUP_BUDGET_MS);
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
    /**
     * 后台连接**全部落定**后回调一次；首次装载**没有**超预算时**不回调**。
     *
     * 落定与注册的先后无所谓：已落定则回调排在下一个微任务。
     * 用途只有一个：把后台连上的工具补挂进 harness（见 `lib/mcp-reload.ts` 的
     * `armLateMcpAttach`）——会话启动时 harness 的工具数组是一次展开的快照。
     *
     * 为什么不是一切正常时也回调：那等于**每次启动**都白跑一次 `reload()`，而重载末尾
     * 会 `notify(summary)`——用户在会话开头看到两条一模一样的「已连接 N 个 MCP server」
     * （`kind: "security"` 的那类通知还同时落进「事件」页签，于是重复两行）。补挂只欠在
     * 「真有几台没赶上」的时候，判据就是 `hasLatePass`。`closed` 同理——会话都关了，
     * 既没有 harness 值得补挂，也没有用户在看那份现状。
     */
    onSettled: (cb: () => void) => {
      if (!hasLatePass || closed) return;
      if (busy === 0) queueMicrotask(cb);
      else idleWaiters.push(cb);
    },
    close: async () => {
      // 不等后台收尾：会话该关就关。还在连的那台由 `connectPass` 里的 `closed` 分支就地回收。
      closed = true;
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
