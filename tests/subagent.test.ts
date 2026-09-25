// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `subagent.ts` 的**纯逻辑面**：lane 名判据、标题、错误文案。
 *
 * 为什么这几个要用例钉住：`isSubagentLane` 是**安全边界**——`subagentAbort` 与完整流
 * 复活都靠它把主对话（`main`）和记忆整理（TIDY_LANE）挡在外面（契约明写「不动主对话」）。
 * 它只有一行字符串比较，删掉或写错不会有别的东西变红；标题截断同理（schema 里承诺
 * ≤60 字符，不截就是撒谎，而界面上只会表现为「那一行被撑爆」，不报错）。
 *
 * 执行侧（真的开 lane、跑模型、并发上限）不在这里——见 `docs/DESIGN-subagents.md` §10。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TITLE_CHARS,
  agentNameFromLane,
  buildResultText,
  collectReceipt,
  deriveTitle,
  describeSubagentError,
  isSubagentLane,
  isSubagentTool,
  truncateTitle,
} from "../src/worker/lib/subagent";

describe("lane 名判据（安全边界）", () => {
  test("只有 `sub:` 前缀算子代理 lane", () => {
    assert.equal(isSubagentLane("sub:researcher:abcd1234"), true);
    assert.equal(isSubagentLane("main"), false);
    assert.equal(isSubagentLane("tidy"), false);
    assert.equal(isSubagentLane(""), false);
    // 只写前缀、没有冒号的近似名不算——否则「sub」这种名字会变成合法目标
    assert.equal(isSubagentLane("sub"), false);
  });

  test("工具名判据整串相等，不做前缀匹配", () => {
    assert.equal(isSubagentTool("subagent"), true);
    // 前缀匹配会让未来的 `subagents` / `subagent_x` 静默走错分支
    assert.equal(isSubagentTool("subagents"), false);
    assert.equal(isSubagentTool("subagent_x"), false);
    assert.equal(isSubagentTool("read"), false);
  });

  test("从 lane 名解析定义名（重启后注册表为空，只能靠名字）", () => {
    assert.equal(agentNameFromLane("sub:researcher:abcd1234"), "researcher");
    assert.equal(agentNameFromLane("sub:general:12345678"), "general");
    // 还没拼上 shortId 时也能解析（建 lane 名与解析必须同源同格式）
    assert.equal(agentNameFromLane("sub:researcher"), "researcher");
  });

  test("非子代理 lane / 只有前缀 → null（调用方据此拒绝）", () => {
    assert.equal(agentNameFromLane("main"), null);
    assert.equal(agentNameFromLane("tidy"), null);
    assert.equal(agentNameFromLane("sub:"), null);
  });
});

describe("标题截断（schema 承诺 ≤60，就必须真截）", () => {
  test("未超限原样返回", () => {
    assert.equal(truncateTitle("查一下 read 工具在哪注册"), "查一下 read 工具在哪注册");
    assert.equal(truncateTitle(""), "");
  });

  test("超限截到上限 + 省略号（不是只截不标）", () => {
    const long = "x".repeat(MAX_TITLE_CHARS + 20);
    const out = truncateTitle(long);
    assert.equal(out.length, MAX_TITLE_CHARS + 1);
    assert.equal(out.endsWith("…"), true);
  });

  test("deriveTitle：取首个非空行；全空回落到定义名", () => {
    assert.equal(deriveTitle("\n\n  第一行\n第二行", "researcher"), "第一行");
    assert.equal(deriveTitle("   \n\t", "researcher"), "researcher");
  });

  test("deriveTitle 也走同一道截断（两个入口不能一个截一个不截）", () => {
    const long = "y".repeat(MAX_TITLE_CHARS + 5);
    assert.equal(deriveTitle(long, "researcher"), truncateTitle(long));
  });
});

describe("失败文案（每种状态都要说得清）", () => {
  test("内核的三种 TaggedError 各有一句话", () => {
    assert.match(describeSubagentError({ _tag: "LaneBusy" }), /还在忙/);
    assert.match(describeSubagentError({ _tag: "Closed" }), /会话已关闭/);
    assert.match(describeSubagentError({ _tag: "InvalidMessage" }), /不合法/);
  });

  test("未知失败带上原因，而不是一句「失败了」", () => {
    assert.match(describeSubagentError(new Error("连接超时")), /连接超时/);
  });
});

/**
 * 收据是**回给模型**的（`buildResultText` → 工具结果），模型靠它判断要不要再核一遍。
 *
 * 曾经只认 `edit` / `write` 两个名字：子代理用 `bash`（或经 MCP 工具）改了一圈之后，
 * 收据仍写「没有改动文件」——那是谎报。现在拆成两种口径：**能确定**的文件名，与
 * **可能写盘但推不出名字**的调用次数。
 */
describe("收据的诚实口径", () => {
  const step = (content: unknown[]): unknown => ({
    type: "message",
    message: { role: "assistant", content },
  });

  test("edit / write 带 path → 进「确定改动的文件」", () => {
    const receipt = collectReceipt([
      step([{ type: "toolCall", name: "write", arguments: { path: "a.txt" } }]),
    ]);
    assert.deepEqual([...receipt.changedFiles], ["a.txt"]);
    assert.deepEqual(receipt.opaqueCalls, []);
  });

  test("bash / MCP 这类推不出文件名的调用 → 计入「可能写盘」，不被漏成「没动过」", () => {
    const receipt = collectReceipt([
      step([{ type: "toolCall", name: "bash", arguments: { command: "echo x > a.txt" } }]),
      step([{ type: "toolCall", name: "mcp__fs__write", arguments: { p: "b.txt" } }]),
    ]);
    assert.equal(receipt.changedFiles.size, 0);
    assert.deepEqual(receipt.opaqueCalls, [
      { name: "bash", count: 1 },
      { name: "mcp__fs__write", count: 1 },
    ]);
  });

  test("只读工具与提问、委派都不入「可能写盘」（真源 READONLY_TOOLS）", () => {
    const receipt = collectReceipt([
      step([
        { type: "toolCall", name: "read", arguments: { path: "a" } },
        { type: "toolCall", name: "todo", arguments: {} },
        { type: "toolCall", name: "ask_user", arguments: {} },
        { type: "toolCall", name: "subagent", arguments: {} },
      ]),
    ]);
    assert.deepEqual(receipt.opaqueCalls, []);
  });

  test("收据文本把两件事都说出来（确定的改动 + 可能写盘的）", () => {
    const receipt = collectReceipt([
      step([
        { type: "toolCall", name: "write", arguments: { path: "a.txt" } },
        { type: "toolCall", name: "bash", arguments: { command: "rm b" } },
      ]),
    ]);
    const text = buildResultText({ name: "demo", status: "completed", timedOut: false }, receipt);
    assert.match(text, /改动了 1 个文件：a\.txt/);
    assert.match(text, /另有 bash×1/);
    assert.match(text, /可能也写了盘/);
  });

  test("中止时带上原因（中止未生效 ≠ 普通超时）", () => {
    const text = buildResultText(
      { name: "demo", status: "aborted", error: "中止未生效", timedOut: true },
      collectReceipt([]),
    );
    assert.match(text, /超过时间上限：中止未生效/);
    assert.match(text, /不完整/);
  });
});

/**
 * 到时间上限、改由「总结交接」收尾时，结果文本必须**改写口径**：
 * 一句「已完成」会让调用方把半途的交接当成交付物——那是「持续撒谎」（`ERRORS.md`）。
 */
describe("交接收尾的口径", () => {
  test("completed + handedOff：报「到上限后收笔」并提醒任务不一定做完", () => {
    const text = buildResultText(
      { name: "demo", status: "completed", timedOut: false, handedOff: true },
      collectReceipt([]),
    );
    assert.match(text, /时间上限后收笔/);
    assert.match(text, /总结交接/);
    assert.match(text, /不一定.{0,4}做完/);
    assert.doesNotMatch(text, /已完成/, "报成「已完成」就是让调用方把交接当交付物");
  });

  test("completed 但没有交接（正常跑完）：仍然报「已完成」", () => {
    const text = buildResultText(
      { name: "demo", status: "completed", timedOut: false },
      collectReceipt([]),
    );
    assert.match(text, /已完成/);
    assert.doesNotMatch(text, /总结交接/);
  });

  test("aborted + timedOut + handedOff：说清是「要了交接但没写完」", () => {
    const text = buildResultText(
      { name: "demo", status: "aborted", timedOut: true, handedOff: true },
      collectReceipt([]),
    );
    assert.match(text, /要了交接但没写完/);
    assert.match(text, /不完整/);
  });
});
