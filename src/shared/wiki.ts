// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * wiki 产物的**唯一位置**（相对项目根）。
 *
 * 三方共用：主进程读、worker 注入指路、渲染层做页内链接归一。
 * 各写一份的后果是「面板能读、链接跳不过去」——这类不一致不会报错，只会某天突然失灵，
 * 与 `shared/path-boundary.ts` 那次「四处各写一份判据」是同一类事故。
 */
export const WIKI_DIR = "docs/wiki";

/**
 * 生成进度日志的环形上限：主进程保留多少行，渲染层合帧时就最多保留多少行。
 * 共用一份是为了避免「主进程说 400、界面按 200 截断」这种对不上账的差异。
 */
export const WIKI_LOG_MAX_LINES = 400;
