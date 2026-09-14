/**
 * 读取**项目内**文件用于预览。
 *
 * 本模块存在的**全部理由**是安全边界：入参来自渲染层，而渲染层会渲染 agent 生成的
 * Markdown——所以绝不能让调用方指定「读哪个根」。根由 IPC 层从**会话所属项目**查出后传入，
 * 这里给的路径**必须落在根内**，并做三重校验：
 *   1. `resolve` 后必须仍落在根内——挡 `../` 逃逸与「根外的绝对路径」；
 *   2. `realpath` 之后**再判一次**——挡「根内的软链接指向根外」；
 *   3. 大小上限 + 二进制判定——别把几十 MB 的二进制塞进 IPC 与渲染层。
 *
 * **为什么收绝对路径**：工具入参里的 path 由模型给出，可能是绝对路径
 * （`renderer/lib/format.ts` 的 `matchChangeByPath` 注释已记录这一点）。若只收相对路径，
 * 「点 read 出来的绝对路径」就永远打不开。收绝对路径**不削弱安全**：包含性判断是
 * **纯字符串运算**，先于任何 fs 访问——根外的绝对路径在 `isWithin` 就返回，不会去碰磁盘，
 * 因此它与「相对路径 `../` 逃逸」在可观测行为上完全一致（没有存在性探测的先手）。
 *
 * 纯 Node（不 import electron），故可直接被 `tests/file-read.test.ts` 覆盖。
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { FileReadResult } from "@shared/protocol";

/** 文本预览上限：超出只回「过大」，**不做截断**——半截文件比看不到更容易误导 */
export const FILE_TEXT_LIMIT = 1024 * 1024;
/** 图片预览上限：要转 base64 走 IPC，比文本更贵，所以放得宽松但仍有界 */
export const FILE_IMAGE_LIMIT = 8 * 1024 * 1024;
/** 二进制判定的嗅探字节数：只扫头部，不必为判定读完整文件 */
const SNIFF_BYTES = 8000;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/**
 * target 是否落在 root 内。
 * 用 `relative` 而不是字符串前缀：它一并处理分隔符差异、盘符大小写与跨盘
 * （跨盘时 `relative` 返回绝对路径，会被下面判为越界）。
 */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 头部出现 NUL 字节即按二进制处理（UTF-8 文本不会含 NUL） */
function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * 越界、不存在、非文件都会抛错，让渲染层拿到一句可读的原因。
 *
 * 入参接受**相对路径**（按根展开）与**绝对路径**（原样），但两者都必须落在根内——
 * 越界在**任何 fs 访问之前**即被拒绝（见文件头注释）。
 */
export function readFileWithin(root: string, requestedPath: string): FileReadResult {
  if (requestedPath.trim() === "") throw new Error("路径为空");

  const rootReal = realpathSync(root);
  // 相对路径按根展开；绝对路径原样保留。resolve 是纯字符串运算，不碰磁盘。
  const absolute = resolve(rootReal, requestedPath);
  if (!isWithin(rootReal, absolute)) throw new Error("路径越界：只能读取项目内的文件");

  // 软链接可以把「根内的名字」指到根外，所以必须在 realpath 之后再判一次
  const targetReal = realpathSync(absolute);
  if (!isWithin(rootReal, targetReal)) throw new Error("路径越界：只能读取项目内的文件");

  const stat = statSync(targetReal);
  if (!stat.isFile()) throw new Error("目标不是文件");
  const size = stat.size;

  const mime = IMAGE_MIME[extname(targetReal).toLowerCase()];
  if (mime !== undefined) {
    if (size > FILE_IMAGE_LIMIT) return { kind: "too-large", size, limit: FILE_IMAGE_LIMIT };
    const buffer = readFileSync(targetReal);
    return { kind: "image", dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, size };
  }

  if (size > FILE_TEXT_LIMIT) return { kind: "too-large", size, limit: FILE_TEXT_LIMIT };

  const buffer = readFileSync(targetReal);
  if (looksBinary(buffer)) return { kind: "binary", size };
  return { kind: "text", text: buffer.toString("utf8"), size };
}
