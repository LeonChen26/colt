/**
 * git 分支读取测试。
 * 会话头要回答「我在哪个分支」——读错比不读更危险，故覆盖 ref / 游离 / worktree / 非仓库。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { parseHeadContent, readGitStatus } from "../src/main/git.ts";

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
