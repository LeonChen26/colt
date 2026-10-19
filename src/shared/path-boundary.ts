// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「一个相对路径是否逃出了根」——**全仓唯一实现**。
 *
 * ## 为什么要单独一个模块
 *
 * 这条判据先后被复制到四处（主进程 `path-guard`、worker 的 `search-tools` 与 `project`、
 * dev 冒烟），而且**四处都写成了 `rel.startsWith("..")`**。那个写法把合法的 `..foo`
 * 误判成越界——`relative()` 对根下那个文件给出的正是 `..foo`。
 *
 * 后果一：同一个名字在不同层级结论相反（`..foo` 被拒，`src/..foo` 放行），怎么都说不过去。
 * 后果二更要紧：**没人会想到去查这里**——它不报错、不崩，只是某天某个文件突然用不了。
 * 而 `path-guard.ts` 的文件头已经写明自己是「全仓唯一实现」，那就该真的只有一份。
 *
 * ## 判据
 *
 * 必须按**路径段**看，不能看前缀：整段是 `..`、或以 `../` 开头，才算逃出。
 * `...`、`..foo` 这类名字是**合法文件名**，不算。
 *
 * 另外：`path.relative` 在**跨盘**时会直接返回绝对路径（Windows 的 `D:/x`、UNC），
 * 那同样是「不在根内」，所以绝对路径也要算逃出。
 */
import { isAbsolute } from "node:path";

/**
 * 反斜杠统一成 `/`：对内一切比较、匹配、返回都用正斜杠（Windows 上尤其要紧）。
 *
 * 全仓只有这一份。此前 `main/git.ts` 与 `worker/lib/search-tools.ts` 各写了一遍
 * （`replaceAll` 与 `split().join()` 两种写法），同一个路径在不同链路上可能给出
 * 不同的字符串——比较、去重、匹配都会因此对不上，且不会报错。
 */
export function toPosix(value: string): string {
  return value.split("\\").join("/");
}

/**
 * `rel`（相对路径）是否指到根之外。
 *
 * 判法是**逐段走一遍、数净深度**（不是字符串前缀比较）：整段是 `..` 就减一层，
 * 减到负数即逃出。这样连**没归一化**的输入也对——`a/../..` 会被正确判成逃出
 * （我第一版只查「整段是 `..` 或以 `../` 开头」，对 `a/../..` 给的是「没逃出」，
 * 是被自己写的用例逮住的）。调用方现在传的都是 `path.relative()` 的归一化结果，
 * 但判据不该依赖这个前提——那正是「某天某个文件突然用不了」那类问题的土壤。
 *
 * Windows 的 `relative()` 给的是反斜杠，这里统一成 `/` 再判——两种分隔符都认。
 * 空串是**根自身**，不算逃出。
 */
export function escapesRoot(rel: string): boolean {
  if (rel === "") return false;
  const posix = rel.split("\\").join("/");
  if (isAbsolute(posix)) return true;
  let depth = 0;
  for (const segment of posix.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }
  return false;
}
