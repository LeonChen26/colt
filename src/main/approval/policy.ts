// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 工具审批的风险判定。
 *
 * 这是一层「提醒」而非沙箱：判定基于工具名、参数与命令文本的启发式匹配，
 * 刻意偏保守（拿不准就问），但无法对抗刻意构造的绕过。
 * 真正的隔离要靠操作系统权限或容器，本模块不承担该职责。
 *
 * 判定基线是**只读白名单**：只有能证明「无副作用」的调用才自动放行，
 * 其余一律进入确认。危险命令清单不参与放行决策，只用于把风险档位
 * 抬到 dangerous（更醒目的提示 + 免疫「不再询问」记忆）。
 *
 * 除一处外均为纯函数，便于单测覆盖：**越界判定会解析真实路径**（`isWithinRootReal`），
 * 因为「根内的软链接指向根外」这件事只有问了文件系统才知道。命令文本、敏感路径、
 * 风险分档这些仍是纯字符串判定；`isInside` 也仍是纯的（不碰磁盘），
 * 供目标尚不存在或必须在任何 fs 访问之前下结论的场合使用。
 */

import { READONLY_TOOLS } from "@shared/readonly-tools";
import { mcpToolLabel } from "@shared/mcp-label";
import { isWithinRoot, isWithinRootReal } from "../lib/path-guard";

/** 风险档位 */
export type RiskLevel = "safe" | "moderate" | "dangerous";

/**
 * 判定结果。
 *   - allow：直接放行；
 *   - ask：需要用户确认；
 *   - analyze：自动审批模式下白名单外的普通操作，交给大模型分析后决定（见 analyzer.ts）。
 */
export type Decision = "allow" | "ask" | "analyze";

/** 会话内记忆的放行规则 */
export interface AllowRule {
  /**
   * 稳定标识，供界面按 id 删除。
   * 可选：测试与旧路径手写的规则可省略，store 入库时会补一个。
   */
  id?: string;
  toolName: string;
  /** tool：该工具全部放行；signature：仅放行同签名的调用 */
  scope: "tool" | "signature";
  /** scope 为 signature 时的参数签名 */
  signature?: string;
}

export interface PolicyConfig {
  /**
   * approval：只读白名单放行，其余都要确认；
   * auto：白名单放行 + 白名单外的普通操作（moderate）自动批准，仅 dangerous 仍需确认；
   * full-access：不拦截，等价于旧的全权执行。
   */
  mode: "approval" | "auto" | "full-access";
  /** 项目根目录，用于判断写入是否越界；已归一为正斜杠 */
  projectRoot: string;
  /** 会话内已记忆的放行规则 */
  allowRules: AllowRule[];
  /**
   * 分析器可自动放行的命令首词白名单（未提供时用内置默认）。
   * 只有结构上落在白名单内的 moderate 操作才允许交给分析器，其余一律人工确认。
   */
  analyzeCommandAllowlist?: readonly string[];
}

export interface ToolInvocation {
  toolName: string;
  args: Record<string, unknown>;
}

export interface PolicyVerdict {
  decision: Decision;
  risk: RiskLevel;
  /** 判定依据，直接展示给用户 */
  reason: string;
  /** 同类调用的签名，用于「本次会话不再询问」 */
  signature: string;
  /** 一行可读摘要，如 `bash: rm -rf build` */
  summary: string;
}

/** 写入类工具及其路径参数名 */
const WRITE_TOOLS: Record<string, string> = {
  edit: "path",
  write: "path",
  create: "path",
};

/**
 * 浏览器只读工具：不改变页面状态，判为 safe 直接放行。
 * 注意 screenshot 虽无副作用，但会把页面内容外发给模型，故不并入 READONLY_TOOLS
 * （后者语义是「文件系统侧确定无副作用」），仅在本模块按 safe 处理。
 */
const BROWSER_READ_TOOLS: ReadonlySet<string> = new Set(["browser_read", "browser_screenshot"]);

/** 浏览器操作工具：会改变页面状态，需确认 */
const BROWSER_ACT_TOOL = "browser_act";

/**
 * 电脑控制工具。
 * 截图只是读取屏幕（无副作用），判 moderate——含隐私但可被「本会话始终允许」降噪；
 * 实际操作会真实控制整台桌面的鼠标键盘，判 dangerous，永远单独确认。
 */
const COMPUTER_SCREENSHOT_TOOL = "computer_screenshot";
const COMPUTER_ACTION_TOOL = "computer_action";

/**
 * 只读 shell 命令白名单。
 *
 * 这是放行的唯一依据：命令首词不在其中，就必须确认。
 * 刻意偏保守——宁可把只读命令误判成「需确认」，也不放任何可能写盘的命令进来。
 * 因此一些看似只读的工具（如 find / sed）被排除在外，或需额外参数级校验。
 */
const READONLY_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "echo", "date", "whoami",
  "which", "type", "file", "stat", "du", "df", "printenv",
  "grep", "rg", "fd", "tree", "diff", "basename", "dirname",
  "true", "false", "printf", "seq", "uname", "id", "hostname",
]);

/**
 * 看似只读、实则可通过参数产生副作用的命令。
 * 命中任一「副作用参数」即不放行；find/sed/xargs 等不得不单独把关。
 */
const MUTATING_ARGS: { command: string; pattern: RegExp; reason: string }[] = [
  { command: "find", pattern: /-(exec|execdir|delete|ok|okdir|fls|fprint|fprintf)\b/, reason: "find 带执行/删除/写出参数" },
  { command: "sed", pattern: /(^|\s)(-i\b|--in-place\b)/, reason: "sed 就地编辑会改写文件" },
  { command: "xargs", pattern: /.*/, reason: "xargs 会把内容交给子命令执行" },
  { command: "tee", pattern: /.*/, reason: "tee 会写入文件" },
  { command: "awk", pattern: /system\s*\(|print.*>\s*\S/, reason: "awk 可调用 system 或写出文件" },
  { command: "sort", pattern: /(^|\s)(-o\b|--output\b)/, reason: "sort -o 会写出文件" },
  { command: "uniq", pattern: /\b\S+\s*$/, reason: "uniq 第二个参数是输出文件" },
];

/**
 * 需参数级校验才能放行的「条件只读」命令：
 * 无副作用参数时可当只读，带上了则另算（见 MUTATING_ARGS）。
 */
const CONDITIONAL_READONLY = new Set(["find", "sed", "awk", "sort", "uniq"]);

/** git 的只读子命令（config / remote / branch / tag / worktree / reflog 均可改写仓库状态，不入白名单） */
const READONLY_GIT = new Set([
  "status", "log", "diff", "show", "blame", "describe",
  "rev-parse", "ls-files", "shortlog", "cat-file",
]);

/**
 * 危险命令模式。
 *
 * 注意：**不参与放行决策**（放行只认只读白名单）。命中只做两件事：
 *   1. 把该调用的风险档位抬到 dangerous，界面用更醒目的样式提示；
 *   2. 让「本会话内始终允许」的记忆规则对它失效，每次单独确认。
 * 每条都附带给用户看的说明，避免只丢一个「危险」了事。
 */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\b/, reason: "删除文件，可能不可恢复" },
  { pattern: /\brmdir\b/, reason: "删除目录" },
  { pattern: /\b(mkfs|fdisk|diskpart|format)\b/, reason: "磁盘格式化或分区操作" },
  { pattern: /\bdd\s+.*\bof=/, reason: "dd 直接写入设备或文件" },
  { pattern: /\bsudo\b|\brunas\b/, reason: "提权执行" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "关机或重启" },
  { pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|zsh|python|node)/i, reason: "下载内容直接执行" },
  { pattern: /\bgit\s+push\b.*(--force|-f)\b/, reason: "强制推送会覆盖远端历史" },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/, reason: "丢弃未提交的改动" },
  { pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/, reason: "放开全部权限" },
  { pattern: /\b(reg|regedit)\s+(add|delete|import)\b/i, reason: "修改 Windows 注册表" },
  { pattern: /\b(taskkill|kill|pkill)\b.*(-9|\/f)\b/i, reason: "强制结束进程" },
  { pattern: />\s*\/dev\/(sd|nvme|disk)/, reason: "写入块设备" },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b/, reason: "发布软件包" },
  { pattern: /\b(shred|srm)\b/, reason: "不可恢复地擦除文件" },
];

/** 敏感文件：即使在项目内，改动也应显式确认 */
const SENSITIVE_PATH_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\/)\.env($|\.|\/)/i, reason: "环境变量文件通常含密钥" },
  { pattern: /(^|\/)\.git\//, reason: "直接改动 git 内部目录" },
  { pattern: /(^|\/)\.ssh\//, reason: "SSH 凭据目录" },
  { pattern: /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)($|\/)/i, reason: "SSH 私钥文件" },
  { pattern: /\.(pem|key|pfx|p12|jks)$/i, reason: "疑似私钥或证书文件" },
  { pattern: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i, reason: "依赖锁文件" },
];

/** 归一路径分隔符并转小写盘符，便于比较 */
function normalizePath(value: string): string {
  const slashed = value.replaceAll("\\", "/");
  return /^[a-zA-Z]:\//.test(slashed) ? slashed[0]!.toLowerCase() + slashed.slice(1) : slashed;
}

/**
 * 判断路径是否位于根目录内。
 *
 * 判定本体在 `main/lib/path-guard.ts` 的 `isWithinRoot`——**全仓只有那一份**，这里只转发。
 * 此前这里自己折叠 `.` / `..` 再按段比较，与 `file-read.ts` 那份各写一套，结果
 * 「软链接把根内的名字指到根外」这条防线只在预览路径上有、审批闸门上没有。
 *
 * ⚠️ 本函数是**纯字符串判定，不访问磁盘**（因此也适用于目标尚不存在的写入场景）。
 * 真正放行前的调用点应当用 `isWithinRootReal`——它在纯判定之后再解一次真实路径。
 */
export function isInside(root: string, target: string): boolean {
  return isWithinRoot(root, target);
}

/**
 * 按 shell 控制符拆分命令串，逐段判断。
 * 只取首词做白名单比对，`a && rm -rf b` 不会因为首段是 ls 就整体放行。
 */
export function splitCommands(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n|&(?!&)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 取命令首词原样（跳过前置的环境变量赋值，保留路径前缀） */
function firstToken(segment: string): string {
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return token;
  }
  return "";
}

/** 取命令首词，跳过前置的环境变量赋值，并剥离路径前缀后小写 */
function headWord(segment: string): string {
  return firstToken(segment).replace(/^.*[/\\]/, "").toLowerCase();
}

/**
 * 判定单条 bash 命令的风险。
 *
 * 基线是只读白名单：**只有能证明无副作用的命令才判 safe**，其余一律 moderate。
 * 危险清单不参与放行，只把风险抬到 dangerous。
 */
export function assessCommand(command: string): { risk: RiskLevel; reason: string } {
  // 1) 明确危险：抬到 dangerous（更醒目 + 免疫记忆规则）
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return { risk: "dangerous", reason };
  }

  // 命令 / 进程替换内的命令无法可靠拆分，一律不进只读白名单（拿不准就问）
  if (/`|\$\((?!\()|<\(/.test(command)) {
    return { risk: "moderate", reason: "命令包含命令替换或进程替换，无法证明无副作用" };
  }

  const segments = splitCommands(command);
  if (segments.length === 0) return { risk: "moderate", reason: "空命令" };

  // 2) 输出重定向（> / >>）会写盘，整条命令不能算只读
  if (/(^|[^>])>{1,2}[^>]/.test(command)) {
    return { risk: "moderate", reason: "命令包含输出重定向，会写出文件" };
  }

  // 3) 逐段校验：每一段的首词都必须在只读白名单内
  for (const segment of segments) {
    const head = headWord(segment);
    if (head.length === 0) return { risk: "moderate", reason: "无法识别的命令段" };

    if (head === "git") {
      const sub = segment.split(/\s+/).filter(Boolean)[1]?.toLowerCase() ?? "";
      if (!READONLY_GIT.has(sub)) {
        return { risk: "moderate", reason: `git ${sub || "（无子命令）"} 可能改写仓库状态` };
      }
      if (/--output\b/.test(segment)) {
        return { risk: "moderate", reason: "git --output 会写出文件" };
      }
      continue;
    }

    // 有副作用参数的命令（find/sed/awk/sort/xargs/tee…）单独把关
    const mutating = MUTATING_ARGS.find((rule) => rule.command === head);
    if (mutating && mutating.pattern.test(segment)) {
      // find -exec/-delete、xargs、tee 这类是明确危险；sort -o、awk 等只算需确认
      const dangerous = head === "find" || head === "xargs" || head === "tee";
      return { risk: dangerous ? "dangerous" : "moderate", reason: mutating.reason };
    }

    // 条件只读：参数检查已通过，视为只读
    if (CONDITIONAL_READONLY.has(head)) continue;

    // 不在白名单：不认识就问，绝不默认放行
    if (!READONLY_COMMANDS.has(head)) {
      return { risk: "moderate", reason: `「${head}」不在只读白名单内，可能产生副作用` };
    }
  }

  return { risk: "safe", reason: "只读命令" };
}

/** 取出 upload 的路径参数，非法值忽略 */
function readUploadPaths(args: Record<string, unknown>): string[] {
  const value = args.paths;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 生成同类调用的签名，用于「不再询问」的记忆匹配 */
export function buildSignature(invocation: ToolInvocation): string {
  const { toolName, args } = invocation;
  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return `bash:${command.trim()}`;
  }
  const pathKey = WRITE_TOOLS[toolName];
  if (pathKey !== undefined && typeof args[pathKey] === "string") {
    return `${toolName}:${normalizePath(args[pathKey] as string)}`;
  }
  if (toolName === BROWSER_ACT_TOOL) {
    const action = typeof args.action === "string" ? args.action : "";
    // 上传的签名必须带上文件本身：只按 ref 记忆，会让「本次会话不再询问」覆盖之后任意文件的传外
    if (action === "upload") return `browser_act:upload:${readUploadPaths(args).join(",")}`;
    const target = typeof args.url === "string" ? args.url : typeof args.ref === "string" ? args.ref : "";
    return `browser_act:${action}${target ? `:${target}` : ""}`;
  }
  if (BROWSER_READ_TOOLS.has(toolName)) {
    const action = typeof args.action === "string" ? args.action : "";
    return action ? `${toolName}:${action}` : `${toolName}:*`;
  }
  if (toolName === COMPUTER_ACTION_TOOL) {
    const action = typeof args.action === "string" ? args.action : "";
    const target =
      typeof args.x === "number" && typeof args.y === "number" ? `${args.x},${args.y}` : "";
    return `computer_action:${action}${target ? `:${target}` : ""}`;
  }
  return `${toolName}:*`;
}

/** 一行可读摘要 */
function buildSummary(invocation: ToolInvocation): string {
  const { toolName, args } = invocation;
  // MCP 工具：注册名 `mcp__<server>__<tool>` 是给 LLM API 看的标识符，审批卡上画它
  // 就是开发者黑话。翻成「MCP <server>: <tool>」——与工具自身的 label、工具卡同源。
  const mcp = mcpToolLabel(toolName);
  if (mcp !== undefined) return mcp;
  if (toolName === "bash" && typeof args.command === "string") {
    const command = args.command.trim().replace(/\s+/g, " ");
    return `bash: ${command.length > 120 ? `${command.slice(0, 120)}…` : command}`;
  }
  const pathKey = WRITE_TOOLS[toolName];
  if (pathKey !== undefined && typeof args[pathKey] === "string") {
    return `${toolName}: ${args[pathKey] as string}`;
  }
  if (toolName === BROWSER_ACT_TOOL) {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "upload") {
      const paths = readUploadPaths(args);
      const ref = typeof args.ref === "string" ? args.ref : "";
      return `browser: upload ${ref}${paths.length > 0 ? ` (${paths.join(", ")})` : ""}`.trim();
    }
    const target = typeof args.url === "string" ? args.url : typeof args.ref === "string" ? args.ref : "";
    return `browser: ${action}${target ? ` ${target}` : ""}`.trim();
  }
  if (BROWSER_READ_TOOLS.has(toolName)) {
    if (toolName === "browser_screenshot") return "browser: screenshot";
    return `browser: ${typeof args.action === "string" && args.action ? args.action : "read"}`;
  }
  if (toolName === COMPUTER_SCREENSHOT_TOOL) {
    return "computer: screenshot";
  }
  if (toolName === COMPUTER_ACTION_TOOL) {
    const action = typeof args.action === "string" ? args.action : "";
    const target =
      typeof args.x === "number" && typeof args.y === "number" ? ` (${args.x}, ${args.y})` : "";
    return `computer: ${action}${target}`.trim();
  }
  return toolName;
}

/**
 * 分析器可自动放行的命令首词白名单（内置默认值，可在设置里覆盖）。
 *
 * 只收「已知工具链的入口」——包管理器 / 构建 / 测试 / 静态检查 / VCS。
 * 刻意**不收裸解释器**（node / python / sh 等）：那等于把任意代码执行交给模型裁决，
 * 与「结构底线」的初衷相悖。需要时可自行在设置里添加。
 */
export const DEFAULT_ANALYZE_COMMAND_ALLOWLIST: readonly string[] = [
  "npm", "pnpm", "yarn", "npx", "bun",
  "tsc", "vite", "vitest", "jest", "eslint", "prettier",
  "pytest", "ruff", "mypy", "uv", "poetry",
  "go", "cargo", "make", "cmake", "gradle", "mvn", "dotnet",
  "git",
];

/**
 * 归一化用户填写的白名单：逐项去空白、小写、剥离路径前缀（便于粘贴 `/usr/bin/npm`），
 * 去重并剔除空项。非数组或含非字符串项时按相应用例忽略，不抛错。
 */
export function normalizeAnalyzeAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim().replace(/^.*[/\\]/, "").toLowerCase();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * 分析器自动放行的「结构底线」：大模型的结论只能否决，不能授予。
 *
 * 只有能用**与自由文本无关的结构**刻画清楚、且本身低危的操作，才允许交给分析器裁决；
 * 其余一律退回人工确认（fail-closed）。这样即便分析器被提示注入骗过，攻击载荷也必须
 * 先长得像「项目内写文件 / 白名单命令的正常调用」才可能过关。
 *
 *   - 写入类工具：路径已由 assessToolRisk 证明在项目内且非敏感；
 *   - 屏幕截图：无参数、无副作用，注入面为零；
 *   - bash：全部分段的首词都是**裸命令名**（无路径前缀）且命中白名单，
 *     且不含命令替换 / 反引号 / 进程替换 / 输出重定向。
 */
export function isAnalyzeEligible(
  invocation: ToolInvocation,
  allowlist: readonly string[] = DEFAULT_ANALYZE_COMMAND_ALLOWLIST,
): boolean {
  const { toolName, args } = invocation;
  if (WRITE_TOOLS[toolName] !== undefined) return true;
  if (toolName === COMPUTER_SCREENSHOT_TOOL) return true;
  if (toolName !== "bash") return false;

  const command = typeof args.command === "string" ? args.command : "";
  // 替换/反引号里的命令不在首词白名单的可见范围内，一律不交给分析器
  if (/`|\$\(|<\s*\(/.test(command)) return false;
  // 输出重定向即写盘，结构上不再是「只跑一下工具链」
  if (/(^|[^>])>{1,2}[^>]/.test(command)) return false;

  const segments = splitCommands(command);
  if (segments.length === 0) return false;

  const allowed = new Set(allowlist);
  return segments.every((segment) => {
    const raw = firstToken(segment);
    // 带路径前缀（`./mytool`、`/usr/bin/npm`、`..\x\npm`）一律不放行：
    // 允许它等于允许执行项目里任意同名文件，白名单就失去意义了
    if (raw.length === 0 || /[/\\]/.test(raw)) return false;
    return allowed.has(raw.toLowerCase());
  });
}

/** 判断已记忆的规则是否覆盖本次调用 */
function matchedByRules(
  invocation: ToolInvocation,
  signature: string,
  rules: AllowRule[],
): boolean {
  return rules.some((rule) => {
    if (rule.toolName !== invocation.toolName) return false;
    if (rule.scope === "tool") return true;
    return rule.signature === signature;
  });
}

/**
 * 判定一次工具调用该放行还是该询问。
 *
 * 顺序：全权模式 → 只读工具 → 已记忆规则 → 按工具类型评估风险。
 * 记忆规则不能覆盖 dangerous：高风险每次都要单独确认。
 *
 * 各模式差异集中在最后一步：
 *   - approval：只有 safe 放行，moderate/dangerous 都问；
 *   - auto：safe/moderate 自动放行，仅 dangerous 问（减少打扰，高风险仍拦）；
 *   - full-access：全放。
 */
export function evaluateTool(
  invocation: ToolInvocation,
  config: PolicyConfig,
): PolicyVerdict {
  const signature = buildSignature(invocation);
  const summary = buildSummary(invocation);
  const base = { signature, summary };

  if (config.mode === "full-access") {
    return { ...base, decision: "allow", risk: "safe", reason: "全权执行模式" };
  }

  if (READONLY_TOOLS.has(invocation.toolName)) {
    return { ...base, decision: "allow", risk: "safe", reason: "只读工具" };
  }

  const assessed = assessToolRisk(invocation, config.projectRoot);

  // 高风险不吃记忆规则，必须每次确认
  if (assessed.risk !== "dangerous" && matchedByRules(invocation, signature, config.allowRules)) {
    return { ...base, decision: "allow", risk: assessed.risk, reason: "本次会话已允许" };
  }

  if (assessed.risk === "safe") {
    return { ...base, decision: "allow", risk: "safe", reason: assessed.reason };
  }

  // 自动审批模式：白名单外的普通操作，先过「结构底线」再交给大模型分析；
  // 结构上不属于已知低危形态的，以及危险操作，都退回人工确认
  if (config.mode === "auto" && assessed.risk === "moderate") {
    if (!isAnalyzeEligible(invocation, config.analyzeCommandAllowlist)) {
      return {
        ...base,
        decision: "ask",
        risk: "moderate",
        reason: `${assessed.reason}（不在自动放行的命令白名单内，需人工确认）`,
      };
    }
    return { ...base, decision: "analyze", risk: "moderate", reason: assessed.reason };
  }

  return { ...base, decision: "ask", risk: assessed.risk, reason: assessed.reason };
}

/** 按工具类型评估风险（不考虑模式与记忆） */
export function assessToolRisk(
  invocation: ToolInvocation,
  projectRoot: string,
): { risk: RiskLevel; reason: string } {
  const { toolName, args } = invocation;

  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return assessCommand(command);
  }

  const pathKey = WRITE_TOOLS[toolName];
  if (pathKey !== undefined) {
    const raw = args[pathKey];
    if (typeof raw !== "string" || raw.length === 0) {
      return { risk: "moderate", reason: "写入操作但路径缺失" };
    }
    const normalized = normalizePath(raw);
    for (const { pattern, reason } of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(normalized)) return { risk: "dangerous", reason };
    }
    // 用 isWithinRootReal：软链接可以把「根内的名字」指到根外，纯字符串判定看不见
    if (!isWithinRootReal(projectRoot, raw)) {
      return { risk: "dangerous", reason: "写入项目目录之外" };
    }
    return { risk: "moderate", reason: "修改项目内文件" };
  }

  // 浏览器只读：不改页面状态，直接放行
  if (BROWSER_READ_TOOLS.has(toolName)) {
    return { risk: "safe", reason: "浏览器只读操作，无副作用" };
  }

  // 浏览器操作：可能改变页面状态，需确认。wait/viewport 不改动页面数据，按只读放行
  if (toolName === BROWSER_ACT_TOOL) {
    if (args.action === "wait") return { risk: "safe", reason: "等待页面就绪，无副作用" };
    if (args.action === "viewport") return { risk: "safe", reason: "调整浏览窗口视口，不改动页面数据" };
    if (args.action === "upload") {
      // 上传是数据外带的原语：把本地文件交给远端页面，最坏情况是 .env / 私钥被送到对方站点。
      // 故沿用 write/edit 的路径纪律——项目外或敏感文件一律 dangerous，每次单独确认。
      const paths = readUploadPaths(args);
      if (paths.length === 0) return { risk: "moderate", reason: "上传操作但未提供文件路径" };
      for (const raw of paths) {
        const normalized = normalizePath(raw);
        for (const { pattern, reason } of SENSITIVE_PATH_PATTERNS) {
          if (pattern.test(normalized)) return { risk: "dangerous", reason: `上传敏感文件：${reason}` };
        }
        if (!isWithinRootReal(projectRoot, raw)) {
          return { risk: "dangerous", reason: `上传项目目录之外的文件：${raw}` };
        }
      }
      return { risk: "moderate", reason: `向页面上传 ${paths.length} 个文件` };
    }
    return { risk: "moderate", reason: "浏览器页面操作，可能改变页面状态" };
  }

  // 电脑控制截图：读取整屏，无副作用但含隐私，需确认（可被会话记忆降噪）
  if (toolName === COMPUTER_SCREENSHOT_TOOL) {
    return { risk: "moderate", reason: "读取整个屏幕画面，可能含隐私内容" };
  }

  // 电脑控制操作：真实控制桌面鼠标键盘，最高风险，永远单独确认
  if (toolName === COMPUTER_ACTION_TOOL) {
    return { risk: "dangerous", reason: "直接控制鼠标键盘，会操作整个桌面" };
  }

  // 未知工具：不认识就问
  return { risk: "moderate", reason: "未知工具，按需确认" };
}
