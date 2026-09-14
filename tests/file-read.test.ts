/**
 * 项目内文件读取的安全边界测试。
 *
 * 这些用例是 A3-2 里最该被测的部分：入参来自渲染层，一旦边界写错，
 * 等于把任意读盘能力交出去。所以逃逸（`../`、绝对路径、软链接）逐条钉住，
 * 上限与二进制判定也一并覆盖。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FILE_TEXT_LIMIT, readFileWithin } from "../src/main/file-read.ts";

let root = "";
let outside = "";

before(() => {
  root = mkdtempSync(join(tmpdir(), "banyan-root-"));
  outside = mkdtempSync(join(tmpdir(), "banyan-outside-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "a.md"), "# 标题\n正文\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  writeFileSync(join(root, "big.txt"), "x".repeat(FILE_TEXT_LIMIT + 1));
  writeFileSync(join(root, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(outside, "secret.txt"), "机密");
  try {
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"), "file");
  } catch {
    // Windows 未开开发者模式（或非管理员）时不允许建软链接，相关用例会自行跳过
  }
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
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

  test("根内的软链接指向根外时被拒", (t) => {
    if (!existsSync(join(root, "link.txt"))) {
      t.skip("软链接未能创建（Windows 需要开发者模式或管理员权限）");
      return;
    }
    assert.throws(() => readFileWithin(root, "link.txt"), /越界/);
  });
});
