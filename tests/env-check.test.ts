/**
 * 环境体检（bash 查找 + 报告口径）的测试。
 *
 * 这一层只回答一个问题：「agent 的 bash 工具到底能不能跑」。答错的两个方向都伤人——
 * 报「找不到」会让用户白装一遍 Git；报「找到了」而那个路径其实不存在，则是让 agent
 * 每次调用都失败，而界面上环境一切正常。
 *
 * 所以这里钉的是**顺序**与**「报出来的路径必须真的存在」**这两条，
 * 不钉「本机装没装 Git」（那是机器差异，写进断言就是必然为假的假阴性）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { resolveBash, runEnvCheck } from "../src/main/env-check.ts";

describe("resolveBash", () => {
  test("自定义 shellPath 存在 → 优先用它，来源标成 custom", async () => {
    const dir = makeTempDir("colt-envcheck-");
    try {
      const custom = join(dir, "my-bash");
      writeFileSync(custom, "", "utf8");
      assert.deepEqual(await resolveBash(custom), { path: custom, source: "custom" });
    } finally {
      removeTempDir(dir);
    }
  });

  test("自定义 shellPath 不存在 → 绝不把它当成找到了", async () => {
    const dir = makeTempDir("colt-envcheck-");
    try {
      const missing = join(dir, "no-such-bash");
      const result = await resolveBash(missing);
      // 只断言「没有谎报」。其余分支取决于本机装没装 Git，不进断言。
      assert.notEqual(result?.path, missing, "不存在的路径不能被当成找到了");
      assert.ok(result === undefined || result.source !== "custom", "来源不该标成 custom");
    } finally {
      removeTempDir(dir);
    }
  });

  test("不给自定义路径 → 来源只可能是 git / path；报出来的路径必须真实存在", async () => {
    const result = await resolveBash();
    assert.ok(
      result === undefined || result.source === "git" || result.source === "path",
      `未知来源：${JSON.stringify(result)}`,
    );
    if (result !== undefined) {
      assert.equal(existsSync(result.path), true, `报了一个不存在的路径：${result.path}`);
    }
  });
});

describe("runEnvCheck", () => {
  test("系统信息取自 process，不是空串", async () => {
    const report = await runEnvCheck();
    assert.equal(report.platform, process.platform);
    assert.equal(report.arch, process.arch);
    assert.equal(report.node, process.versions.node);
    assert.notEqual(report.node, "");
  });

  test("ok 与 problems 必须一致：否则界面会「显示环境正常，下面却列着一堆问题」", async () => {
    const report = await runEnvCheck();
    assert.equal(report.ok, report.problems.length === 0);
  });

  test("bashPath 与 bashSource 同生共死：界面按 source 显示来源，缺一个就是空标签", async () => {
    const report = await runEnvCheck();
    assert.equal(report.bashPath === undefined, report.bashSource === undefined);
  });

  test("找不到 bash 时，问题文案要给出可动作的下一步（装 Git 或去设置里指定）", async () => {
    const report = await runEnvCheck();
    if (report.bashPath !== undefined) return; // 本机有 bash，这条不适用
    const problem = report.problems.find((item) => item.includes("bash"));
    assert.ok(problem, `应有一条讲 bash 的问题，实际：${JSON.stringify(report.problems)}`);
    assert.match(problem, /Git for Windows|shellPath/);
  });
});
