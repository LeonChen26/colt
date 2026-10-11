// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 审批策略的可配置项（持久化在 settings 表）。
 *
 * 目前两项：
 *   1. **分析器可自动放行的命令白名单**。语义：自动审批模式下，只有首词命中该白名单的
 *      bash 调用才允许交给分析器裁决；其余 moderate 操作一律转为人工确认。把它做成可配置，
 *      是为了让「自研脚本 / 内部工具」这类项目特定入口能被用户显式纳入，而不必被迫切到 full-access。
 *   2. **分析器专用的模型引用**（`approval.analyzerModelRef`，工作包 C）。空 = 沿用会话模型
 *      （现状）。它只影响自动审批这一次复核用哪家服务，不影响会话本身。
 *
 * 未配置过 → 使用内置默认；显式保存空列表 → 关闭分析器自动放行（等同全人工）。
 */
import { getSetting, setSetting } from "../db/repo";
import { splitModelRef } from "@shared/model-ref";
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

const ANALYZER_MODEL_KEY = "approval.analyzerModelRef";

/**
 * 读取分析器专用模型引用；`null` = 未配置 / 已清空 = 沿用会话模型。
 *
 * 与白名单同一口径：读的是 settings 表里的裸字符串，故**脏数据一律当「没配」**——
 * 一条手改坏的记录不该让自动审批整条链路失效（那会表现为「怎么每条命令都要问我」，
 * 而用户看不出原因）。格式校验放在这里，语义校验（服务还在不在）在 `analyzer-model.ts`。
 */
export function getAnalyzerModelRef(): string | null {
  const raw = getSetting(ANALYZER_MODEL_KEY);
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const ref = splitModelRef(trimmed);
  if (ref.provider === "" || ref.model === "") return null;
  return trimmed;
}

/**
 * 保存分析器模型引用。传 `null` / 空串 = 清空（回到「沿用会话模型」）。
 *
 * 格式不合法**抛错**而不是静默存下：写入侧只有 IPC（将来的设置界面），
 * 存一个连解析都不行的字符串，等于把一个「看起来设过、其实没生效」的状态留在库里。
 */
export function setAnalyzerModelRef(value: unknown): string | null {
  if (value === null || value === undefined) {
    setSetting(ANALYZER_MODEL_KEY, "");
    return null;
  }
  if (typeof value !== "string") throw new Error("analyzerModelRef 必须是字符串或 null");
  const trimmed = value.trim();
  if (trimmed === "") {
    setSetting(ANALYZER_MODEL_KEY, "");
    return null;
  }
  const ref = splitModelRef(trimmed);
  if (ref.provider === "" || ref.model === "") {
    throw new Error(`模型引用要写成 providerId/modelId（如 deepseek/deepseek-v4-flash）：${trimmed}`);
  }
  setSetting(ANALYZER_MODEL_KEY, trimmed);
  return trimmed;
}
