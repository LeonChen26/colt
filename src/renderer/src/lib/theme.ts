// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 主题管理：亮 / 暗 / 跟随系统 三态。
 *
 * 实现方式：在 <html> 上挂 data-theme，由 styles.css 里的令牌覆盖决定配色。
 *   data-theme="dark"   → 使用 @theme 默认（暗）
 *   data-theme="light"  → :root[data-theme="light"] 覆盖为亮
 *   data-theme="system" → @media(prefers-color-scheme) 跟随系统
 */

export type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "colt.theme";

/** 读取持久化主题；无有效值时默认暗色（对齐高保真，暗色是设计基调） */
export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "system") return raw;
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级
  }
  return "dark";
}

/** 把主题写到 <html> 上，驱动 CSS 令牌切换 */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/** 持久化主题 */
export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // 忽略存储失败
  }
}
