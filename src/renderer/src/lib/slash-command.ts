/**
 * 输入框里的「斜杠命令」识别。
 *
 * 本仓**没有**命令注册表，也**不做**命令菜单 / 自动补全（`NEXT-PHASE.md` §3.2 的 D3：后端没有
 * 命令注册，画菜单就是死菜单）。这里只识别**确实有实现**的那一个命令，判定与执行全在前端本地，
 * 不引入任何「点了没反应的入口」（`AGENTS.md` §3.6）。
 *
 * 规则刻意从严：
 * - 命令必须**独占整条输入**（`"/compact"` 或 `"/compact  "`），不做前缀匹配——
 *   否则用户想发一段以 `/` 开头的正文（例如贴路径 `/usr/local/bin`）会被误当成命令吞掉。
 * - **未知的 `/xxx` 一律不算命令**，回落成普通提问照常发给模型（模型自己能理解它）。
 *   即「只有白名单里的命令才被拦截」——这样漏写的命令只会「原样发出去」，不会静默丢失。
 */

/** 当前支持的命令。加新命令时**必须**同时在 `executeSlashCommand`（`Conversation/index.tsx`）接上实现 */
export type SlashCommand = "compact";

const COMMANDS: readonly SlashCommand[] = ["compact"];

/**
 * 解析输入框文本。
 *
 * @returns 命中的命令名；不是命令（含未知 `/xxx`、空串、以 `/` 开头的普通文本）时返回 `null`
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // 必须**独占整条输入**：不做前缀匹配、也不忽略参数。
  // 若只取第一段比对，`/compact 一下` 会被当成命令吞掉——用户那句“用 /compact 手动压缩”
  // 就永远发不出去了。本阶段没有带参数的命令，所以「多余内容」只能意味着这不是命令。
  const head = trimmed.slice(1).toLowerCase();
  return COMMANDS.find((command) => command === head) ?? null;
}
