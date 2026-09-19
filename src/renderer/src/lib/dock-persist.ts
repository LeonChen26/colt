// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 右栏宽度的持久化（F5 修复）。
 *
 * 宽度的语义在 v1.24 已定调为「全局统一值，不随页签变」——但原先存在 Conversation
 * 的 state 里，而 Conversation 以 `key={sessionId}` 重挂载：切一次会话宽度就丢，
 * 重启更丢。既然是全局语义，就该活在全局存储里。
 *
 * 只存**用户拖出来的值**（null = 从未拖过，用默认宽度，不落存储）；
 * 读取值仍由调用方按当前可用空间钳制（`clampDockWidth`），这里不预判布局。
 */

const STORAGE_KEY = "colt.dockWidth";

/** 读取持久化宽度；无有效值（从未拖过 / 存储不可用）返回 null */
export function loadDockWidth(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级为「从未拖过」
    return null;
  }
}

/** 持久化用户宽度；null 表示恢复默认宽度，删掉存储键 */
export function saveDockWidth(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // 忽略存储失败：宽度退回本次会话内有效，不影响功能
  }
}
