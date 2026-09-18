// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 路径越界判定——**全仓唯一实现**。
 *
 * 为什么要有这个文件：此前存在两份同义判定，语义还不一样——
 * `approval/policy.ts` 的 `isInside`（纯字符串折叠、无 realpath）与
 * `file-read.ts` 的 `isWithin`（`path.relative` + realpath 二次校验）。
 * 两份互不引用，于是「软链接把根内的名字指到根外」这条防线**只在文件预览路径上有，
 * 审批闸门上没有**——而审批闸门才是对外动作（写文件 / 上传）的入口。
 * 两份判定漂开时也不会报错，只会「一边说越界、一边说没事」。
 *
 * 这里拆成两个函数，因为两者的**适用时机不同**，不能混：
 *
 * - `isWithinRoot`：**纯字符串、不碰磁盘**。用于「越界必须在任何 fs 访问之前就被拒绝」
 *   的场合（根外的绝对路径不该被 stat，否则等于替调用方做了一次存在性探测），
 *   以及目标**尚不存在**的场合（写入新文件时还没有真实路径可解）。
 * - `isWithinRootReal`：在上面之后**再解一次真实路径**。用于要落地的动作
 *   （审批放行前），挡「根内的软链接指向根外」。
 *
 * 判据用 `path.relative` 而不是字符串前缀：它一并处理分隔符差异、跨盘
 * （跨盘时 `relative` 返回绝对路径，被判为越界）与盘符大小写。
 *
 * ⚠️ **大小写**：`relative` 在 Windows 上**大小写不敏感**（`E:/PROJ/a.ts` 与
 * `E:/proj/a.ts` 视为同一路径），这与 Windows 文件系统的事实一致。
 * 旧 `isInside` 是大小写敏感的，会把 `E:/PROJ/a.ts` 判成越界——那是**误报**：
 * 它是同一个文件，拦下来只是让用户多确认一次，挡不住任何真越界。
 * 真正的越界（前缀不同的兄弟目录、跨盘、`..` 逃逸）不受这条影响。
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * target 是否落在 root 内（**纯字符串**，不访问磁盘）。
 *
 * 相对路径按 root 展开后再判——与审批侧的既有语义一致（入参里的相对路径是相对项目根的）。
 */
export function isWithinRoot(root: string, target: string): boolean {
  const base = resolve(root);
  const absolute = resolve(base, target);
  const rel = relative(base, absolute);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 逐级向上找**第一个存在**的路径（含自身，用 `existsSync`——只看存在，不解析链接）。
 * 全都不存在时返回 null。
 */
function deepestExisting(target: string): string | null {
  let current = target;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 解真实路径后再判一次是否仍落在 root 内。供**审批闸门**使用。
 *
 * 难点在于审批的目标经常**还不存在**（写入一个尚未创建的文件、或一个还没建的目录）。
 * 对它直接 `realpathSync` 会抛 ENOENT——那不是越界，是「还没有」。所以只解析
 * **已存在的那一段**，再区分两种「已存在段落到根外」的情形，两者结论相反：
 *
 * - 中间目录还没建（如根 `E:/proj` 本身就不存在，目标 `E:/proj/src/a.ts`）：
 *   最深存在的是 `E:/`，它在根之上——**放行**，目标将来就落在字符串指定的根内位置。
 * - 软链接逃逸（根内的 `link` 指向根外）：最深存在的 `E:/proj/link`
 *   在**字符串上位于根内**，却解析到根外——**拒绝**。
 *
 * ⚠️ 这两者的判据是「已存在那一段在**字符串上**是否位于根内」，不能省。
 * 少了它就必须无条件回退纯字符串判定，那等于把软链接防线整个撤掉：
 * 逃逸路径在字符串上永远「看起来在根内」。
 */
export function isWithinRootReal(root: string, target: string): boolean {
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    base = resolve(root);
  }
  const absolute = resolve(base, target);
  // 第一道：纯字符串。根外的绝对路径在这里就返回，不碰磁盘。
  if (!isWithinRoot(base, absolute)) return false;

  const deepest = deepestExisting(absolute);
  // 一路都不存在（连盘符都不存在）：没有真实路径可解，信任纯字符串判定
  if (deepest === null) return true;

  let real: string;
  try {
    real = realpathSync(deepest);
  } catch {
    return true;
  }
  if (isWithinRoot(base, real)) return true;

  // 解析到根外：只有「它字符串上本来就在根之上」才是尚未创建，否则是逃逸
  return !isWithinRoot(base, deepest);
}
