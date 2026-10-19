// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 写后诊断的全局开关（持久化在 settings 表，`docs/archive/DESIGN-afterwrite.md` D5）。
 *
 * **默认关**（v2.04 起；此前默认开）。理由：它要 spawn 外部检查器（`npx tsc` / `npx eslint` /
 * `go vet` / `cargo check`），只对 TS / Go / Rust 项目有效；默认开等于替每个用户
 * 在每个 `write/edit` 之后跑一遍可能根本跑不起来的命令。要用的人在设置页显式打开。
 *
 * 关掉不影响安全：免审批窄通道的正当性不依赖这个开关（论证见 `docs/SECURITY.md` §写后诊断）。
 *
 * 与 `approval/config.ts`（分析器白名单）同一条存储通道；不共用 key 是因为
 * 两者的受众不同——一个管审批策略、一个管 worker 的 after_tool 行为。
 */
import { getSetting, setSetting } from "./db/repo";

const ENABLED_KEY = "diagnose.enabled";

/** 读取生效中的开关（从未配置过 = 关；坏记录也按关处理，与默认值一致） */
export function getDiagnoseEnabled(): boolean {
  return getSetting(ENABLED_KEY) === "true";
}

/** 保存开关 */
export function setDiagnoseEnabled(enabled: boolean): void {
  setSetting(ENABLED_KEY, enabled ? "true" : "false");
}
