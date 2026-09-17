/**
 * 净变化（基线 → 现在）的测试。
 *
 * 这块最容易出的错不是崩，而是**悄悄说反**：把「算不出」当成「净 0」，用户就会看到
 * 「已还原」而文件其实改了。所以三种结论——有差异 / 无差异 / 算不出——逐条钉住，
 * 且「算不出」的两种成因（没有基线 / 读不到）分别断言，不合并成一句。
 *
 * 每个用例一棵新树（`beforeEach`）：净变化的输入是「盘上现在的内容」，共用一棵树会让
 * 用例之间靠文件内容互相影响——上一例改了 `a.ts`，下一例就得先写回基线内容才能得到
 * 要断言的结果。这种依赖一被重排、被单独运行或被 `--test-name-pattern` 挑着跑就静默失准。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { computeNetChange } from "../src/main/net-change.ts";
import type { FileBaseline } from "@shared/worker-protocol";

const baselineOf = (text: string | null, existed = true): FileBaseline => ({ existed, text });

describe("computeNetChange", () => {
  let root = "";
  let outside = "";

  beforeEach(() => {
    root = makeTempDir("colt-net-root-");
    outside = makeTempDir("colt-net-outside-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "一\n二\n三\n");
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(join(outside, "secret.txt"), "机密\n");
  });

  afterEach(() => {
    removeTempDir(root, outside);
  });

  test("改过就报净差异（基线 → 当前），patch 头标明是「改前 / 现在」", () => {
    writeFileSync(join(root, "src", "a.ts"), "一\n改过的二\n三\n");
    const result = computeNetChange(root, "src/a.ts", baselineOf("一\n二\n三\n"));
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.added : -1, 1);
    assert.equal(result.status === "ok" ? result.removed : -1, 1);
    assert.match(result.status === "ok" ? result.patch : "", /--- a\/src\/a\.ts/);
  });

  test("改完又退回原样 → 净 0（有结论的 0，不是「算不出」）", () => {
    // 树是每例新建的，`a.ts` 此刻就等于基线内容；「改了几次最后又改回来」由基线表达
    const result = computeNetChange(root, "src/a.ts", baselineOf("一\n二\n三\n"));
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

  test("当前文件读不到（已删除）→ unreadable，且原因点名是哪个文件读不到", () => {
    const result = computeNetChange(root, "src/gone.ts", baselineOf("旧内容\n"));
    assert.equal(result.status, "unreadable");
    const reason = result.status === "unreadable" ? result.reason : "";
    assert.match(reason, /ENOENT/);
    assert.match(reason, /gone\.ts/, "原因要说得出是哪个文件");
  });

  test("当前文件是二进制 → unreadable（不按文本瞎比）", () => {
    const result = computeNetChange(root, "bin.dat", baselineOf("旧内容\n"));
    assert.equal(result.status, "unreadable");
    assert.match(result.status === "unreadable" ? result.reason : "", /二进制/);
  });

  test("根外绝对路径与相对 `../` 逃逸：两种形态都拒，且根一换就读得到（证明是边界判的）", () => {
    const secretAbs = join(outside, "secret.txt");
    // 先证明目标**真的存在**。少了这一条断言，「越界」两个字的通过可能只是
    // 「那个文件本来就不存在」的副产品——用例会绿，但它管的事一件没验。
    assert.equal(existsSync(secretAbs), true);

    const escaped = [
      secretAbs, // 根外的绝对路径（模型给工具入参时常这样）
      join("..", basename(outside), "secret.txt"), // 相对 `../` 逃逸，指向同一个真实文件
    ];
    for (const path of escaped) {
      const result = computeNetChange(root, path, baselineOf("旧\n"));
      assert.equal(result.status, "unreadable", `未被拒绝：${path}`);
      assert.match(result.status === "unreadable" ? result.reason : "", /越界/, path);
    }

    // 正向对照：同一个文件、只把根换成它自己所在的目录，就读得到。
    // 有了它，上面两句才算落在**边界判定**上——否则「unreadable」也可能来自
    // 「这路径根本读不了」（写错名字、编码、权限），而那与越界无关。
    const inside = computeNetChange(outside, "secret.txt", baselineOf("旧\n"));
    assert.equal(inside.status, "ok");
  });
});
