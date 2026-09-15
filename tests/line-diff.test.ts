/**
 * 行级 diff（净值那套东西的算法核心）的单测。
 *
 * 判据一律落在**可核对的量**上：增删行数 + patch 里的关键行。
 * 不写死整段 patch 字符串——hunk 上下文的取舍只要满足「能读懂」，不必逐字符钉死。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "../src/shared/line-diff.ts";

describe("diffLines", () => {
  test("两份内容相同 → 没有 patch，也不计增删", () => {
    const diff = diffLines("a\nb\n", "a\nb\n");
    assert.equal(diff.patch, "");
    assert.deepEqual({ added: diff.added, removed: diff.removed }, { added: 0, removed: 0 });
  });

  test("改完又回退（基线与当前一致）→ 净 0，正是「已还原」的判据", () => {
    const base = "line1\nline2\nline3\n";
    // 中间经历过一次增删，但最终内容与基线一致
    const diff = diffLines(base, base);
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
    assert.equal(diff.patch, "");
  });

  test("中间插一行 → 加 1 减 0，hunk 头行号从改动处起算", () => {
    const diff = diffLines("a\nb\nc\n", "a\nb\nX\nc\n", "src/a.ts");
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 0);
    assert.match(diff.patch, /^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n/);
    assert.match(diff.patch, /@@ -1,3 \+1,4 @@/);
    assert.match(diff.patch, /\n\+X\n/);
  });

  test("删一行 → 加 0 减 1", () => {
    const diff = diffLines("a\nb\nc\n", "a\nc\n");
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 1);
    assert.match(diff.patch, /\n-b\n/);
  });

  test("改一行 → 一删一增", () => {
    const diff = diffLines("a\nb\nc\n", "a\nB\nc\n");
    assert.deepEqual({ added: diff.added, removed: diff.removed }, { added: 1, removed: 1 });
  });

  test("新建文件（基线不存在 → 空文本）：整份都是新增，头部从 -0,0 起", () => {
    const diff = diffLines("", "x\ny\n", "new.ts");
    assert.equal(diff.added, 2);
    assert.equal(diff.removed, 0);
    assert.match(diff.patch, /@@ -0,0 \+1,2 @@/);
  });

  test("整份清空（文件被删到 0 行）→ 全部算删除", () => {
    const diff = diffLines("x\ny\n", "");
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 2);
    assert.match(diff.patch, /@@ -1,2 \+0,0 @@/);
  });

  test("末尾少一个换行也算真差异（与 git 观感一致）", () => {
    const diff = diffLines("a\nb\n", "a\nb");
    assert.deepEqual({ added: diff.added, removed: diff.removed }, { added: 1, removed: 1 });
    assert.match(diff.patch, /\\ No newline at end of file/);
  });

  test("相隔很远的改动切成多个 hunk，挨着的并成一个", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `l${index}`);
    const before = `${lines.join("\n")}\n`;

    const far = lines.slice();
    far[2] = "X";
    far[30] = "Y";
    const farDiff = diffLines(before, `${far.join("\n")}\n`);
    assert.equal((farDiff.patch.match(/@@ /g) ?? []).length, 2);

    const near = lines.slice();
    near[2] = "X";
    near[5] = "Y";
    const nearDiff = diffLines(before, `${near.join("\n")}\n`);
    assert.equal((nearDiff.patch.match(/@@ /g) ?? []).length, 1);
  });

  test("大文件里改一行：只报一行增删，不因体量放大", () => {
    const before = `${Array.from({ length: 2000 }, (_, index) => `line ${index}`).join("\n")}\n`;
    const after = before.replace("line 1000\n", "line 1000 改过\n");
    const diff = diffLines(before, after);
    assert.deepEqual({ added: diff.added, removed: diff.removed }, { added: 1, removed: 1 });
    assert.match(diff.patch, /@@ -998,7 \+998,7 @@/);
  });

  test("两份毫无关系的大文件也不丢行（退化情形只影响粒度）", () => {
    const before = Array.from({ length: 2500 }, (_, index) => `a${index}\n`).join("");
    const after = Array.from({ length: 2500 }, (_, index) => `b${index}\n`).join("");
    const diff = diffLines(before, after);
    assert.equal(diff.added, 2500);
    assert.equal(diff.removed, 2500);
  });

  test("增删计数与 patch 正文里的 +/- 行数一致（渲染层按前缀着色）", () => {
    const diff = diffLines("a\nb\nc\nd\n", "a\nX\nc\nY\nZ\n");
    const addedByPrefix = diff.patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removedByPrefix = diff.patch
      .split("\n")
      .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    assert.equal(addedByPrefix, diff.added);
    assert.equal(removedByPrefix, diff.removed);
  });
});
