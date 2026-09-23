/**
 * git 分支读取测试。
 * 会话头要回答「我在哪个分支」——读错比不读更危险，故覆盖 ref / 游离 / worktree / 非仓库。
 * readCommittedFiles（「已提交」批量判定）也在本文件：它同样只读、纯 Node，
 * 用真实临时仓库钉住 status 输出的解析口径（committed / 修改 / 未跟踪 / 忽略 / 不存在）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { parseHeadContent, readCommittedFiles, readGitStatus } from "../src/main/git.ts";

describe("parseHeadContent", () => {
  test("指向分支时取分支名", () => {
    assert.deepEqual(parseHeadContent("ref: refs/heads/main\n"), {
      branch: "main",
      detached: false,
    });
  });

  test("分支名可含斜杠", () => {
    assert.deepEqual(parseHeadContent("ref: refs/heads/feat/x"), {
      branch: "feat/x",
      detached: false,
    });
  });

  test("指向提交哈希时视为游离 HEAD", () => {
    assert.deepEqual(parseHeadContent("a".repeat(40)), { branch: null, detached: true });
  });

  test("空内容既不给分支也不认为游离", () => {
    assert.deepEqual(parseHeadContent("  \n"), { branch: null, detached: false });
  });
});

describe("readGitStatus", () => {
  test("识别仓库并读出分支", () => {
    const root = makeTempDir("colt-git-");
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      assert.deepEqual(readGitStatus(root), { isRepo: true, branch: "main", detached: false });
    } finally {
      removeTempDir(root);
    }
  });

  test("从子目录向上找到仓库", () => {
    const root = makeTempDir("colt-git-");
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/dev\n");
      const nested = join(root, "src", "deep");
      mkdirSync(nested, { recursive: true });
      assert.equal(readGitStatus(nested).branch, "dev");
    } finally {
      removeTempDir(root);
    }
  });

  test("worktree / submodule：.git 是指向 gitdir 的文件", () => {
    const root = makeTempDir("colt-git-");
    try {
      const real = join(root, "real-git");
      mkdirSync(real);
      writeFileSync(join(real, "HEAD"), "ref: refs/heads/wt\n");
      const wt = join(root, "wt");
      mkdirSync(wt);
      writeFileSync(join(wt, ".git"), `gitdir: ${real}\n`);
      assert.deepEqual(readGitStatus(wt), { isRepo: true, branch: "wt", detached: false });
    } finally {
      removeTempDir(root);
    }
  });

  test("非仓库目录返回 isRepo=false", () => {
    const root = makeTempDir("colt-git-");
    try {
      assert.deepEqual(readGitStatus(join(root, "nope")), {
        isRepo: false,
        branch: null,
        detached: false,
      });
    } finally {
      removeTempDir(root);
    }
  });

  test("仓库内 HEAD 缺失时不抛错，仅隐藏分支", () => {
    const root = makeTempDir("colt-git-");
    try {
      mkdirSync(join(root, ".git"));
      assert.deepEqual(readGitStatus(root), { isRepo: true, branch: null, detached: false });
    } finally {
      removeTempDir(root);
    }
  });
});

// ---------------------------------------------------------------------------
// readCommittedFiles：「已提交」批量判定。用真实临时仓库（git 不在 PATH 上时整组跳过
// ——前提自证：解析口径必须对着真 git 的输出钉，stub 出来的只是自说自话）。
// ---------------------------------------------------------------------------

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const skipIfNoGit = { skip: gitAvailable ? false : "git 不可用" };

/** 在临时目录里跑 git（同步）；身份用 -c 传入，不碰全局 / 系统配置（装置不留副作用） */
function gitRun(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败：${String(result.stderr)}`);
  }
}

/** 建一个带一次提交的临时仓库；files 的键是相对仓库根的路径 */
function makeRepo(files: Record<string, string>): string {
  const root = makeTempDir("colt-gitc-");
  gitRun(["init", "-q"], root);
  for (const [rel, text] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  gitRun(["add", "."], root);
  gitRun(
    ["-c", "user.email=smoke@colt", "-c", "user.name=colt-smoke", "commit", "-q", "-m", "init"],
    root,
  );
  return root;
}

describe("readCommittedFiles", () => {
  test(
    "已提交 / 修改过 / 未跟踪 / 不存在，一次分清",
    skipIfNoGit,
    async () => {
      const root = makeRepo({ "clean.txt": "1\n", "dirty.txt": "1\n" });
      try {
        writeFileSync(join(root, "dirty.txt"), "2\n");
        writeFileSync(join(root, "untracked.txt"), "new\n");
        const result = await readCommittedFiles(root, [
          "clean.txt",
          "dirty.txt",
          "untracked.txt",
          "missing.txt",
        ]);
        assert.equal(result.isRepo, true);
        // 不在输出里才算「已提交」；不存在 / 未跟踪都不能冒充（不标 ≠ 报错）
        assert.deepEqual(result.committed, ["clean.txt"]);
      } finally {
        removeTempDir(root);
      }
    },
  );

  test(
    "被忽略的文件不冒充已提交（--ignored）",
    skipIfNoGit,
    async () => {
      const root = makeRepo({ "keep.txt": "1\n", ".gitignore": "ignored.txt\n" });
      try {
        writeFileSync(join(root, "ignored.txt"), "1\n");
        const result = await readCommittedFiles(root, ["keep.txt", "ignored.txt"]);
        assert.deepEqual(result.committed, ["keep.txt"]);
      } finally {
        removeTempDir(root);
      }
    },
  );

  test(
    "暂存过但没提交的文件不算已提交",
    skipIfNoGit,
    async () => {
      const root = makeRepo({ "a.txt": "1\n" });
      try {
        writeFileSync(join(root, "staged.txt"), "1\n");
        gitRun(["add", "staged.txt"], root);
        const result = await readCommittedFiles(root, ["a.txt", "staged.txt"]);
        assert.deepEqual(result.committed, ["a.txt"]);
      } finally {
        removeTempDir(root);
      }
    },
  );

  test(
    "项目根是仓库子目录时坐标系仍对（rev-parse + 绝对 pathspec）",
    skipIfNoGit,
    async () => {
      const root = makeRepo({
        "sub/clean.txt": "1\n",
        "sub/dirty.txt": "1\n",
        "other.txt": "1\n",
      });
      try {
        writeFileSync(join(root, "sub", "dirty.txt"), "2\n");
        // 入参相对**项目根**（sub/），而 git 输出相对**仓库根**——这正是本用例要钉的换算
        const result = await readCommittedFiles(join(root, "sub"), ["clean.txt", "dirty.txt"]);
        assert.deepEqual(result.committed, ["clean.txt"]);
      } finally {
        removeTempDir(root);
      }
    },
  );

  test(
    "根内绝对路径照收，根外绝对路径与 .. 逃逸直接不标",
    skipIfNoGit,
    async () => {
      const root = makeRepo({ "a.txt": "1\n" });
      const outside = makeTempDir("colt-gitc-");
      try {
        writeFileSync(join(outside, "escape.txt"), "1\n");
        const result = await readCommittedFiles(root, [
          join(root, "a.txt"),
          join(outside, "escape.txt"),
          "../escape.txt",
        ]);
        assert.equal(result.committed.length, 1);
        assert.match(result.committed[0] ?? "", /a\.txt$/);
      } finally {
        removeTempDir(root);
        removeTempDir(outside);
      }
    },
  );

  test(
    "反斜杠入参归一为正斜杠；含空格 / 中文的路径不靠引号解码",
    skipIfNoGit,
    async () => {
      const root = makeRepo({ "sub/file.txt": "1\n", "docs/space name 中文.md": "1\n" });
      try {
        const result = await readCommittedFiles(root, ["sub\\file.txt", "docs/space name 中文.md"]);
        assert.deepEqual(result.committed, ["sub/file.txt", "docs/space name 中文.md"]);
      } finally {
        removeTempDir(root);
      }
    },
  );

  test(
    "非仓库目录：isRepo=false，一个不标",
    skipIfNoGit,
    async () => {
      const root = makeTempDir("colt-gitc-");
      try {
        writeFileSync(join(root, "a.txt"), "1\n");
        assert.deepEqual(await readCommittedFiles(root, ["a.txt"]), {
          isRepo: false,
          committed: [],
        });
      } finally {
        removeTempDir(root);
      }
    },
  );

  test("没有可判定的文件时不跑 git（空清单即空结论）", async () => {
    assert.deepEqual(await readCommittedFiles(process.cwd(), []), {
      isRepo: false,
      committed: [],
    });
  });
});
