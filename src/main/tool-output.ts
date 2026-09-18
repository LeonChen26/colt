// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 工具图片的读取与清理（写方是 worker，见 `src/worker/lib/tool-image-spill.ts`）。
 *
 * 分工的理由：**目录由主进程按 sessionId 算**，渲染层与 worker 都无从指定路径——
 * 若让渲染层传路径回来，等于把任意读盘交给它（而渲染层会渲染 agent 生成的 Markdown），
 * 与 `src/main/file-read.ts` 同一条边界纪律。
 *
 * `sessionId` / `toolCallId` 都会拼进路径，且都来自渲染层请求，故一律先过
 * `safePathSegment` 再碰文件系统。
 */
import { app } from "electron";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_TOOL_IMAGE_BYTES,
  TOOL_OUTPUT_DIR_NAME,
  mimeForExtension,
  safePathSegment,
  type ToolImageResult,
} from "@shared/tool-output";

/** 某会话的工具图片目录（绝对路径）。worker 写、这里读，双方用同一个值 */
export function toolOutputDir(sessionId: string): string {
  return join(app.getPath("userData"), TOOL_OUTPUT_DIR_NAME, sessionId);
}

export function readToolImage(sessionId: string, toolCallId: string): ToolImageResult {
  const dirSegment = safePathSegment(sessionId);
  const base = safePathSegment(toolCallId);
  // 不可信的值一律当「找不到」，绝不拿它去拼路径
  if (dirSegment === undefined || base === undefined) return { status: "missing" };

  const dir = toolOutputDir(dirSegment);
  let match: string | undefined;
  try {
    // 扩展名由写入时的 mimeType 决定，读之前不知道是哪个——按 `<base>.` 前缀找
    match = readdirSync(dir).find((name) => name.startsWith(`${base}.`));
  } catch {
    return { status: "missing" };
  }
  if (match === undefined) return { status: "missing" };

  const mimeType = mimeForExtension(match.slice(base.length + 1));
  if (mimeType === undefined) return { status: "missing" };

  const full = join(dir, match);
  try {
    if (statSync(full).size > MAX_TOOL_IMAGE_BYTES) return { status: "too-large" };
    return { status: "ok", image: { data: readFileSync(full).toString("base64"), mimeType } };
  } catch {
    return { status: "unreadable" };
  }
}

/** 会话删除时连目录一起清掉（与 JSONL 同寿命）；清不掉只是留点孤儿文件，不该让删除失败 */
export function removeToolOutput(sessionId: string): void {
  const segment = safePathSegment(sessionId);
  if (segment === undefined) return;
  try {
    rmSync(toolOutputDir(segment), { recursive: true, force: true });
  } catch {
    // 见上：孤儿文件不影响正确性
  }
}
