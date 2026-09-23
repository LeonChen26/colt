/**
 * 终端底座的纯函数测试（terminal-pty.ts）：shell 挑选与 pty 参数组装。
 * 不 spawn 真 PTY——那是冒烟的活（AGENTS.md：单测不依赖真实进程交互）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildPtyOptions, pickShell, SHELL_CANDIDATES } from "../src/main/terminal-pty.ts";

describe("pickShell", () => {
  test("全都有 → 第一个（pwsh 优先）", () => {
    assert.equal(pickShell(() => true), SHELL_CANDIDATES[0]);
  });

  test("都没有 → 回落最后一个（兜底 shell）", () => {
    assert.equal(pickShell(() => false), SHELL_CANDIDATES[SHELL_CANDIDATES.length - 1]);
  });

  test("跳过缺失的：pwsh 没有但 powershell 有 → powershell", () => {
    assert.equal(pickShell((exe) => exe !== SHELL_CANDIDATES[0]), SHELL_CANDIDATES[1]);
  });

  test("只有最后一个有 → 最后一个", () => {
    const last = SHELL_CANDIDATES[SHELL_CANDIDATES.length - 1];
    assert.equal(pickShell((exe) => exe === last), last);
  });

  test("候选清单至少两个且无重复（有得挑、没有空转）", () => {
    assert.ok(SHELL_CANDIDATES.length >= 2);
    assert.equal(new Set(SHELL_CANDIDATES).size, SHELL_CANDIDATES.length);
  });
});

describe("buildPtyOptions", () => {
  test("cols/rows 原样传递（合法值不动）", () => {
    const opts = buildPtyOptions("C:\\proj", 120, 30);
    assert.equal(opts.cols, 120);
    assert.equal(opts.rows, 30);
    assert.equal(opts.cwd, "C:\\proj");
    assert.equal(opts.name, "xterm-256color");
  });

  test("cols/rows 钳到下限 2（FitAddon 在未布局时会给 0）", () => {
    const opts = buildPtyOptions("C:\\proj", 0, -5);
    assert.equal(opts.cols, 2);
    assert.equal(opts.rows, 2);
  });

  test("NaN / Infinity 落到常规默认（80x24）", () => {
    const opts = buildPtyOptions("C:\\proj", Number.NaN, Number.POSITIVE_INFINITY);
    assert.equal(opts.cols, 80);
    assert.equal(opts.rows, 24);
  });

  test("env 带 PATH（漏带它 shell 里连外部命令都跑不了）", () => {
    const opts = buildPtyOptions("C:\\proj", 80, 24);
    assert.ok(typeof opts.env === "object" && opts.env !== null);
    // Windows 上这个变量的字面是混合大小写（Path），按「存在等价键」判而不是字面
    const keys = Object.keys(opts.env as Record<string, string>).map((k) => k.toLowerCase());
    assert.ok(keys.includes("path"));
  });
});
