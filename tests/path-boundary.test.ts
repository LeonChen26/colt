/**
 * 越界判据（`@shared/path-boundary`）的钉子。
 *
 * 这条判据此前在**四处各写了一遍**，而且都写成 `rel.startsWith("..")`——
 * 那个写法把合法的 `..foo` 误判成越界。它不是「不够严」，是**误报**：
 * 同一个名字在不同层级结论相反（`..foo` 被拒、`src/..foo` 放行），
 * 而且不报错、不崩，只是某天某个文件突然用不了。
 *
 * 所以这里钉两件事：① 判据本身按**路径段**看；② 两个真实用家
 * （worker 的 `resolveInRoot`、主进程的 `isWithinRoot`）都**真的用了它**——
 * 各写各的时候，改了一处另一处不会有任何征兆。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { escapesRoot } from "@shared/path-boundary";
import { isWithinRoot } from "../src/main/lib/path-guard.ts";
import { resolveInRoot } from "../src/worker/lib/search-tools.ts";

describe("escapesRoot：按路径段判，不看前缀", () => {
  test("根自身与普通相对路径都算「在根内」", () => {
    for (const rel of ["", "a.ts", "src/a.ts", "src/deep/a.ts", "...", "..foo", "a/..foo"]) {
      assert.equal(escapesRoot(rel), false, `${JSON.stringify(rel)} 不该被判成越界`);
    }
  });

  test("`..` 作为**整段**或以 `../` 开头才算逃出", () => {
    for (const rel of ["..", "../a", "../../a", "a/../..", "a/../../b"]) {
      assert.equal(escapesRoot(rel), true, `${JSON.stringify(rel)} 该被判成越界`);
    }
  });

  test("绝对路径算逃出（跨盘时 `relative` 会直接返回绝对路径）", () => {
    // `/etc/passwd` 在两种平台都算绝对（Windows 把前导 `/` 视为「当前盘根」）
    assert.equal(escapesRoot("/etc/passwd"), true);
    if (process.platform === "win32") {
      // 盘符只在 Windows 上是绝对路径；POSIX 上 `D:/x` 就是个带冒号的**相对**名字，
      // 判成「没逃出」才是对的（那种名字由调用方按「含 `:` 非法」单独拒掉）。
      assert.equal(escapesRoot("C:/other/a.ts"), true);
      assert.equal(escapesRoot("D:/x"), true);
    } else {
      assert.equal(escapesRoot("D:/x"), false);
    }
  });

  test("Windows 的反斜杠也认（`relative()` 在 Windows 上给的就是它）", () => {
    assert.equal(escapesRoot("..\\a"), true);
    assert.equal(escapesRoot("..\\..\\a"), true);
    assert.equal(escapesRoot("..foo\\a"), false);
  });
});

describe("两个用家都走同一份判据", () => {
  const ROOT = process.platform === "win32" ? "C:/proj" : "/proj";

  test("worker 侧：`..foo` 放行、`../foo` 拒绝", () => {
    assert.equal(resolveInRoot(ROOT, "..foo").ok, true);
    assert.equal(resolveInRoot(ROOT, "src/..foo").ok, true);
    assert.equal(resolveInRoot(ROOT, "../foo").ok, false);
    assert.equal(resolveInRoot(ROOT, "..").ok, false);
  });

  test("主进程侧（审批闸门用的那个）：同一个名字给出**同一个**结论", () => {
    assert.equal(isWithinRoot(ROOT, `${ROOT}/..foo`), true);
    assert.equal(isWithinRoot(ROOT, `${ROOT}/src/..foo`), true);
    assert.equal(isWithinRoot(ROOT, `${ROOT}/../foo`), false);
  });
});
