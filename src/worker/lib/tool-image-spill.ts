/**
 * 把工具结果里的图片落盘：`<dir>/<toolCallId>.<ext>`。
 *
 * 为什么由 **worker** 写、而不是发给主进程写：主进程写的话，每开一次会话都得把
 * 历史上所有图片**再过一遍 IPC**——它无从知道哪张已经在盘上；而 worker 可以先看一眼
 * 文件在不在，只补缺的那些，重开会话几乎零成本（且不需要给 `WorkerMessage` 加新类型）。
 *
 * 失败**不抛**：写不进去顶多是「这张图展开时看不到」，不该因此打断会话——
 * 卡片会如实说读不到（那是渲染层的失败态，不是这里静默）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolImageFileName } from "@shared/tool-output";
import { extractImage } from "./project";

/**
 * 扫描 transcript，把还没落盘的图片写下去。
 *
 * `done` 是**每个 worker 生命周期**的记账：认下一条就记下，之后每次 flush 只做一次
 * Set 查询（不碰磁盘）。重开会话时它是空的，于是会重新扫一遍——但每张都先
 * `existsSync`，已经在盘上的直接跳过，所以代价只是几个 stat。
 */
export function spillToolImages(
  transcript: readonly unknown[],
  dir: string,
  done: Set<string>,
): void {
  let ensured = false;
  for (const entry of transcript) {
    const record = entry as {
      type?: string;
      message?: { role?: string; toolCallId?: string; content?: unknown };
    };
    if (record.type !== "message" || record.message?.role !== "toolResult") continue;
    const toolCallId = record.message.toolCallId;
    if (typeof toolCallId !== "string" || done.has(toolCallId)) continue;
    const image = extractImage(record.message.content);
    const fileName =
      image === undefined ? undefined : toolImageFileName(toolCallId, image.mimeType);
    // 认不出类型的图片不落盘：它仍内联在视图里（见 project.ts），这里不插手
    if (image === undefined || fileName === undefined) continue;
    // 先记账再写：写失败也不重试，否则每个 flush 都要撞一次同样的错
    done.add(toolCallId);
    try {
      const target = join(dir, fileName);
      if (existsSync(target)) continue;
      if (!ensured) {
        mkdirSync(dir, { recursive: true });
        ensured = true;
      }
      writeFileSync(target, Buffer.from(image.data, "base64"));
    } catch {
      // 落盘失败只是「这张图按需读不到」，不打断会话
    }
  }
}
