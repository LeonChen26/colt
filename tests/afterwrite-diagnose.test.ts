// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 写后诊断（`docs/DESIGN-afterwrite.md`）的单测。
 *
 * 这条链路最危险的两个静默失败，测不到就会变成「看起来在诊断、其实什么都没查」：
 * ① 「检查器坏了」伪装成「检查过了」——execCheck 的三态归一（skipped / problems / clean）
 *    必须可区分，格式化必须把 skipped 写出来（`docs/ERRORS.md` 失败可见原则）；
 * ② 模型可控文本不转义直接进命令——posixQuotePath 是路径进命令的唯一通道，
 *    含引号 / 空格 / 分号的路径必须逐字钉住。
 *
 * 防抖器用假时钟不可能（实现用真 setTimeout），改为小间隔 + 异步等待驱动；
 * 合并去重 / 重排 / dispose 后可复用逐条覆盖。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-agent-core";
import {
  ESLINT_MARKERS,
  fastChecksFor,
  materializeCommand,
  planDiagnose,
  posixQuotePath,
  slowChecksFor,
  slowMarkerFor,
} from "../src/worker/lib/diagnose-config.ts";
import { SlowDiagnoseDebouncer, execCheck, type ExecFn } from "../src/worker/lib/diagnose-run.ts";
import { formatDiagnoseSection, formatSlowNotice } from "../src/worker/lib/diagnose-format.ts";
import { createDiagnoseController } from "../src/worker/lib/diagnose.ts";

const ctx = {} as Context;

describe("diagnose-config", () => {
  test("posixQuotePath：普通路径原样加引号", () => {
    assert.equal(posixQuotePath("E:/code/proj/src/a.ts"), "'E:/code/proj/src/a.ts'");
  });

  test("posixQuotePath：空格 / 引号 / 分号 / 美元符全部字面安全（防 shell 注入）", () => {
    const evil = "a b'c;rm -rf /;$(x)`y`.ts";
    const quoted = posixQuotePath(evil);
    // 单引号串里唯一需要转义的是单引号本身；转义后串内不再有裸单引号终止符
    assert.equal(quoted, `'a b'\\''c;rm -rf /;$(x)\`y\`.ts'`);
    assert.ok(!/\b\d:\s/.test(quoted));
  });

  test("fastChecksFor：TS 系扩展名给 eslint，其它扩展名给空", () => {
    assert.equal(fastChecksFor("/p/a.tsx").length, 1);
    assert.equal(fastChecksFor("/p/a.mts").length, 1);
    assert.deepEqual(fastChecksFor("/p/a.py"), []);
    assert.deepEqual(fastChecksFor("/p/a.md"), []);
    assert.deepEqual(fastChecksFor("/p/a"), []);
  });

  test("slowChecksFor：按扩展名映射全仓检查器", () => {
    assert.equal(slowChecksFor("/p/a.ts")[0]?.label, "tsc");
    assert.equal(slowChecksFor("/p/a.go")[0]?.label, "go vet");
    assert.equal(slowChecksFor("/p/a.rs")[0]?.label, "cargo check");
    assert.deepEqual(slowChecksFor("/p/a.py"), []);
  });

  test("materializeCommand：fast 项替换 {file} 且转义，slow 项原样", () => {
    const fast = fastChecksFor("/p/a.ts")[0]!;
    assert.equal(
      materializeCommand(fast, "/p/my file.ts"),
      "npx eslint --no-warn-ignored '/p/my file.ts'",
    );
    const slow = slowChecksFor("/p/a.ts")[0]!;
    assert.equal(materializeCommand(slow, "/p/a.ts"), "npx tsc --noEmit");
  });

  test("planDiagnose：前置标记缺失的检查器不进计划（没得查 ≠ 跳过）", () => {
    const exists = (marker: string) => ESLINT_MARKERS.includes(marker) && marker === "eslint.config.mjs";
    const plan = planDiagnose("/p/a.ts", exists);
    assert.equal(plan.fast.length, 1); // eslint 标记在
    assert.deepEqual(plan.slow, []); // tsconfig.json 不在
  });

  test("planDiagnose：标记齐全时 fast + slow 都进计划", () => {
    const markers = new Set(["eslint.config.mjs", "tsconfig.json"]);
    const plan = planDiagnose("/p/a.ts", (marker) => markers.has(marker));
    assert.equal(plan.fast.length, 1);
    assert.equal(plan.slow.length, 1);
    assert.equal(plan.slow[0]?.label, "tsc");
  });

  test("slowMarkerFor：每个 slow 检查器都声明了标记（漏声明 = 永远跑不起来）", () => {
    for (const path of ["/p/a.ts", "/p/a.go", "/p/a.rs"]) {
      const check = slowChecksFor(path)[0]!;
      assert.ok(slowMarkerFor(check).length > 0, check.label);
    }
  });
});

describe("execCheck", () => {
  const check = { label: "eslint", kind: "fast" as const, command: "eslint a.ts", timeoutSec: 60 };

  test("非零退出 → problems，输出来自捕获视图", async () => {
    const exec: ExecFn = async (_cmd, opts) => {
      opts.onUpdate?.({ kind: "replace", output: { text: "a.ts:1:1 oops", truncation: {} as never } });
      return { ok: true, value: { exitCode: 1 } };
    };
    const outcome = await execCheck(exec, "/p", ctx, check, check.command);
    assert.equal(outcome.status, "problems");
    assert.equal(outcome.output, "a.ts:1:1 oops");
  });

  test("零退出 → clean（哪怕有输出）", async () => {
    const exec: ExecFn = async (_cmd, opts) => {
      opts.onUpdate?.({ kind: "replace", output: { text: "warning", truncation: {} as never } });
      return { ok: true, value: { exitCode: 0 } };
    };
    const outcome = await execCheck(exec, "/p", ctx, check, check.command);
    assert.equal(outcome.status, "clean");
  });

  test("exec 报错（Result.err）→ skipped，绝不伪装成 clean/problems", async () => {
    const exec: ExecFn = async () => ({ ok: false, error: { message: "shell_unavailable" } });
    const outcome = await execCheck(exec, "/p", ctx, check, check.command);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skippedReason, "shell_unavailable");
  });

  test("exec 抛异常 → skipped（同一归一口径）", async () => {
    const exec: ExecFn = async () => {
      throw new Error("spawn boom");
    };
    const outcome = await execCheck(exec, "/p", ctx, check, check.command);
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.skippedReason, "spawn boom");
  });

  test("cwd / timeout 原样传给 exec", async () => {
    let seen: { cwd?: string; timeout?: number } = {};
    const exec: ExecFn = async (_cmd, opts) => {
      seen = { cwd: opts.cwd, timeout: opts.timeout };
      return { ok: true, value: { exitCode: 0 } };
    };
    await execCheck(exec, "/proj", ctx, { ...check, timeoutSec: 42 }, check.command);
    assert.equal(seen.cwd, "/proj");
    assert.equal(seen.timeout, 42);
  });
});

describe("SlowDiagnoseDebouncer", () => {
  const check = { label: "tsc", kind: "slow" as const, command: "npx tsc --noEmit", timeoutSec: 120 };
  const DEBOUNCE = 25;
  const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  test("窗口内重复 schedule 合并成一批、只跑一次", async () => {
    const ran: string[] = [];
    const debouncer = new SlowDiagnoseDebouncer(
      async (batch) => {
        for (const { check: item } of batch) ran.push(item.label);
      },
      DEBOUNCE,
    );
    debouncer.schedule(check, () => true);
    debouncer.schedule(check, () => true);
    debouncer.schedule(check, () => true);
    await tick(80);
    assert.deepEqual(ran, ["tsc"]);
    debouncer.dispose();
  });

  test("执行中到期 → 记重跑意图，批跑完后补排", async () => {
    const ran: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const debouncer = new SlowDiagnoseDebouncer(
      async (batch) => {
        ran.push(batch.length);
        if (ran.length === 1) {
          // 第一批挂住，模拟全仓检查耗时；期间第二笔写入到期
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
      DEBOUNCE,
    );
    debouncer.schedule(check, () => true);
    await tick(50); // 第一批开跑并挂住
    debouncer.schedule(check, () => true); // 运行中再次 schedule
    await tick(50); // 第二个防抖间隔到期 → 此时第一批应仍在跑
    assert.ok(releaseFirst, "第一批应仍在执行");
    releaseFirst?.();
    await tick(120); // 等补排的第二批跑完
    assert.deepEqual(ran.length, 2, `应有两批，实际 ${JSON.stringify(ran)}`);
    debouncer.dispose();
  });

  test("dispose 丢弃待跑批次；之后仍可复用", async () => {
    const ran: string[] = [];
    const debouncer = new SlowDiagnoseDebouncer(
      async (batch) => {
        for (const { check: item } of batch) ran.push(item.label);
      },
      DEBOUNCE,
    );
    debouncer.schedule(check, () => true);
    debouncer.dispose();
    await tick(80);
    assert.deepEqual(ran, []);
    debouncer.schedule(check, () => true);
    await tick(80);
    assert.deepEqual(ran, ["tsc"]);
    debouncer.dispose();
  });

  test("existsProbe 在执行时刻才判：窗口内标记消失的检查器被跳过", async () => {
    const ran: string[] = [];
    let marker = true;
    const debouncer = new SlowDiagnoseDebouncer(
      async (batch) => {
        for (const { check: item, existsProbe } of batch) {
          if (existsProbe()) ran.push(item.label);
        }
      },
      DEBOUNCE,
    );
    debouncer.schedule(check, () => marker);
    marker = false;
    await tick(80);
    assert.deepEqual(ran, []);
    debouncer.dispose();
  });
});

describe("formatDiagnoseSection / formatSlowNotice", () => {
  test("fast 批：clean 一句话、problems 带输出、skipped 必须可见", () => {
    const text = formatDiagnoseSection([
      { label: "eslint", kind: "fast", status: "clean" },
      { label: "eslint", kind: "fast", status: "problems", output: "a.ts:1:1 oops" },
      { label: "ruff", kind: "fast", status: "skipped", skippedReason: "not installed" },
    ]);
    assert.match(text, /写后诊断/);
    assert.match(text, /eslint（文件级）：通过/);
    assert.match(text, /发现问题/);
    assert.match(text, /a\.ts:1:1 oops/);
    assert.match(text, /跳过：not installed/);
  });

  test("slow 批：全绿不打扰（空串），有问题才成条", () => {
    assert.equal(formatSlowNotice([{ label: "tsc", kind: "slow", status: "clean" }]), "");
    const notice = formatSlowNotice([{ label: "tsc", kind: "slow", status: "problems", output: "E:1 e" }]);
    assert.match(notice, /早些时候的文件写入之后/);
    assert.match(notice, /E:1 e/);
  });

  test("空批次返回空串（不追加无意义的段）", () => {
    assert.equal(formatDiagnoseSection([]), "");
  });
});

describe("createDiagnoseController", () => {
  const SLOW_TICK = 60;

  const make = (
    exec: ExecFn = async () => ({ ok: true, value: { exitCode: 0 } }),
    markers: string[] = ["eslint.config.mjs", "tsconfig.json"],
  ) => {
    const notices: string[] = [];
    const controller = createDiagnoseController({
      cwd: "/proj",
      exec,
      context: ctx,
      onSlowResult: (message) => notices.push(message),
      probe: (marker) => markers.includes(marker),
      debounceMs: 25,
    });
    return { controller, notices };
  };

  const event = (path: string, overrides: Record<string, unknown> = {}) => ({
    toolName: "write",
    isError: false,
    args: { path },
    content: [{ type: "text", text: "written" }] as { type: "text"; text: string }[],
    ...overrides,
  });

  const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  test("非 write/edit / 失败写入 / 无 path：一律不干预", async () => {
    const { controller } = make();
    assert.equal(await controller.handleAfterTool(event("/p/a.ts", { toolName: "bash" })), undefined);
    assert.equal(await controller.handleAfterTool(event("/p/a.ts", { isError: true })), undefined);
    assert.equal(
      await controller.handleAfterTool({ toolName: "write", isError: false, args: {}, content: [] }),
      undefined,
    );
    controller.dispose();
  });

  test("TS 写入 + 标记齐全：fast 结论追加进 content，原内容保留", async () => {
    const { controller } = make();
    const result = await controller.handleAfterTool(event("/proj/src/a.ts"));
    assert.ok(result, "应有追加");
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", "written");
    const last = result.content.at(-1);
    assert.ok(last && last.type === "text", "末位应是追加的文本块");
    const appended = last.type === "text" ? last.text : "";
    assert.match(appended, /写后诊断/);
    assert.match(appended, /eslint（文件级）：通过/);
    controller.dispose();
  });

  test("相对路径按 cwd 展开（与 baseline.ts 同口径）", async () => {
    const seen: string[] = [];
    const { controller } = make(async (cmd) => {
      seen.push(cmd);
      return { ok: true, value: { exitCode: 0 } };
    });
    await controller.handleAfterTool(event("src/a.ts"));
    // Windows 的 resolve 会补盘符（e:/proj/...），断言取引号内去掉盘符的后缀
    assert.ok(seen.some((cmd) => cmd.includes("/proj/src/a.ts'")), seen.join("|"));
    controller.dispose();
  });

  test("无命中检查器的扩展名：不追加、不调度", async () => {
    const { controller } = make();
    assert.equal(await controller.handleAfterTool(event("/proj/notes.md")), undefined);
    controller.dispose();
  });

  test("slow 全仓检查：防抖后执行，有问题经 onSlowResult 上报，全绿不打扰", async () => {
    let exitCode = 0;
    const commands: string[] = [];
    const { controller, notices } = make(
      async (cmd) => {
        commands.push(cmd);
        return { ok: true, value: { exitCode } };
      },
      ["tsconfig.json"],
    );
    // fast 不进计划（无 eslint 标记），slow tsc 进计划
    const result = await controller.handleAfterTool(event("/proj/a.ts"));
    assert.equal(result, undefined, "fast 无命中时不追加");
    await tick(SLOW_TICK);
    assert.deepEqual(commands, ["npx tsc --noEmit"]);
    assert.deepEqual(notices, [], "全绿不打扰");

    exitCode = 1;
    await controller.handleAfterTool(event("/proj/b.ts"));
    await tick(SLOW_TICK + 20);
    assert.equal(notices.length, 1, "有问题必报");
    assert.match(notices[0] ?? "", /tsc（全仓）：发现问题/);
    controller.dispose();
  });

  test("禁用后完全不干预（fast 不追加、slow 不调度）", async () => {
    const commands: string[] = [];
    const { controller } = make(
      async (cmd) => {
        commands.push(cmd);
        return { ok: true, value: { exitCode: 0 } };
      },
      ["eslint.config.mjs", "tsconfig.json"],
    );
    controller.setEnabled(false);
    assert.equal(await controller.handleAfterTool(event("/proj/a.ts")), undefined);
    await tick(SLOW_TICK);
    assert.deepEqual(commands, []);
    controller.dispose();
  });

  test("慢检查器坏了不撒谎：skipped 不报「通过」", async () => {
    const { controller, notices } = make(
      async () => ({ ok: false, error: { message: "shell_unavailable" } }),
      ["tsconfig.json"],
    );
    await controller.handleAfterTool(event("/proj/a.ts"));
    await tick(SLOW_TICK + 20);
    for (const notice of notices) {
      assert.ok(!notice.includes("通过"), notice);
    }
    controller.dispose();
  });
});
