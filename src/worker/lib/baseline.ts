/**
 * 改动前的内容快照——**净值**（基线 → 现在）的基线那一半。
 *
 * 时机只有一处对：工具**执行之前**。内核 `after_tool` 时文件已经是新内容了，
 * 那一刻再读就只能读到「改完的样子」，净值恒为 0——这类错误不会报错，只会让
 * 界面一直说「已还原」。故调用点在 `before_tool` 闸门（见 `entry.ts`），而不是观测改动的地方。
 *
 * 拿不到基线不算失败，但要**如实**留痕：`text: null` 表示没留住（过大 / 二进制 / 读不了），
 * 净值因而算不出；`existed: false` 表示文件当时还不存在（这次是新建）——两者含义不同，
 * 不可互相顶替，否则新建文件会被当成「没有基线」，整份新增就白算了。
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { FileBaseline } from "@shared/worker-protocol";

/** 留基线的文本上限：与预览同量级。超了就不留——不留只是净值算不出，截断则会算错 */
export const BASELINE_TEXT_LIMIT = 1024 * 1024;

/** 头部出现 NUL 字节即按二进制处理（UTF-8 文本不会含 NUL），与 `file-read.ts` 同一判据 */
const SNIFF_BYTES = 8000;

function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/** 读改动前的文件内容；读不到也要给出**可区分**的结论（见文件头） */
export function captureBaseline(cwd: string, rawPath: string): FileBaseline {
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > BASELINE_TEXT_LIMIT) return { existed: true, text: null };
    const buffer = readFileSync(absolute);
    if (looksBinary(buffer)) return { existed: true, text: null };
    return { existed: true, text: buffer.toString("utf8") };
  } catch (error) {
    // 不存在 = 这次是新建（净变化即整份新增），不是异常
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false, text: "" };
    // 权限不足、链接断掉、目标不是文件……一律按「没留住」处理，绝不猜内容
    return { existed: true, text: null };
  }
}
