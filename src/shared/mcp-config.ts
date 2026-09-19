// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * MCP server 配置的**纯解析层**：不连网络、不 import 官方 SDK。
 *
 * 为什么单独成文件：这份配置要**两侧共用**——worker 侧据它连 server
 * （`worker/lib/mcp-tools.ts`），主进程侧据它**在会话没打开时**也能列出
 * 「声明了哪些 server」（设置页可见性）。若把它留在 worker 那个文件里，
 * 主进程为了读一个 JSON 就得把整个官方 SDK 拖进主进程。
 *
 * 配置形态：JSON 的 `mcpServers`，每个条目二选一：
 * - stdio：`command`（+ `args` / `env`）——本地子进程
 * - 远程：`url`（+ `headers` / `transport`，缺省 Streamable HTTP）——HTTP / SSE
 *
 * **两级**，与技能 / 记忆同一条「用户目录 + 项目」的心智（见 `loadMcpConfig`）：
 * - 用户级 `<home>/.colt/mcp.json`——对**全部项目**生效（常见 server 只配一次）；
 * - 项目级 `<cwd>/.colt/mcp.json`——**同名覆盖**用户级（换版本 / 关掉某台）。
 *
 * 值里的 `${VAR}` 按进程环境变量展开（见 `interpolateConfig`）；只支持
 * `${NAME}` 这一种写法，不做 shell 式的 `$NAME` / 默认值语法——MCP 配置不是 shell。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 传输类型：stdio 子进程 / Streamable HTTP / 旧式 SSE */
export type McpTransport = "stdio" | "http" | "sse";

/** `.colt/mcp.json` 里单个 server 的声明 */
export interface McpServerConfig {
  /** stdio：可执行文件；与 `url` 二选一 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** 远程：server 地址；与 `command` 二选一 */
  url?: string;
  headers?: Record<string, string>;
  /** 远程传输方式；缺省 http（Streamable HTTP），仅远程有意义 */
  transport?: "http" | "sse";
}

interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
}

/** `<cwd>/.colt/mcp.json` 的路径（读取与诊断消息共用同一处口径） */
export function mcpConfigPath(cwd: string): string {
  return join(cwd, ".colt", "mcp.json");
}

/** 用户级配置 `<home>/.colt/mcp.json` 的路径——与技能 / 记忆共用同一个用户目录 */
export function userMcpConfigPath(home: string): string {
  return join(home, ".colt", "mcp.json");
}

/**
 * 用户级配置所在的「家目录」。默认 `os.homedir()`；`COLT_MCP_HOME` 可覆盖它。
 *
 * 为什么要这个覆盖口：用户级配置一旦生效，**这台机器上用户自己的 `~/.colt/mcp.json`
 * 就成了一条环境前提**——单测与冒烟若不去固定它，结果会随开发者的机器而变
 * （`AGENTS.md` §五⑬ 那次 `glm` 抢走默认解析的同族）。冒烟把它指到一个空目录，
 * 于是「没有用户级配置」这条前提是**显式建立**的，而不是「碰巧这台机器上没配」。
 */
export function mcpUserHome(): string {
  return process.env.COLT_MCP_HOME ?? homedir();
}

/** 一份合法配置的传输方式；未声明 command / url 时返回 undefined */
export function transportOf(config: McpServerConfig): McpTransport | undefined {
  if (config.command !== undefined) return "stdio";
  if (config.url !== undefined) return config.transport === "sse" ? "sse" : "http";
  return undefined;
}

/** 界面展示用的目标串：stdio 是命令 + 参数，远程是 URL */
export function targetOf(config: McpServerConfig): string {
  if (config.command !== undefined) return [config.command, ...(config.args ?? [])].join(" ");
  return config.url ?? "";
}

/**
 * 配置等价键：热重载据此判断「这个 server 变了没」。
 * 键序无关（env / headers 排序后序列化）——否则用户只是调整了书写顺序就会被判成变更、白重连一次。
 */
export function configKey(config: McpServerConfig): string {
  const sorted = (dict: Record<string, string> | undefined): Record<string, string> | undefined =>
    dict === undefined
      ? undefined
      : Object.fromEntries(Object.entries(dict).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({
    command: config.command,
    args: config.args,
    env: sorted(config.env),
    url: config.url,
    headers: sorted(config.headers),
    transport: config.transport,
  });
}

function readStringDict(
  name: string,
  key: string,
  raw: unknown,
): Record<string, string> | string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `server "${name}" 的 ${key} 必须是字符串字典`;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== "string")) {
    return `server "${name}" 的 ${key} 必须是字符串字典`;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** 校验并归一一个 server 声明；不合法返回诊断字符串 */
export function parseServerConfig(name: string, raw: unknown): McpServerConfig | string {
  if (typeof raw !== "object" || raw === null) return `server "${name}" 的配置不是对象`;
  const candidate = raw as Record<string, unknown>;
  const command = typeof candidate.command === "string" ? candidate.command.trim() : "";
  const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
  if (candidate.command !== undefined && command === "") {
    return `server "${name}" 的 command 必须是非空字符串`;
  }
  if (candidate.url !== undefined && url === "") {
    return `server "${name}" 的 url 必须是非空字符串`;
  }
  if (command !== "" && url !== "") {
    return `server "${name}" 不能同时声明 command 与 url（stdio 与远程二选一）`;
  }
  if (command === "" && url === "") return `server "${name}" 缺少 command 或 url`;

  const config: McpServerConfig = {};
  if (command !== "") config.command = command;
  if (url !== "") config.url = url;

  if (candidate.args !== undefined) {
    if (!Array.isArray(candidate.args) || candidate.args.some((arg) => typeof arg !== "string")) {
      return `server "${name}" 的 args 必须是字符串数组`;
    }
    config.args = candidate.args as string[];
  }
  const env = readStringDict(name, "env", candidate.env);
  if (typeof env === "string") return env;
  if (env !== undefined) config.env = env;
  const headers = readStringDict(name, "headers", candidate.headers);
  if (typeof headers === "string") return headers;
  if (headers !== undefined) config.headers = headers;

  if (candidate.transport !== undefined) {
    if (candidate.transport !== "http" && candidate.transport !== "sse") {
      return `server "${name}" 的 transport 只能是 "http" 或 "sse"`;
    }
    config.transport = candidate.transport;
  }
  return config;
}

/** 读**单个**配置文件；`label` 是给用户看的路径（诊断里点名是哪个文件出的问题） */
async function readConfigFile(
  path: string,
  label: string,
): Promise<{ servers: Record<string, McpServerConfig>; diagnostics: string[] }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { servers: {}, diagnostics: [] }; // 没配就是没配，不是错误
  }
  let parsed: McpConfigFile;
  try {
    parsed = JSON.parse(raw) as McpConfigFile;
  } catch (error) {
    return {
      servers: {},
      diagnostics: [
        `${label}：不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const servers: Record<string, McpServerConfig> = {};
  const diagnostics: string[] = [];
  for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
    const config = parseServerConfig(name, value);
    if (typeof config === "string") diagnostics.push(`${label}：${config}`);
    else servers[name] = config;
  }
  return { servers, diagnostics };
}

/**
 * 读 MCP 配置：**用户级 + 项目级**两份合并，项目级**同名覆盖**用户级。
 *
 * - 用户级 `<home>/.colt/mcp.json`：对全部项目生效——常见的 server（filesystem、
 *   fetch 之类）配一次即可，不必每个项目抄一遍（技能 / 记忆早已是这条心智）。
 * - 项目级 `<cwd>/.colt/mcp.json`：同名覆盖用户级——「这个项目要换一个版本 /
 *   临时关掉某台」的出口就是它。
 *
 * `home` 省略时**不读用户级**：单测默认走这条，于是它们的结论只取决于自己造的
 * 夹具目录，不随开发者的 `~/.colt/mcp.json` 漂移（生产调用方一律传 `mcpUserHome()`）。
 * 诊断带文件名，两份都能说清「是哪个文件、哪一条」。
 */
export async function loadMcpConfig(
  cwd: string,
  home?: string,
): Promise<{ servers: Record<string, McpServerConfig>; diagnostics: string[] }> {
  const project = await readConfigFile(mcpConfigPath(cwd), ".colt/mcp.json");
  if (home === undefined) return project;
  const user = await readConfigFile(userMcpConfigPath(home), "~/.colt/mcp.json");
  return {
    servers: { ...user.servers, ...project.servers },
    diagnostics: [...project.diagnostics, ...user.diagnostics],
  };
}

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function interpolateValue(
  value: string,
  env: Record<string, string | undefined>,
  missing: Set<string>,
): string {
  return value.replace(VAR_PATTERN, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      missing.add(name);
      return "";
    }
    return resolved;
  });
}

/**
 * 展开配置里的 `${VAR}`。
 *
 * 缺变量**不静默留空**：留空会把 `https://${HOST}/mcp` 变成一个看似合法、实则指向错处的
 * URL（或把一个空参数喂给命令），失败还会来得莫名其妙。这里收集缺失名返回诊断，
 * 由调用方跳过该 server——坏一个不拦其余。
 */
export function interpolateConfig(
  config: McpServerConfig,
  env: Record<string, string | undefined>,
): McpServerConfig | string {
  const missing = new Set<string>();
  const spread = (dict: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(dict).map(([key, value]) => [key, interpolateValue(value, env, missing)]),
    );
  // 只保留**声明过**的字段：不要造出一堆值为 undefined 的键——调用方会拿结果去比较
  // （`configKey`）或直接用（`buildTransport`），多出来的空洞键只会制造困惑。
  const resolved: McpServerConfig = {};
  if (config.command !== undefined) resolved.command = interpolateValue(config.command, env, missing);
  if (config.args !== undefined) {
    resolved.args = config.args.map((arg) => interpolateValue(arg, env, missing));
  }
  if (config.env !== undefined) resolved.env = spread(config.env);
  if (config.url !== undefined) resolved.url = interpolateValue(config.url, env, missing);
  if (config.headers !== undefined) resolved.headers = spread(config.headers);
  if (config.transport !== undefined) resolved.transport = config.transport;
  if (missing.size > 0) return `引用了未定义的环境变量：${[...missing].join("、")}`;
  return resolved;
}
