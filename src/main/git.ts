import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GitStatus } from "@shared/protocol";

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
