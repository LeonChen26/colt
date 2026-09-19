// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 渲染层附件 → 内核内容块。
 *
 * 渲染层传来的是不带 `type` 的精简结构（它不该知道内核的类型），这里补成内核要求的
 * `ImageContent`。与 `system-prompt` 同理由单独成文件：纯转换、与调度无关，
 * 留在入口只会拉长那个有体量闸的文件。
 */
import type { ImageContent } from "@earendil-works/pi-ai";

export function toImageContent(
  images?: { data: string; mimeType: string }[],
): ImageContent[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((image) => ({ type: "image", ...image }));
}
