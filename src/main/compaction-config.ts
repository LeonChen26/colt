// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 压缩设置的持久化（settings 表）。
 *
 * 形态与 `approval/config.ts`（命令白名单）一致：**读时归一化**、写时也归一化，
 * 于是「库里存过一份手改过的脏值」不会一路传到 worker。默认值来自 `@shared/compaction-config`
 * （那里有测试钉它与内核对齐）。
 *
 * ⚠️ 未配置过与「配成默认值」是**两回事**，但对外表现相同：都返回同一份默认配置。
 * 不需要区分——不区分也不会产生歧义（用户改回默认 = 删掉这条设置的效果）。
 */
import { getSetting, setSetting } from "./db/repo";
import {
  DEFAULT_COMPACTION_CONFIG,
  normalizeCompactionConfig,
  type CompactionConfig,
} from "@shared/compaction-config";

/** 全局设置（非会话级）：压缩策略对所有会话生效——它关系到「上下文怎么被丢」，不该按会话分裂 */
const COMPACTION_KEY = "compaction.config";

/** 读取当前生效的压缩配置；未配置过或存的是脏值 → 归一化成可用配置 */
export function getCompactionConfig(): CompactionConfig {
  const raw = getSetting(COMPACTION_KEY);
  if (raw === undefined) return DEFAULT_COMPACTION_CONFIG;
  try {
    return normalizeCompactionConfig(JSON.parse(raw));
  } catch {
    // 落库内容是 JSON 文本，理论上不会坏；真坏了就回落默认值（压缩照常按内核默认跑），
    // 而不是让整个设置读取路径抛错把界面也带下去。
    return DEFAULT_COMPACTION_CONFIG;
  }
}

/** 保存压缩配置，返回归一化后的结果（调用方据此显示真实生效值，而不是回显用户输入） */
export function setCompactionConfig(input: unknown): CompactionConfig {
  const normalized = normalizeCompactionConfig(input);
  setSetting(COMPACTION_KEY, JSON.stringify(normalized));
  return normalized;
}
