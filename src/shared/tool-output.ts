// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 工具输出的落盘约定：**worker 写、主进程读、渲染层按 (sessionId, toolCallId) 要**。
 *
 * 为什么要有这个文件：带图的工具结果（浏览器 / 电脑截图）单条就能有几百 KB ~ 几 MB，
 * 而 `ConversationView` 是**全量快照**——流式期间每 50ms 重推一次（见 `worker/entry.ts`
 * 的 `scheduleFlush`），等于把历史里每一张截图的 base64 反复序列化、跨进程发送。
 * 同一份数据被重复搬运几十上百次，这才是「会话一长就卡」的大头。
 *
 * 所以：图片不进视图，落盘一次；视图里只留一个 `hasImage` 标记，卡片展开时再读回来。
 *
 * 命名与校验放在 shared 的理由：写方（worker）与读方（主进程）必须用**同一套**规则，
 * 否则会出现「写了读不到」这种最难查的分歧。而 `toolCallId` 来自模型 / 渲染层，
 * 是**不可信输入**且最终会被拼进文件路径——故在这里统一做白名单校验，
 * 读取方据此拒绝任何可疑值（越界判断先于任何 fs 访问，与 `src/main/file-read.ts` 同一条纪律）。
 */

/** 落盘目录名（主进程在 userData 下建它；worker 拿主进程下发的绝对路径写） */
export const TOOL_OUTPUT_DIR_NAME = "tool-output";

/** 单张图片的落盘上限：与 `file.read` 的图片上限一致，避免同一件事有两套数 */
export const MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024;

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * 一段可安全拼进路径的标识（工具调用 id、会话 id）。**只收安全字符**，否则返回 undefined。
 *
 * 刻意要求首字符是字母或数字：`..`、`.foo` 这类「像相对路径」的值连门都进不来。
 * 上限 128 是为了别让文件名长到某些文件系统报错。
 *
 * 两个来源都是**不可信输入**：`toolCallId` 来自模型与渲染层，`sessionId` 来自渲染层的
 * 请求参数。凡是拿它们拼路径的地方（worker 写、主进程读/删）都必须先过这一关——
 * 越界判断先于任何 fs 访问，与 `src/main/file-read.ts` 同一条纪律。
 */
export function safePathSegment(value: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : undefined;
}

/** 图片 mimeType → 扩展名；**不认识就返回 undefined**（调用方据此回落到「内联」而不是猜） */
export function imageExtension(mimeType: string): string | undefined {
  const normalized = mimeType.trim().toLowerCase();
  for (const [ext, mime] of Object.entries(EXT_TO_MIME)) {
    if (mime === normalized) return ext;
  }
  return undefined;
}

/** 扩展名 → 图片 mimeType（读回来时用；不认识返回 undefined，绝不瞎猜） */
export function mimeForExtension(ext: string): string | undefined {
  return EXT_TO_MIME[ext.trim().toLowerCase()];
}

/**
 * 能否把这张图落盘并**原样读回**。
 *
 * 返回 undefined 时调用方必须**保留内联**（宁可这一条视图大一点）：
 * 认不出的图片类型若被当成 png 存下来，读回时会带着错误的 mime 渲染——
 * 那是「图在但显示不出来」，比不落盘更糟。
 */
export function toolImageFileName(
  toolCallId: string,
  mimeType: string,
): string | undefined {
  const base = safePathSegment(toolCallId);
  const ext = imageExtension(mimeType);
  if (base === undefined || ext === undefined) return undefined;
  return `${base}.${ext}`;
}

/**
 * 「按需读回一张工具图片」的结果（渲染层 ← 主进程，走 `session.toolOutput`）。
 *
 * 刻意分成四档而不是「有 / 没有」：界面该说的话不一样——
 * 把「文件太大」或「读不出来」一律说成「不存在」，等于撒谎（`docs/ERRORS.md`）。
 */
export type ToolImageResult =
  | { status: "ok"; image: { data: string; mimeType: string } }
  | { status: "missing" }
  | { status: "too-large" }
  | { status: "unreadable" };
