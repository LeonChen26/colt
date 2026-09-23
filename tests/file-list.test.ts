/**
 * 「文件」页签后端（列目录）的安全边界与排序 / 截断测试。
 *
 * 与 file-read.test.ts 同一条纪律：入参来自渲染层，边界写错等于把「列任意目录」
 * 的能力交出去，所以逃逸（`../`、绝对路径、链接）逐条钉住；hidden / 截断 /
 * 排序是产品行为，也要钉住（「静默吞掉隐藏目录」与「恰好 500 条误报截断」
 * 都是靠用例抓住的那类错）。
 *
 * 越界链接用**目录联接（junction）**构造——理由与注意事项见 file-read.test.ts 的注释。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { LIST_ENTRY_LIMIT, listDirWithin } from "../src/main/file-list.ts";

let root = "";
let outside = "";
/** 指向根外的 junction（相对根的路径）；空串表示没建出来（原因见 file-read.test.ts 同款注释） */
let escapePath = "";
let escapeNote = "";

before(() => {
  root = makeTempDir("colt-list-root-");
  outside = makeTempDir("colt-list-outside-");
  // 排序夹具：目录 + 大小写混排 + 数字序（B.ts vs a.ts、file10 vs file9）
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "B.ts"), "b");
  writeFileSync(join(root, "a.ts"), "a");
  writeFileSync(join(root, "file9.txt"), "9");
  writeFileSync(join(root, "file10.txt"), "10");
  writeFileSync(join(root, "README.md"), "# r");
  // hidden 夹具
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref");
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "node_modules", "some-pkg"));
  // 子目录夹具（懒加载第二层）
  writeFileSync(join(root, "docs", "guide.md"), "# g");
  writeFileSync(join(outside, "secret.txt"), "机密");

  try {
    symlinkSync(outside, join(root, "escape-dir"), "junction");
  } catch (e) {
    escapeNote = `junction: ${(e as NodeJS.ErrnoException).code} ${(e as Error).message}`;
  }
  if (existsSync(join(root, "escape-dir"))) {
    escapePath = "escape-dir";
  } else {
    escapeNote += `${escapeNote ? " | " : ""}junction 没建成（权限不足？）`;
  }

  // 截断夹具：一个装了 501 个文件的目录（501 = 上限 500 + 1 条「装不下」）
  mkdirSync(join(root, "big"));
  for (let i = 0; i < LIST_ENTRY_LIMIT + 1; i += 1) {
    writeFileSync(join(root, "big", `f${String(i).padStart(3, "0")}.txt`), "");
  }
  // 恰好 500 条的目录（不该报 truncated）
  mkdirSync(join(root, "exact"));
  for (let i = 0; i < LIST_ENTRY_LIMIT; i += 1) {
    writeFileSync(join(root, "exact", `e${String(i).padStart(3, "0")}.txt`), "");
  }
});

after(() => {
  removeTempDir(root);
  removeTempDir(outside);
});

describe("listDirWithin：安全边界", () => {
  test("根目录（空串）列出一层", () => {
    const { entries, hidden, truncated } = listDirWithin(root, "");
    assert.equal(truncated, false);
    assert.deepEqual(
      hidden.sort(),
      [".git", "node_modules"].sort(),
    );
    const names = entries.map((entry) => entry.name);
    assert.ok(names.includes("README.md"));
    assert.ok(names.includes("docs"));
    assert.ok(!names.includes(".git"));
    assert.ok(!names.includes("node_modules"));
  });

  test("子目录路径可用（分隔符两种都收，返回一律 posix）", () => {
    const { entries } = listDirWithin(root, "docs");
    assert.deepEqual(entries.map((entry) => entry.path), ["docs/guide.md"]);
  });

  test("目录在前、同级数字序 + 大小写不敏感（资源管理器惯例）", () => {
    const { entries } = listDirWithin(root, "");
    const kinds = entries.map((entry) => entry.kind);
    // 目录全部在文件之前
    const firstFile = kinds.indexOf("file");
    assert.ok(firstFile > 0);
    assert.ok(kinds.slice(0, firstFile).every((kind) => kind === "dir"));
    const names = entries.map((entry) => entry.name);
    // 数字序：file9 在 file10 之前（字典序会反过来）
    assert.ok(names.indexOf("file9.txt") < names.indexOf("file10.txt"));
    // 大小写不敏感：B.ts 与 a.ts 同序段（B 不是排在 a 前面的「大写优先」）
    assert.ok(names.indexOf("a.ts") < names.indexOf("B.ts"));
  });

  test("目录条目 size 为 0、文件条目 size 为字节数", () => {
    const { entries } = listDirWithin(root, "docs");
    assert.equal(entries[0]?.kind, "file");
    assert.equal(entries[0]?.size, Buffer.byteLength("# g"));
  });

  test("`..` 逃逸被拒（先于任何 fs 访问）", () => {
    assert.throws(() => listDirWithin(root, ".."), /越界/);
  });

  test("根外绝对路径被拒", () => {
    assert.throws(() => listDirWithin(root, outside), /越界/);
  });

  test("根内 junction 指向根外被拒（realpath 二次校验）", (t) => {
    if (escapePath === "") {
      t.skip(`逃逸链接没建成：${escapeNote}`);
      return;
    }
    assert.throws(() => listDirWithin(root, escapePath), /越界/);
  });

  test("不存在的路径抛可读错误", () => {
    assert.throws(() => listDirWithin(root, "nope"), /ENOENT|不存在/);
  });

  test("目标不是目录抛可读错误", () => {
    assert.throws(() => listDirWithin(root, "README.md"), /不是目录/);
  });
});

describe("listDirWithin：截断如实", () => {
  test("501 条只回 500，truncated = true", () => {
    const { entries, truncated } = listDirWithin(root, "big");
    assert.equal(entries.length, LIST_ENTRY_LIMIT);
    assert.equal(truncated, true);
  });

  test("恰好 500 条不多报截断", () => {
    const { entries, truncated } = listDirWithin(root, "exact");
    assert.equal(entries.length, LIST_ENTRY_LIMIT);
    assert.equal(truncated, false);
  });
});
