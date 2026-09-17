/**
 * 路径越界判定的测试——重点是**软链接逃逸**与「目标尚未创建」这两种情形。
 *
 * 这两者容易互相顶掉，是这个判定唯一的难点：
 *   · 目标还不存在（写入新文件、路径里的目录还没建）时对它 `realpath` 会抛 ENOENT，
 *     那不是越界。若图省事「解析失败就放行」，软链接防线等于没写；
 *     若一律拒绝，正常的新建文件会被当成越界（本轮真的这样红过一次）。
 *   · 根内的软链接指向根外时，目标在**字符串上**位于根内——只看字符串永远发现不了。
 *
 * 所以这两类各有用例钉住，且**都不许跳过**：它们守的是安全不变量，
 * 跳过就等价于「这条防线在我的机器上从未被验证」（`AGENTS.md` 记过这个代价）。
 * 链接构造方式与 `file-read.test.ts` 一致：优先 junction，判定「建成了没」
 * **一律以 `existsSync` 为准**——Windows 上没权限时 `symlinkSync` 未必抛错，
 * 只是静默不生效。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { isWithinRoot, isWithinRootReal } from "../src/main/lib/path-guard.ts";

let root = "";
let outside = "";

function linkEscapeDir(): string {
  const target = join(root, "escape-dir");
  try {
    symlinkSync(outside, target, "junction");
  } catch {
    /* 落到下面的 existsSync 判定 */
  }
  if (existsSync(target)) return target;
  throw new Error(
    "建不出指向根外的链接（junction 与文件软链接都不可用），本文件的逃逸用例无法成立。" +
      "Windows 需要开发者模式或管理员权限；请修环境而不是跳过这些用例——它们守的是安全不变量。",
  );
}

before(() => {
  root = makeTempDir("colt-guard-root-");
  outside = makeTempDir("colt-guard-outside-");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "a.md"), "内容");
  writeFileSync(join(outside, "secret.txt"), "机密");
  linkEscapeDir();
});

after(() => {
  removeTempDir(root, outside);
});

describe("isWithinRoot（纯字符串，不碰磁盘）", () => {
  test("根内 / 根自身", () => {
    assert.equal(isWithinRoot("E:/proj", "E:/proj"), true);
    assert.equal(isWithinRoot("E:/proj", "E:/proj/a.ts"), true);
    assert.equal(isWithinRoot("E:/proj/", "E:/proj/a.ts"), true);
  });

  test("相对路径按根展开后判定", () => {
    assert.equal(isWithinRoot("E:/proj", "src/a.ts"), true);
    assert.equal(isWithinRoot("E:/proj", "sub/../a.ts"), true);
    assert.equal(isWithinRoot("E:/proj", "../outside/a.ts"), false);
    assert.equal(isWithinRoot("E:/proj", ".."), false);
  });

  test("前缀相同的兄弟目录不算根内", () => {
    assert.equal(isWithinRoot("E:/proj", "E:/proj-evil/a.ts"), false);
    assert.equal(isWithinRoot("/srv/app", "/srv/application/a.ts"), false);
  });

  test("跨盘 / 跨根视为越界", () => {
    assert.equal(isWithinRoot("E:/proj", "C:/Windows/system32/a.dll"), false);
    assert.equal(isWithinRoot("/srv/app", "C:/srv/app/a.ts"), false);
  });
});

describe("isWithinRootReal（解真实路径）", () => {
  test("根内已存在的文件放行", () => {
    assert.equal(isWithinRootReal(root, join(root, "docs", "a.md")), true);
    assert.equal(isWithinRootReal(root, "docs/a.md"), true);
  });

  test("尚未创建的目标不算越界（正常的新建写入）", () => {
    // 父目录存在、文件不存在
    assert.equal(isWithinRootReal(root, join(root, "docs", "new.md")), true);
    // 连父目录都还没建——逐级向上会解到根，不能因此判成越界
    assert.equal(isWithinRootReal(root, join(root, "brand/new/dir/file.md")), true);
  });

  test("根外的绝对路径与 .. 逃逸一律拒绝", () => {
    assert.equal(isWithinRootReal(root, join(outside, "secret.txt")), false);
    assert.equal(isWithinRootReal(root, join(root, "..", "secret.txt")), false);
  });

  test("根内链接指向根外：目标已存在时拒绝", () => {
    assert.equal(isWithinRootReal(root, join(root, "escape-dir", "secret.txt")), false);
  });

  test("根内链接指向根外：目标尚不存在时同样拒绝", () => {
    // 与「尚未创建」的区别就在这里：已存在的那一段（junction 本身）
    // 在字符串上位于根内，却解析到根外——这是逃逸，不是「目录还没建」。
    assert.equal(isWithinRootReal(root, join(root, "escape-dir", "not-created-yet.txt")), false);
  });

  test("根本身不存在时仍按字符串判定（不因解析失败而放行根外）", () => {
    const missingRoot = join(root, "no-such-root");
    assert.equal(isWithinRootReal(missingRoot, join(missingRoot, "a.ts")), true);
    assert.equal(isWithinRootReal(missingRoot, join(outside, "secret.txt")), false);
  });
});
