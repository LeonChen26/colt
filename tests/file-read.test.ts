/**
 * 项目内文件读取的安全边界测试。
 *
 * 这些用例是 A3-2 里最该被测的部分：入参来自渲染层，一旦边界写错，
 * 等于把任意读盘能力交出去。所以逃逸（`../`、绝对路径、链接）逐条钉住，
 * 上限与二进制判定也一并覆盖。
 *
 * 关于「根内链接指向根外」那条：`readFileWithin` 有三重校验，其中第二重
 * （`realpath` 之后再判一次）**只有链接才能触发**——没有它，这条安全不变量
 * 就永远不被验证。所以本文件用**目录联接（junction）**来构造，理由见下面的注释。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { FILE_TEXT_LIMIT, readFileWithin } from "../src/main/file-read.ts";

let root = "";
let outside = "";
/** 指向根外的链接（相对根的路径，喂给 readFileWithin）；空串表示没建出来 */
let escapePath = "";
/** 没建出来时的实况，写进 skip 原因，免得「跳过了」变成一句无从追查的废话 */
let escapeNote = "";

before(() => {
  root = makeTempDir("colt-root-");
  outside = makeTempDir("colt-outside-");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "a.md"), "# 标题\n正文\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  writeFileSync(join(root, "big.txt"), "x".repeat(FILE_TEXT_LIMIT + 1));
  writeFileSync(join(root, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(outside, "secret.txt"), "机密");

  // 造一个「根内的名字 → 根外」的链接。优先**目录联接（junction）**：
  // 它不需要开发者模式或管理员权限，任何用户都能建（POSIX 上等价于普通目录软链接）。
  //
  // 为什么不用文件软链接打头：在 Windows 上建软链接需要开发者模式/管理员权限，而
  // **没权限时 `symlinkSync` 未必抛错**——实测本环境里它返回正常，但 `lstat` 报 ENOENT、
  // 目录里根本没有那个条目（静默不生效）。所以判定「建成了没」**一律以 existsSync 为准**，
  // 不能只看有没有抛异常。
  //
  // junction 指向的是**目录**，故逃逸路径是「escape-dir/secret.txt」：它先从纯字符串
  // 包含性判断里过去（第一重校验放行），再由 `realpath` 解析到根外、被第二重拦下——
  // 这正是这条用例要钉住的那道判定。
  try {
    symlinkSync(outside, join(root, "escape-dir"), "junction");
  } catch (e) {
    escapeNote = `junction: ${(e as NodeJS.ErrnoException).code} ${(e as Error).message}`;
  }
  if (existsSync(join(root, "escape-dir"))) {
    escapePath = "escape-dir/secret.txt";
  } else {
    // 退一步用文件软链接（开发者模式下的 Windows / 类 Unix 一般可行）
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "escape-file.txt"), "file");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      escapeNote += `${escapeNote ? " | " : ""}symlink: ${err.code} ${err.message}`;
    }
    if (existsSync(join(root, "escape-file.txt"))) escapePath = "escape-file.txt";
  }
  if (escapePath === "") {
    escapeNote += `${escapeNote ? " | " : ""}两种都没建成（权限不足？）`;
  }
});

after(() => {
  // 递归删目录（`rmSync`）**不会穿透 junction**（实测：链接目标仍在），故此处安全。
  removeTempDir(root, outside);
});

describe("readFileWithin", () => {
  test("读取根内文本", () => {
    const result = readFileWithin(root, "docs/a.md");
    assert.equal(result.kind, "text");
    assert.match(result.kind === "text" ? result.text : "", /标题/);
  });

  test("反斜杠写法也能读（仅 Windows 的路径习惯）", (t) => {
    if (process.platform !== "win32") {
      t.skip("非 Windows 平台，反斜杠不是分隔符");
      return;
    }
    assert.equal(readFileWithin(root, "docs\\a.md").kind, "text");
  });

  test("拒绝 ../ 逃逸", () => {
    assert.throws(() => readFileWithin(root, "../secret.txt"), /越界/);
  });

  test("拒绝「绕一层再出来」的 ../ 逃逸", () => {
    assert.throws(() => readFileWithin(root, "docs/../../secret.txt"), /越界/);
  });

  test("根内的绝对路径可读（工具入参可能是绝对路径）", () => {
    const result = readFileWithin(root, join(root, "docs", "a.md"));
    assert.equal(result.kind, "text");
    assert.match(result.kind === "text" ? result.text : "", /标题/);
  });

  test("根外的绝对路径被拒，且不碰磁盘（不存在也不报「找不到」）", () => {
    assert.throws(() => readFileWithin(root, join(outside, "secret.txt")), /越界/);
    // 关键：即使该路径不存在，也应报「越界」而非文件系统错误——
    // 证明包含性判断先于任何 fs 访问，不给调用方留下「某路径存不存在」的探测口
    assert.throws(() => readFileWithin(root, join(outside, "nope-does-not-exist.txt")), /越界/);
  });

  test("拒绝目录", () => {
    assert.throws(() => readFileWithin(root, "docs"), /不是文件/);
  });

  test("拒绝不存在的文件", () => {
    assert.throws(() => readFileWithin(root, "nope.txt"));
  });

  test("含 NUL 字节按二进制处理", () => {
    assert.equal(readFileWithin(root, "bin.dat").kind, "binary");
  });

  test("超过文本上限只回「过大」，不做截断", () => {
    const result = readFileWithin(root, "big.txt");
    assert.equal(result.kind, "too-large");
    assert.equal(result.kind === "too-large" ? result.limit : 0, FILE_TEXT_LIMIT);
  });

  test("图片按 dataUrl 返回", () => {
    const result = readFileWithin(root, "dot.png");
    assert.equal(result.kind, "image");
    assert.match(result.kind === "image" ? result.dataUrl : "", /^data:image\/png;base64,/);
  });

  test("根内的链接指向根外时被拒（realpath 之后的第二重判定）", (t) => {
    if (escapePath === "") {
      // 真建不出来才跳过，并把实况写清楚——否则「跳过了」会变成一句无从追查的废话，
      // 而这条守的是安全不变量，长期静默跳过等于这道防线无人验证。
      t.skip(`建不出指向根外的链接，跳过 | ${escapeNote}`);
      return;
    }
    // 先确认第一重（纯字符串包含性）确实**放行**了它——否则这个用例可能只是因为
    // 撞上了 `../` 那类检查才变绿，根本没走到 realpath 那一步，等于空转。
    assert.equal(
      escapePath.includes(".."),
      false,
      "链接名本身不该含 ..，否则测的就不是第二重判定了",
    );
    assert.throws(() => readFileWithin(root, escapePath), /越界/);
  });
});
