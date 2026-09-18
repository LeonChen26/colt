// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 图标规范
 *
 * 全应用图标统一来自 lucide-react（线性 SVG），此处集中定义尺寸档与描边规则，
 * 避免各处散落 size={11/12/13/14/16} 造成视觉不齐。
 *
 * 用法：
 *   import { ICON } from "@/lib/icon";
 *   <GitBranch {...ICON.sm} />
 *
 * 档位（对齐设计文档）：
 *   xs 11  微缩：徽章内、密集列表的状态点旁
 *   sm 13  小：按钮内、工具卡头部、树节点行
 *   md 14  中：区块标题、面板开关（默认）
 *   lg 16  大：顶栏、主操作按钮
 *
 * 描边统一 1.75（lucide 默认 2 偏粗，在暗色小尺寸下显脏）。
 */

export const ICON_STROKE = 1.75;

export const ICON = {
  xs: { size: 11, strokeWidth: ICON_STROKE },
  sm: { size: 13, strokeWidth: ICON_STROKE },
  md: { size: 14, strokeWidth: ICON_STROKE },
  lg: { size: 16, strokeWidth: ICON_STROKE },
} as const;

/** 图标尺寸档位名 */
export type IconSize = keyof typeof ICON;
