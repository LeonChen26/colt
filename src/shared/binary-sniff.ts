// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「这个文件是不是二进制」的唯一判据：**头部出现 NUL 字节**即当二进制
 * （UTF-8 文本不会含 NUL）。
 *
 * 为什么抽到 shared：main 的预览（`main/file-read.ts`）、worker 的净值基线
 * （`worker/lib/baseline.ts`）与只读检索（`worker/lib/search-tools.ts`）各判一次，
 * 三处规则一旦漂开，同一个文件会出现「预览说二进制 / 基线说文本 / 搜索跳过」三种结论。
 * 此前 `search-tools.ts` 还硬编码了 `8192`，与 `SNIFF_BYTES = 8000` 已经对不上——
 * 这类差异不会报错，只会让结论莫名其妙地不一致。
 *
 * 只扫头部：判定只需要「有没有 NUL」，不必为它读完整文件。窗口长度取
 * `@shared/limits` 的 `SNIFF_BYTES`，**不要**在调用方再写一个数字。
 */
import { SNIFF_BYTES } from "./limits";

export function looksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}
