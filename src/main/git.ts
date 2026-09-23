// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isWithinRoot } from "./lib/path-guard";
import type { GitCommittedResult, GitStatus } from "@shared/protocol";

const HEAD_REF_PREFIX = "ref: refs/heads/";

/** 解析 .git/HEAD：指向分支则为分支名，直接指向提交则视为游离 HEAD */
export function parseHeadContent(content: string): { branch: string | null; detached: boolean } {
  const text = content.trim();
  if (text.startsWith(HEAD_REF_PREFIX)) {
    const branch = text.slice(HEAD_REF_PREFIX.length).trim();
    return branch.length > 0 ? { branch, detached: false } : { branch: null, detached: false };
  }
  if (/^[0-9a-f]{40}$/i.test(text)) return { branch: null, detached: true };
  return { branch: null, detached: false };
}

/** 自 cwd 向上找 .git；worktree / submodule 的 .git 是含 "gitdir:" 的文件 */
function resolveGitDir(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        if (statSync(dotGit).isDirectory()) return dotGit;
        const match = /^gitdir:\s*(.+)$/im.exec(readFileSync(dotGit, "utf8").trim());
        if (match) {
          const target = match[1].trim();
          return isAbsolute(target) ? target : resolve(dir, target);
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 读取工作目录的 git 状态；非仓库或读取失败时隐藏分支而非报错 */
export function readGitStatus(cwd: string): GitStatus {
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return { isRepo: false, branch: null, detached: false };
  try {
    const { branch, detached } = parseHeadContent(readFileSync(join(gitDir, "HEAD"), "utf8"));
    return { isRepo: true, branch, detached };
  } catch {
    return { isRepo: true, branch: null, detached: false };
  }
}

/** 归一为正斜杠（比较与传给 git 的 pathspec 都用它；Windows 下 git 只认正斜杠形式最稳） */
const toPosix = (path: string): string => path.replaceAll("\\", "/");

/** execFile 的公共参数：只读操作，别在失败处打扰用户（超时即杀，不给慢仓库拖住 IPC 的机会） */
const GIT_SPAWN_OPTIONS = { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 } as const;

/** 降级结论：一个都不标。非仓库 / git 不可用 / 执行失败在 UI 上同形（都不标） */
const NOT_REPO: GitCommittedResult = { isRepo: false, committed: [] };

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", args, { ...GIT_SPAWN_OPTIONS, cwd }, (error, stdout) => {
      if (error === null) resolvePromise(stdout);
      else rejectPromise(error);
    });
  });
}

/**
 * 批量判定「这些文件是否已提交」（与 HEAD 一致）。
 *
 * 口径（与 `GitCommittedResult` 的注释一致）：已跟踪且当前内容与 HEAD 一致 = 已提交；
 * 修改过 / 暂存过 / 未跟踪 / 被忽略 / 盘上不存在，一律不标。
 *
 * 实现是**两次只读 spawn**：
 *   1. `rev-parse --show-toplevel` 找仓库根——项目根可能是大仓库的子目录，输出里的
 *      路径一律相对**仓库根**，拿仓库根才能把两边对到同一条坐标系上；
 *   2. `--no-optional-locks status --porcelain -z --no-renames --ignored -- <绝对路径…>`：
 *      status 只列**有变化**的文件，不在输出里 = 与 HEAD 一致；`--no-optional-locks`
 *      保证连索引刷新都不写（保持纯只读），`-z` 免去引号解码，`--no-renames` 免去
 *      「重命名条目后跟第二段路径」的配对解析，`--ignored` 让被忽略的文件也现身
 *      （否则它们不在输出里，会被误判成已提交）。
 *
 * 越界路径（根外绝对路径 / `..` 逃逸）与盘上不存在的路径**直接判不提交**：前者与
 * `file.read` 同一条信任边界（先于任何 git 调用拒绝；根**内**的绝对路径照收——工具入参
 * 里的 path 由模型给出，常是绝对路径），后者在 git 的输出里根本不现身，不挡就会把
 * 「不存在」误判成「已提交」。
 */
export async function readCommittedFiles(
  cwd: string,
  paths: string[],
): Promise<GitCommittedResult> {
  const root = resolve(cwd);
  const safe: string[] = [];
  for (const raw of paths) {
    const normalized = toPosix(raw).trim();
    if (normalized === "") continue;
    if (!isWithinRoot(root, normalized)) continue;
    // 已提交的文件必然还在盘上；顺带把「不存在」挡在 git 之前（git 对它什么都不会说）。
    // 用 `resolve` 而非 `join`：根**内**的绝对路径也照收（同 file-read），join 会拼错
    if (!existsSync(resolve(root, normalized))) continue;
    safe.push(normalized);
  }
  if (safe.length === 0) return NOT_REPO;

  let topLevel: string;
  try {
    topLevel = (await runGit(["rev-parse", "--show-toplevel"], root)).trim();
  } catch {
    // 非仓库（含 git 不在 PATH）——与「判定不了」同形：全部不标
    return NOT_REPO;
  }

  let output: string;
  try {
    output = await runGit(
      [
        "--no-optional-locks",
        "status",
        "--porcelain",
        "-z",
        "--no-renames",
        "--ignored",
        "--",
        ...safe.map((path) => toPosix(resolve(root, path))),
      ],
      topLevel,
    );
  } catch {
    return NOT_REPO;
  }

  // 输出条目形如 `XY <path>`（NUL 分隔，path 相对仓库根）；不在其中 = 与 HEAD 一致
  const shown = new Set<string>();
  for (const entry of output.split("\0")) {
    if (entry !== "" && entry.length > 3 && entry[2] === " ") {
      shown.add(toPosix(resolve(topLevel, entry.slice(3))));
    }
  }

  const committed = safe.filter((path) => !shown.has(toPosix(resolve(root, path))));
  return { isRepo: true, committed };
}
