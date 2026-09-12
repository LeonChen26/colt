/**
 * 工具审批的风险判定。
 *
 * 这是一层「提醒」而非沙箱：判定基于工具名、参数与命令文本的启发式匹配，
 * 刻意偏保守（拿不准就问），但无法对抗刻意构造的绕过。
 * 真正的隔离要靠操作系统权限或容器，本模块不承担该职责。
 *
 * 纯函数，不碰 IO，便于单测覆盖。
 */

/** 风险档位 */
export type RiskLevel = "safe" | "moderate" | "dangerous";

/** 判定结果 */
export type Decision = "allow" | "ask";

/** 会话内记忆的放行规则 */
export interface AllowRule {
  toolName: string;
  /** tool：该工具全部放行；signature：仅放行同签名的调用 */
  scope: "tool" | "signature";
  /** scope 为 signature 时的参数签名 */
  signature?: string;
}

export interface PolicyConfig {
  /** full-access：不拦截，等价于旧的全权执行；approval：按风险判定 */
  mode: "full-access" | "approval";
  /** 项目根目录，用于判断写入是否越界；已归一为正斜杠 */
  projectRoot: string;
  /** 会话内已记忆的放行规则 */
  allowRules: AllowRule[];
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

/** 只读类工具：不改磁盘、不执行命令 */
const READONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "list", "search", "todo"]);

/** 写入类工具及其路径参数名 */
const WRITE_TOOLS: Record<string, string> = {
  edit: "path",
  write: "path",
  create: "path",
};

/**
 * 只读 shell 命令白名单。仅匹配命令首词（含 git 的只读子命令）。
 * 宁可漏判为 moderate，也不把可能写盘的命令放进来。
 */
const READONLY_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "echo", "date", "whoami",
  "which", "type", "file", "stat", "du", "df", "env", "printenv",
  "grep", "rg", "fd", "find", "tree", "diff", "sort", "uniq", "basename", "dirname",
]);

/** git 的只读子命令 */
const READONLY_GIT = new Set([
  "status", "log", "diff", "show", "branch", "remote", "config", "blame", "describe",
]);

/**
 * 危险命令模式。命中即判为 dangerous。
 * 每条都附带给用户看的说明，避免只丢一个「危险」了事。
 */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf]/, reason: "递归或强制删除文件" },
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
  { pattern: /(^|\/)(id_rsa|id_ed25519|\.pem|\.key|\.pfx)($|\/)/i, reason: "疑似私钥文件" },
  { pattern: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i, reason: "依赖锁文件" },
];

/** 归一路径分隔符并转小写盘符，便于比较 */
function normalizePath(value: string): string {
  const slashed = value.replaceAll("\\", "/");
  return /^[a-zA-Z]:\//.test(slashed) ? slashed[0]!.toLowerCase() + slashed.slice(1) : slashed;
}

/** 判断路径是否位于根目录内（需按路径段比较，避免 /proj-evil 被当成 /proj 内） */
export function isInside(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root).replace(/\/+$/, "");
  const normalizedTarget = normalizePath(target);
  // 相对路径视为项目内
  if (!/^([a-zA-Z]:)?\//.test(normalizedTarget)) return !normalizedTarget.startsWith("../");
  return (
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
  );
}

/**
 * 按 shell 控制符拆分命令串，逐段判断。
 * 只取首词做白名单比对，`a && rm -rf b` 不会因为首段是 ls 就整体放行。
 */
export function splitCommands(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 取命令首词，跳过前置的环境变量赋值 */
function headWord(segment: string): string {
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return token.replace(/^.*[/\\]/, "").toLowerCase();
  }
  return "";
}

/** 判定单条 bash 命令的风险 */
export function assessCommand(command: string): { risk: RiskLevel; reason: string } {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return { risk: "dangerous", reason };
  }

  const segments = splitCommands(command);
  if (segments.length === 0) return { risk: "moderate", reason: "空命令" };

  // 输出重定向会写盘，不能算只读
  const redirects = /(^|[^>])>{1,2}[^>]/.test(command);

  const allReadonly = segments.every((segment) => {
    const head = headWord(segment);
    if (head === "git") {
      const sub = segment.split(/\s+/).filter(Boolean)[1]?.toLowerCase() ?? "";
      return READONLY_GIT.has(sub);
    }
    return READONLY_COMMANDS.has(head);
  });

  if (allReadonly && !redirects) {
    return { risk: "safe", reason: "只读命令" };
  }
  return { risk: "moderate", reason: "会修改文件或产生副作用的命令" };
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
  return `${toolName}:*`;
}

/** 一行可读摘要 */
function buildSummary(invocation: ToolInvocation): string {
  const { toolName, args } = invocation;
  if (toolName === "bash" && typeof args.command === "string") {
    const command = args.command.trim().replace(/\s+/g, " ");
    return `bash: ${command.length > 120 ? `${command.slice(0, 120)}…` : command}`;
  }
  const pathKey = WRITE_TOOLS[toolName];
  if (pathKey !== undefined && typeof args[pathKey] === "string") {
    return `${toolName}: ${args[pathKey] as string}`;
  }
  return toolName;
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
    if (!isInside(projectRoot, raw)) {
      return { risk: "dangerous", reason: "写入项目目录之外" };
    }
    return { risk: "moderate", reason: "修改项目内文件" };
  }

  // 未知工具：不认识就问
  return { risk: "moderate", reason: "未知工具，按需确认" };
}
