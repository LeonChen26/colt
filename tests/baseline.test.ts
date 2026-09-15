/**
 * 改动前的内容快照（净值的基线）。
 *
 * 两种「没内容」必须分得开，否则整条净值链路会歪：
 *   - `existed: false`（当时文件不存在）= 新建，净变化是整份新增；
 *   - `text: null`（留不住）= 算不出净值，界面只能说「不知道」。
 * 把前者写成后者，新建文件就永远算不出净值；把后者写成前者，就是在编内容。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BASELINE_TEXT_LIMIT, captureBaseline } from "../src/worker/lib/baseline.ts";

let root = "";

before(() => {
  root = mkdtempSync(join(tmpdir(), "colt-baseline-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "一\n二\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("captureBaseline", () => {
  test("读得到就原样留内容（相对路径按 cwd 展开）", () => {
    assert.deepEqual(captureBaseline(root, "src/a.ts"), { existed: true, text: "一\n二\n" });
  });

  test("绝对路径也认（工具入参常给绝对路径）", () => {
    assert.deepEqual(captureBaseline(root, join(root, "src", "a.ts")), {
      existed: true,
      text: "一\n二\n",
    });
  });

  test("文件当时不存在 → existed:false，而不是「留不住」", () => {
    assert.deepEqual(captureBaseline(root, "src/not-yet.ts"), { existed: false, text: "" });
  });

  test("二进制 → 留不住（text: null），绝不把字节当文本塞进去", () => {
    assert.deepEqual(captureBaseline(root, "bin.dat"), { existed: true, text: null });
  });

  test("超过上限的文件不留内容（留下截断的一份只会让净值算错）", () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(BASELINE_TEXT_LIMIT + 1));
    assert.deepEqual(captureBaseline(root, "big.txt"), { existed: true, text: null });
  });

  test("目录不是文件 → 留不住", () => {
    assert.deepEqual(captureBaseline(root, "src"), { existed: true, text: null });
  });
});
