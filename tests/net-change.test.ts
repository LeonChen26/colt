/**
 * 净变化（基线 → 现在）的测试。
 *
 * 这块最容易出的错不是崩，而是**悄悄说反**：把「算不出」当成「净 0」，用户就会看到
 * 「已还原」而文件其实改了。所以三种结论——有差异 / 无差异 / 算不出——逐条钉住，
 * 且「算不出」的两种成因（没有基线 / 读不到）分别断言，不合并成一句。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeNetChange } from "../src/main/net-change.ts";
import type { FileBaseline } from "@shared/worker-protocol";

let root = "";
let outside = "";

before(() => {
  root = mkdtempSync(join(tmpdir(), "colt-net-root-"));
  outside = mkdtempSync(join(tmpdir(), "colt-net-outside-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "一\n二\n三\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  writeFileSync(join(outside, "secret.txt"), "机密\n");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const baselineOf = (text: string | null, existed = true): FileBaseline => ({ existed, text });

describe("computeNetChange", () => {
  test("改过就报净差异（基线 → 当前），patch 头标明是「改前 / 现在」", () => {
    writeFileSync(join(root, "src", "a.ts"), "一\n改过的二\n三\n");
    const result = computeNetChange(root, "src/a.ts", baselineOf("一\n二\n三\n"));
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.added : -1, 1);
    assert.equal(result.status === "ok" ? result.removed : -1, 1);
    assert.match(result.status === "ok" ? result.patch : "", /--- a\/src\/a\.ts/);
  });

  test("改完又退回原样 → 净 0（有结论的 0，不是「算不出」）", () => {
    const text = "一\n二\n三\n";
    // 上一例把文件改坏了，这里先退回基线内容，模拟「改了几次最后又改回来」
    writeFileSync(join(root, "src", "a.ts"), text);
    const result = computeNetChange(root, "src/a.ts", baselineOf(text));
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.added : -1, 0);
    assert.equal(result.status === "ok" ? result.removed : -1, 0);
    assert.equal(result.status === "ok" ? result.patch : "非 ok", "");
  });

  test("基线里文件不存在（新建）→ 整份算新增", () => {
    writeFileSync(join(root, "src", "new.ts"), "x\ny\n");
    const result = computeNetChange(root, "src/new.ts", baselineOf("", false));
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.added : -1, 2);
    assert.equal(result.status === "ok" ? result.removed : -1, 0);
  });

  test("没有基线 → no-baseline，绝不退化成 0", () => {
    const result = computeNetChange(root, "src/a.ts", undefined);
    assert.equal(result.status, "no-baseline");
    assert.match(result.status === "no-baseline" ? result.reason : "", /未记录改动前的内容/);
  });

  test("基线在但内容没留住（过大 / 二进制）→ 同样是 no-baseline", () => {
    const result = computeNetChange(root, "src/a.ts", baselineOf(null));
    assert.equal(result.status, "no-baseline");
  });

  test("当前文件读不到（已删除）→ unreadable，且给出可读原因", () => {
    const result = computeNetChange(root, "src/gone.ts", baselineOf("旧内容\n"));
    assert.equal(result.status, "unreadable");
    assert.ok((result.status === "unreadable" ? result.reason : "").length > 0);
  });

  test("当前文件是二进制 → unreadable（不按文本瞎比）", () => {
    const result = computeNetChange(root, "bin.dat", baselineOf("旧内容\n"));
    assert.equal(result.status, "unreadable");
    assert.match(result.status === "unreadable" ? result.reason : "", /二进制/);
  });

  test("越界路径被拒（根只由主进程给，路径必须落在根内）", () => {
    const result = computeNetChange(root, join("..", "colt-net-outside", "secret.txt"), baselineOf("旧\n"));
    assert.equal(result.status, "unreadable");
    assert.match(result.status === "unreadable" ? result.reason : "", /越界/);
  });
});
