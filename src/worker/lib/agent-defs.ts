// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 子代理定义（declarative agents）的发现、解析与目录块——对标 `worker/lib/skills.ts`。
 *
 * 目录（**项目级在前**，同名时它胜出）：
 *   `<cwd>/.agents/agents/<name>.md`
 *   `~/.agents/agents/<name>.md`
 *
 * 文件形如：
 *
 * ```markdown
 * ---
 * description: 只读的代码调研员——在大范围文件里定位事实，给出带出处的结论
 * tools: read, memory_search
 * ---
 * （正文 = 该子代理的系统提示词）
 * ```
 *
 * ⚠️ **frontmatter 是极简解析，不是完整 YAML**：只认 `key: value` 与逗号分隔的数组。
 * 内核**没有导出**它的 frontmatter 解析器（`loadSkills` 内部用了，但不出现在包里），
 * 而为一个 `description` + 一行工具名去引一个 YAML 依赖，代价远大于收益。
 * 因此这里对不认识的写法**报错**而不是猜（见 `parseAgentFile`）——静默猜错会让
 * 「工具白名单」这个安全边界变成一团模糊。
 *
 * 与技能同一条隐式信任通道：定义来自磁盘、会决定子代理的系统提示词与工具面，
 * 故装载了什么、跳过了什么都要**如实报出来**（`docs/SECURITY.md`）。
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** agent 定义目录（**项目级在前**，同名时它胜出） */
export function agentDirs(cwd: string, home: string): string[] {
  return [join(cwd, ".agents", "agents"), join(home, ".agents", "agents")];
}

export interface AgentDef {
  /** 名字取**文件名**（去掉 `.md`），目录内唯一 */
  name: string;
  /** 必填——它要进给模型看的目录块 */
  description: string;
  /**
   * 工具白名单。`null` 表示**默认工具集**（除子代理自身外的全部已注册工具）——
   * 内建 `general` 用它。空数组不是合法定义（见 `parseAgentFile`）。
   */
  tools: string[] | null;
  /** 正文 = 该子代理的系统提示词 */
  body: string;
  source: "project" | "user" | "builtin";
  /** 展示用来源（文件路径 / 「内置」） */
  path: string;
}

/** 解析结果：失败时给一句**可照着改**的中文说明（别只说「格式错」） */
export type ParseAgentResult =
  | { ok: true; description: string; tools: string[]; body: string }
  | { ok: false; reason: string };

/**
 * 解析一个 agent 定义文件。
 *
 * 三步都在这里定死：① frontmatter 必须存在且闭合；② `description` 必填非空；
 * ③ `tools` 必须列出至少一个名字（**不能省**——白名单是安全边界，
 * 省略就等于把「能干什么」交给默认值，那种默认值没人能在评审里看见）。
 */
export function parseAgentFile(text: string): ParseAgentResult {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { ok: false, reason: "缺少 frontmatter：文件开头必须是 `---` 那一行" };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    return { ok: false, reason: "frontmatter 没有闭合：结尾还缺一行 `---`" };
  }
  const meta = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf(":");
    if (at === -1) {
      return { ok: false, reason: `frontmatter 里这一行不是 key: value：${trimmed}` };
    }
    const key = trimmed.slice(0, at).trim().toLowerCase();
    meta.set(key, trimmed.slice(at + 1).trim());
  }

  const description = meta.get("description") ?? "";
  if (description === "") {
    return { ok: false, reason: "frontmatter 缺 description（给模型看的目录块要有它）" };
  }
  if (!meta.has("tools")) {
    return {
      ok: false,
      reason: "frontmatter 缺 tools：请显式列出可用工具（如 `tools: read, memory_search`）",
    };
  }
  const tools = (meta.get("tools") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (tools.length === 0) {
    return { ok: false, reason: "frontmatter 的 tools 是空的：至少要列一个工具名" };
  }

  return { ok: true, description, tools, body: lines.slice(end + 1).join("\n").trim() };
}

/** 装载结果：与技能同形——装到的 + 被遮蔽的名字 + 逐目录计数 + 告警 */
export interface LoadedAgents {
  agents: AgentDef[];
  /** 被项目级同名定义遮蔽掉的用户级名字（如实告知，别让用户以为它在生效） */
  shadowed: string[];
  /** 每个来源目录装到的数量，与传进去的目录一一对应 */
  counts: number[];
  /** 逐条失败说明（文件 → 原因），只报前几条，见 `describeAgents` */
  failures: { path: string; reason: string }[];
}

/**
 * 内建兜底两个定义：没有任何磁盘定义时子代理也不是死功能。
 * `researcher` 只用**本仓真的注册了**的只读工具（read / memory_search）——
 * 列一个不存在的名字会变成「看起来能读、其实一个工具都没装上」（`AGENTS.md` §3.6）。
 */
export function builtinAgentDefs(): AgentDef[] {
  return [
    {
      name: "researcher",
      description: "只读调研：在大范围文件里定位事实，给出带路径与行号的结论，不做任何改动",
      tools: ["read", "memory_search"],
      body:
        "你是一个只读的代码调研子代理。你的任务是在这个项目里把事实查清楚并给出**带出处**的结论。\n" +
        "规矩：只读（没有写/执行能力）；结论里给出文件路径与关键片段；查不到就说查不到，" +
        "不要用推测填空。最后用一段话给出结论，不要复述过程。",
      source: "builtin",
      path: "内置",
    },
    {
      name: "general",
      description: "通用子代理：默认工具集（可读写、可执行），适合整包交出去的独立任务",
      tools: null,
      body:
        "你是一个被委派了独立任务的子代理。你看不到主对话的历史，只有下面这段任务描述。\n" +
        "规矩：先把任务描述读清；需要的信息自己用工具查；完成后用一段话给出结论与" +
        "你实际做了什么（改了哪些文件、跑了什么命令），不要复述过程。",
      source: "builtin",
      path: "内置",
    },
  ];
}

/**
 * 同名只留第一个（各来源按优先级传入 → 先到的胜出），被遮蔽的名字如实收集。
 * 与技能的 `dedupeByName` 同一口径：不做去重的话同一名字会出现两条，
 * 而**到底哪份生效**全看遍历顺序——界面上看不出来、也没人会去查。
 */
export function dedupeAgents(groups: AgentDef[][]): { agents: AgentDef[]; shadowed: string[] } {
  const agents: AgentDef[] = [];
  const shadowed: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const agent of group) {
      if (seen.has(agent.name)) {
        shadowed.push(agent.name);
        continue;
      }
      seen.add(agent.name);
      agents.push(agent);
    }
  }
  return { agents, shadowed };
}

/** 目录内所有 `.md` 文件 → 定义（单个文件坏掉只算一条失败，不影响其它） */
async function loadAgentDir(dir: string, source: "project" | "user"): Promise<{
  agents: AgentDef[];
  failures: { path: string; reason: string }[];
}> {
  const failures: { path: string; reason: string }[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // 目录不存在是**常态**（没配过子代理），不是告警
    return { agents: [], failures };
  }
  const agents: AgentDef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const path = join(dir, entry.name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      failures.push({ path, reason: `读文件失败：${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const parsed = parseAgentFile(text);
    if (!parsed.ok) {
      failures.push({ path, reason: parsed.reason });
      continue;
    }
    agents.push({
      // 名字取**文件名**（去掉 `.md` 后缀）——目录内唯一，也是 `subagent` 的 `agent` 入参
      name: entry.name.slice(0, entry.name.length - ".md".length),
      description: parsed.description,
      tools: parsed.tools,
      body: parsed.body,
      source,
      path,
    });
  }
  // 目录内按名字排序，让目录块与告警稳定（读盘顺序不稳定会让提示词无法命中缓存）
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, failures };
}

/** 装载各目录并合并内建；内建**排在最后**，磁盘定义可以覆盖它们 */
export async function loadAgentDefs(dirs: string[]): Promise<LoadedAgents> {
  const groups: AgentDef[][] = [];
  const counts: number[] = [];
  const failures: { path: string; reason: string }[] = [];
  for (const [index, dir] of dirs.entries()) {
    const loaded = await loadAgentDir(dir, index === 0 ? "project" : "user");
    groups.push(loaded.agents);
    counts.push(loaded.agents.length);
    failures.push(...loaded.failures);
  }
  groups.push(builtinAgentDefs());
  const { agents, shadowed } = dedupeAgents(groups);
  return { agents, shadowed, counts, failures };
}

/** 目录块的字符预算——它是每请求都进提示词的一段，必须**有界** */
export const MAX_AGENT_CATALOG_CHARS = 1200;

/** 告警里最多列几条失败（列满屏就不是提示了） */
export const MAX_AGENT_FAILURES = 3;

/**
 * 组装给**模型**看的 `<available_subagents>` 块。
 *
 * ⚠️ **这一步不能省，也不能交给库**：内核的 `AgentTool` 只有
 * `name / label / description / parameters / execute`——没有任何「往提示词里塞清单」的钩子
 * （`docs/ARCHITECTURE.md` §四）。不拼进系统提示词，模型**根本不知道**有哪些子代理可用，
 * 而装载、告警、计数、typecheck、单测全都会是绿的（`AGENTS.md` §四「库提供了函数 ≠ 库会调用它」）。
 *
 * 空名单返回空串（不产出空壳标题）；超预算时**如实说还剩几个没列出**，不静默截断。
 */
export function renderAgentCatalog(agents: readonly AgentDef[]): string {
  if (agents.length === 0) return "";
  const head =
    "<available_subagents>\n" +
    "可以把一件**能整包交出去**的事委派给下面的子代理（用 subagent 工具）：" +
    "它们看不到我们的对话，所以 task 必须自包含（背景、目标、交付物、约束）。" +
    "简单任务自己做更快。\n";
  const tail = "</available_subagents>";
  const parts: string[] = [];
  let used = head.length + tail.length;
  let omitted = 0;
  for (const agent of agents) {
    const line = `- ${agent.name}：${agent.description}`;
    if (used + line.length + 1 > MAX_AGENT_CATALOG_CHARS) {
      omitted += 1;
      continue;
    }
    used += line.length + 1;
    parts.push(line);
  }
  if (parts.length === 0) return "";
  if (omitted > 0) parts.push(`（还有 ${omitted} 个未列出：目录块有长度上限）`);
  return `${head}${parts.join("\n")}\n${tail}`;
}

/**
 * 一条如实的通知：装到什么、被什么遮蔽、哪个文件没读成；没什么可说时返回 `null`。
 * 定义来自磁盘且决定子代理的工具面，属于「隐式信任要可见」（`docs/SECURITY.md`）。
 */
export function describeAgents(loaded: LoadedAgents): string | null {
  const parts: string[] = [];
  const project = loaded.counts[0] ?? 0;
  const user = loaded.counts[1] ?? 0;
  const total = project + user;
  if (total > 0) {
    parts.push(`已加载 ${total} 个子代理定义（项目级 ${project} · 用户级 ${user}）`);
  }
  if (loaded.shadowed.length > 0) {
    parts.push(`项目级覆盖了同名用户级定义：${loaded.shadowed.join("、")}`);
  }
  if (loaded.failures.length > 0) {
    const shown = loaded.failures
      .slice(0, MAX_AGENT_FAILURES)
      .map((item) => `${basename(item.path)}：${item.reason}`);
    const rest = loaded.failures.length - shown.length;
    parts.push(
      `子代理定义告警 ${loaded.failures.length} 条：${shown.join("；")}${rest > 0 ? `（另有 ${rest} 条）` : ""}`,
    );
  }
  return parts.length > 0 ? parts.join("；") : null;
}
