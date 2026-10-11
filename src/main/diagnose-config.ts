// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 写后诊断的全局开关（持久化在 settings 表，`docs/DESIGN-afterwrite.md` D5）。
 *
 * 默认开。关掉是给「检查慢 / 输出吵」的项目的退路——不是安全开关：
 * 免审批窄通道的正当性不依赖这个开关（论证见 `docs/SECURITY.md` §写后诊断）。
 *
 * 与 `approval/config.ts`（分析器白名单）同一条存储通道；不共用 key 是因为
 * 两者的受众不同——一个管审批策略、一个管 worker 的 after_tool 行为。
 */
import { getSetting, setSetting } from "./db/repo";

const ENABLED_KEY = "diagnose.enabled";

/** 读取生效中的开关（从未配置过 = 开） */
export function getDiagnoseEnabled(): boolean {
  const raw = getSetting(ENABLED_KEY);
  if (raw === undefined) return true;
  // 只认布尔 JSON；坏记录按默认（开）处理——开关打不开顶多多跑检查，
  // 开关意外关闭却会让「写完没诊断」变成一个查不出原因的静默行为
  return raw === "true" ? true : raw === "false" ? false : true;
}

/** 保存开关 */
export function setDiagnoseEnabled(enabled: boolean): void {
  setSetting(ENABLED_KEY, enabled ? "true" : "false");
}
