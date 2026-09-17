/**
 * 审批策略的可配置项（持久化在 settings 表）。
 *
 * 目前只有一项：**分析器可自动放行的命令白名单**。
 * 语义：自动审批模式下，只有首词命中该白名单的 bash 调用才允许交给分析器裁决；
 * 其余 moderate 操作一律转为人工确认。把它做成可配置，是为了让「自研脚本 / 内部工具」
 * 这类项目特定入口能被用户显式纳入，而不必被迫切到 full-access。
 *
 * 未配置过 → 使用内置默认；显式保存空列表 → 关闭分析器自动放行（等同全人工）。
 */
import { getSetting, setSetting } from "../db/repo";
import { DEFAULT_ANALYZE_COMMAND_ALLOWLIST, normalizeAnalyzeAllowlist } from "./policy";

const ALLOWLIST_KEY = "approval.analyzeCommandAllowlist";

/** 读取生效中的命令白名单 */
export function getAnalyzeCommandAllowlist(): string[] {
  const raw = getSetting(ALLOWLIST_KEY);
  // 从未配置：用内置默认
  if (raw === undefined) return [...DEFAULT_ANALYZE_COMMAND_ALLOWLIST];

  // 存量脏数据：退回内置默认，避免一条坏记录把自动审批卡死。
  //
  // 「脏」的判定必须是「解析不出 JSON **数组**」，不能只判抛不抛异常：
  // `setAnalyzeCommandAllowlist` 只往里写数组，所以解析出来不是数组的值，按定义都不是本程序写的。
  // 早先只 catch 语法错，于是 `{"npm":true}` / `null` / `"npm"` 这类**能解析但非数组**的值
  // 会一路走到 `normalizeAnalyzeAllowlist` → 返回空表 → 被当成「用户显式清空了白名单」，
  // 结果是自动放行被悄悄关掉（用户只看到「怎么每条命令都要问我」，看不出原因）。
  const parsed = parseStoredList(raw);
  if (parsed === undefined) return [...DEFAULT_ANALYZE_COMMAND_ALLOWLIST];

  // 已配置成数组：即便归一化后是空数组也照用（那是用户显式清空，表示关闭自动放行）
  return normalizeAnalyzeAllowlist(parsed);
}

/** 解析存量设置值；不是 JSON、或不是数组，都返回 undefined（按坏记录处理） */
function parseStoredList(raw: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 保存命令白名单，返回归一化后的结果 */
export function setAnalyzeCommandAllowlist(list: unknown): string[] {
  const normalized = normalizeAnalyzeAllowlist(list);
  setSetting(ALLOWLIST_KEY, JSON.stringify(normalized));
  return normalized;
}
