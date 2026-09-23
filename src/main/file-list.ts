// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 列**项目内**某目录的一层（「文件」页签的懒加载树）。
 *
 * 安全边界与 `file-read.ts` 同一套（这也是它存在的全部理由：入参来自渲染层）：
 * 根由 IPC 层从会话所属项目查出后传入，这里给的路径必须落在根内，三重校验：
 *   1. `resolve` 后必须仍落在根内——挡 `../` 逃逸与「根外的绝对路径」（纯字符串，先于任何 fs）；
 *   2. `realpath` 之后再判一次——挡「根内的软链接指向根外」；
 *   3. `statSync` 必须是目录。
 *
 * 与 `readFileWithin` 的一个入参差异：**`""` 是合法值**（表示项目根）——
 * 浏览器总是从根开始逛，要求非空只会逼调用方传 `"."`。
 *
 * 已知怪癖：**指向祖先的软链接**（如 `src/link -> ..`）realpath 后仍在根内、不越界，
 * 但它的子条目 `path` 会与真实路径**同键**——树里同一子树可能在多处出现并共享展开态。
 * 无崩溃无越界，接受它（VS Code 同类行为）。
 *
 * 纯 Node（不 import electron），故可直接被 `tests/file-list.test.ts` 覆盖。
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isWithinRoot } from "./lib/path-guard";
import type { FsEntry } from "@shared/protocol";

/** 单层条目上限：超出即截断（`truncated` 如实说），防一个巨型目录把 IPC 与渲染层撑爆 */
export const LIST_ENTRY_LIMIT = 500;

/**
 * 刻意隐藏的目录名。列出来不是「不想让用户看见」，而是「列出来没有意义」：
 * `.git` 是上千个哈希对象的仓库、`node_modules` 是依赖的黑盒——各占满一层却无人浏览。
 * 隐藏**必须如实返回**（`hidden` 字段），让 UI 标注「已隐藏这些」而不是静默吞掉。
 */
export const HIDDEN_DIR_NAMES = new Set([".git", "node_modules"]);

/** 目录在前、同层按名字升序（数字序 + 大小写不敏感，Windows 资源管理器惯例） */
function compareEntries(a: FsEntry, b: FsEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * 越界、不存在、非目录、权限不足都会抛错，让渲染层拿到一句可读的原因。
 *
 * 返回的 `path` 一律是相对项目根的 posix 风格（目录不带尾斜杠），与 `ViewFileChange.path`
 * 同口径——它要能直接回填给 `file.read` / `file.list` 当入参。
 */
export function listDirWithin(
  root: string,
  requestedPath: string,
): { entries: FsEntry[]; truncated: boolean; hidden: string[] } {
  const rootReal = realpathSync(root);
  // 相对路径按根展开；绝对路径原样保留。resolve 是纯字符串运算，不碰磁盘。
  const absolute = resolve(rootReal, requestedPath);
  if (!isWithinRoot(rootReal, absolute)) throw new Error("路径越界：只能浏览项目内的目录");

  // 软链接可以把「根内的名字」指到根外，所以必须在 realpath 之后再判一次
  const targetReal = realpathSync(absolute);
  if (!isWithinRoot(rootReal, targetReal)) throw new Error("路径越界：只能浏览项目内的目录");

  const stat = statSync(targetReal);
  if (!stat.isDirectory()) throw new Error("目标不是目录");

  let raw;
  try {
    raw = readdirSync(targetReal, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new Error("权限不足：无法列出该目录");
    throw error;
  }

  const hidden: string[] = [];
  const entries: FsEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const name = raw[i].name;
    if (HIDDEN_DIR_NAMES.has(name) && raw[i].isDirectory()) {
      hidden.push(name);
      continue;
    }
    // kind：Dirent 直接给；symlink 得 stat 一次才知道指向的是目录还是文件
    // （竞态中被删的条目静默跳过——列目录是快照，agent 正在删文件是常态）
    let kind: "dir" | "file";
    if (raw[i].isDirectory()) {
      kind = "dir";
    } else if (raw[i].isFile()) {
      kind = "file";
    } else if (raw[i].isSymbolicLink()) {
      const target = statSync(resolve(targetReal, name), { throwIfNoEntry: false });
      if (target === undefined) continue;
      kind = target.isDirectory() ? "dir" : "file";
    } else {
      continue;
    }
    // 不取 size：渲染层没有任何地方显示它，而每个文件一次同步 stat 在大目录（500 条
    // 上限附近）足以卡住主进程可感知的一瞬——白付的成本，砍掉（想要时按需加回并给消费方）
    entries.push({ name, path: relative(rootReal, resolve(targetReal, name)).replaceAll("\\", "/"), kind });
    // 恰好 500 条不多不少时不是截断：只有「还有下一条却装不下」才算
    if (entries.length >= LIST_ENTRY_LIMIT && i < raw.length - 1) {
      entries.sort(compareEntries);
      return { entries, truncated: true, hidden };
    }
  }

  entries.sort(compareEntries);
  return { entries, truncated: false, hidden };
}
