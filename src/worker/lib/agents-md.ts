// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * AGENTS.md（agents.md 开放标准）的发现与注入——pi 生态里的「资源文件」层
 * （resource-loader 自动发现并注入，pi-coding-agent 内核自带）。
 *
 * 它与记忆（lib/memory.ts）是**分工**不同的两种沉淀，不是「谁写谁不写」：
 * - AGENTS.md 收**成文的项目约定**（构建/测试命令、代码风格、协作规范）——
 *   团队共享、随版本管理。助手可以写：opencode / codex 的 `/init` 就是让
 *   agent 创建或就地更新这份文件，Claude Code 也允许按请求编辑 CLAUDE.md。
 *   本应用取保守时机——**用户要求时**写（初始化、记录某条约定），不自主
 *   改写；它在项目内、走常规审批，改动会出现在工具卡与 diff 里。
 * - 记忆收**助手自己的沉淀**（踩坑、用户偏好、决策原因）。
 *   这条边界写进两边的注入规则，防止互相串。
 *
 * 发现规则（对齐标准与 Claude Code / Codex 的做法）：从工作目录一路向上
 * 收集到文件系统根，外层在前、内层在后——越靠近工作目录的文件越具体，
 * 排在后面（Codex 同样按根 → cwd 拼接，越近的越后）。嵌套目录级
 * AGENTS.md 按工具操作路径动态生效是标准的进阶玩法，v1 不做。
 *
 * 注入时机是**每请求重读**（与记忆同一套机制）：用户要求沉淀约定是常态，
 * 会话中途创建/更新 AGENTS.md 后下一次请求立即可见，避免「助手刚写完、上下文里
 * 却还是旧貌」的自相矛盾——空起点时创建的文件尤其如此。内容不变时拼出的串
 * 逐字相同，提示词缓存照常命中；内容或文件集合变了才失效一次。会话启动的装载
 * 通知照发一次；此后**文件集合变化**与读取失败由注入器如实上报（隐式信任通道
 * 的变化要可见，docs/SECURITY.md）。有界：总长封顶、截断指回文件。
 */
import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

/** 注入块的总长上限（字符）。AGENTS.md 是用户有意写的文档，给得比记忆（6000）宽 */
export const MAX_AGENTS_MD_CHARS = 20000;

/**
 * 从 cwd 向上收集候选路径（含 cwd 与文件系统根），**外层在前**。
 * 纯路径计算，不做任何 IO——方便测试与调用方自行决定读哪些。
 */
export function agentsMdCandidates(cwd: string): string[] {
  const innermost: string[] = [];
  let dir = cwd;
  const root = parse(dir).root;
  for (let guard = 0; guard < 64; guard += 1) {
    innermost.push(join(dir, "AGENTS.md"));
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return innermost.reverse();
}

export interface AgentsMdFile {
  path: string;
  content: string;
}

export interface LoadedAgentsMd {
  /** 读到的文件，外层在前。空文件跳过（内容为空的约定不值得占上下文） */
  files: AgentsMdFile[];
  /** 真读取失败的原因（按文件收集）。缺失（ENOENT）不算失败 */
  errors: string[];
}

/**
 * 逐个尝试读候选文件。任何单份失败都不抛出、也不拦其它文件——
 * 一份父目录的 AGENTS.md 读不了不该让整个会话起不来，但失败要上报、不能静默。
 */
export async function loadAgentsMd(cwd: string): Promise<LoadedAgentsMd> {
  const files: AgentsMdFile[] = [];
  const errors: string[] = [];
  for (const candidate of agentsMdCandidates(cwd)) {
    try {
      const raw = await readFile(candidate, "utf8");
      const content = raw.trim();
      if (content.length > 0) files.push({ path: candidate, content });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        errors.push(`${candidate}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { files, errors };
}

const TRUNCATION_MARKER = "……（内容过长已截断，完整内容请直接读取 AGENTS.md 文件）";

/** 空起点的正文。与记忆同理：助手得先知道这份文件存在、可以创建，约定才有地方去 */
const EMPTY_BODY =
  "（本项目暂无 AGENTS.md。用户要求记录项目约定或初始化项目说明时，可在工作目录创建一份。）";

/** 与记忆（lib/memory.ts）的分工边界，两边都写进规则防止互相串 */
const MAINTENANCE_RULES = [
  "维护规则：",
  "- AGENTS.md 收成文的项目约定（构建/测试命令、代码风格、协作规范），团队共享、随版本管理；你自己的观察与沉淀写记忆文件，不要混进来。",
  "- 用户要求把约定写下来或初始化项目说明时，用 write / edit 更新**最靠近工作目录**的那份 AGENTS.md；一份都没有就在工作目录创建。",
  "- 不要动父目录里的 AGENTS.md——那是上级/共享范围。",
];

/** 组装 AGENTS.md 注入块。没有文件时也注入（空起点块教助手这份文件可以创建） */
export function formatAgentsMdBlock(files: AgentsMdFile[]): string {
  const joined = files
    .map((file) => `<file path="${file.path}">\n${file.content}\n</file>`)
    .join("\n\n");
  const body =
    files.length === 0
      ? EMPTY_BODY
      : joined.length <= MAX_AGENTS_MD_CHARS
        ? joined
        : `${joined.slice(0, MAX_AGENTS_MD_CHARS)}\n${TRUNCATION_MARKER}`;
  return [
    "<agents_md>",
    "以下是项目里的 AGENTS.md 指导文件（人机共同维护的项目约定，从外到内排列，越靠近工作目录的越具体）：",
    "",
    body,
    "",
    ...MAINTENANCE_RULES,
    "</agents_md>",
  ].join("\n");
}

/** 把 AGENTS.md 块拼到 base 后面。没有文件时也注入空起点块（同记忆的循环起点逻辑） */
export function appendAgentsMdBlock(base: string, files: AgentsMdFile[]): string {
  return `${base}\n\n${formatAgentsMdBlock(files)}`;
}

/**
 * 组装一条如实的提示；没什么可说时返回 null，不制造噪音。
 * 注入了几份要报（隐式信任通道要可见，docs/SECURITY.md）；读取失败必须报（docs/ERRORS.md）。
 */
export function describeAgentsMd(loaded: LoadedAgentsMd): string | null {
  const parts: string[] = [];
  if (loaded.files.length > 0) {
    parts.push(`已注入 AGENTS.md（${loaded.files.length} 份，含父目录）`);
  }
  if (loaded.errors.length > 0) {
    parts.push(`AGENTS.md 读取失败 ${loaded.errors.length} 处：${loaded.errors.join("；")}`);
  }
  return parts.length > 0 ? parts.join("；") : null;
}

export interface AgentsMdInjector {
  /** 每次模型请求前重新发现并注入 AGENTS.md 块（内容不变时逐字相同，缓存照常命中） */
  systemPromptFor(base: string): Promise<string>;
}

/**
 * 每请求注入器：每次模型请求都重新走「父链发现 → 读取 → 有界组装」。
 *
 * - **动态发现**是相对记忆的关键差异：AGENTS.md 可以在会话中途被**创建**
 *   （空起点 → 用户要求沉淀约定），静态注入会一直停留在「暂无」——
 *   每请求重新发现才对得上助手自己刚做的修改。
 * - **失败期语义**（同记忆注入器）：同一份文件在同一段失败期只报一次，
 *   全部恢复后再次失败才报下一次；单份读不了不影响其它文件照常注入。
 * - **文件集合变化要报**：中途多出/少掉一份注入文件，都是隐式信任通道的变化，
 *   不该静默发生。内容变化不报——那通常是助手自己刚写的（工具卡可见）。
 */
export function createAgentsMdInjector(
  cwd: string,
  onNotice?: (message: string) => void,
): AgentsMdInjector {
  let failing = new Set<string>();
  let lastPaths: string[] | null = null;
  return {
    async systemPromptFor(base: string): Promise<string> {
      const loaded = await loadAgentsMd(cwd);
      const fresh = new Set(loaded.errors);
      for (const message of fresh) {
        if (!failing.has(message)) onNotice?.(`AGENTS.md 读取失败：${message}`);
      }
      failing = fresh;
      const paths = loaded.files.map((file) => file.path);
      const prev = lastPaths;
      if (prev !== null) {
        const added = paths.filter((path) => !prev.includes(path));
        const removed = prev.filter((path) => !paths.includes(path));
        if (added.length > 0 || removed.length > 0) {
          const changes = [
            ...added.map((path) => `新增 ${path}`),
            ...removed.map((path) => `不再注入 ${path}`),
          ];
          onNotice?.(`注入的 AGENTS.md 发生变化：${changes.join("；")}`);
        }
      }
      lastPaths = paths;
      return appendAgentsMdBlock(base, loaded.files);
    },
  };
}
