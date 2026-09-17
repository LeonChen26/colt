/**
 * 记忆整理（/memory-tidy）的 lib 层：失败文案、系统提示词、工具白名单。
 *
 * 失败文案与 compact-error 同源同款——内核 `lane.prompt()` 的失败走 `Result.err`
 * 而不是抛异常，不查返回值就是「敲了 /memory-tidy 没反应」。全部形态都必须
 * 给出可读说明。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TIDY_LANE,
  TIDY_TOOLS,
  describeTidyError,
  describeTidyOutcome,
  memoryTidySystemPrompt,
} from "../src/worker/lib/memory-tidy.ts";
import { memoryFilePath } from "../src/worker/lib/memory.ts";
import { READONLY_TOOLS } from "../src/shared/readonly-tools.ts";

describe("describeTidyError", () => {
  test("accept 阶段的拒绝按 _tag 给出可读说明", () => {
    assert.equal(
      describeTidyError({ _tag: "LaneBusy", message: "busy" }),
      "上一次记忆整理还在进行中，请等它完成。",
    );
    assert.equal(describeTidyError({ _tag: "Closed", message: "closed" }), "会话已关闭，无法整理记忆。");
  });

  test("未知形态（含非 Error 值）也不抛，原样带出", () => {
    assert.equal(describeTidyError("boom"), "记忆整理未能启动：boom");
    assert.equal(describeTidyError(undefined), "记忆整理未能启动：undefined");
    assert.equal(
      describeTidyError({ message: "model unavailable" }),
      "记忆整理未能启动：model unavailable",
    );
  });
});

describe("describeTidyOutcome", () => {
  test("中止单独说明（status 或 error.code 都算）；失败带出底层原因", () => {
    assert.equal(describeTidyOutcome({ status: "aborted" }), "记忆整理已中止。");
    assert.equal(
      describeTidyOutcome({ status: "failed", error: { code: "aborted", message: "aborted" } }),
      "记忆整理已中止。",
    );
    assert.equal(
      describeTidyOutcome({
        status: "failed",
        error: { code: "model_error", message: "401 unauthorized" },
      }),
      "记忆整理失败：401 unauthorized",
    );
  });

  test("declined 与无 error 的失败也有可读兜底，不出现 [object Object]", () => {
    assert.equal(describeTidyOutcome({ status: "declined" }), "记忆整理未执行。");
    assert.equal(describeTidyOutcome({ status: "failed" }), "记忆整理失败：原因未知。");
  });
});

describe("memoryTidySystemPrompt（整理 lane 的最终产物本身要断言下来）", () => {
  test("带出记忆文件的绝对路径、只许改这一个文件、报告要求", () => {
    const prompt = memoryTidySystemPrompt("/proj");
    assert.ok(prompt.includes(memoryFilePath("/proj")), prompt);
    // 软约束与硬边界（setActiveTools）叠加：提示词里必须自己说清改动范围
    assert.ok(prompt.includes("只允许改这一个文件"), prompt);
    // 提示词要给出可执行的结算要求：合并/删除/保留的数量，没有改动也要说明
    assert.ok(prompt.includes("合并几条"), prompt);
    assert.ok(prompt.includes("用 write 工具"), prompt);
  });
});

describe("TIDY_TOOLS（安全边界，钉死）", () => {
  test("整理只拿 read / write / memory_search：写文件走审批，其余都在只读白名单里", () => {
    // 钉死精确集合：整理的硬边界就是这三个，多一个都是越权面——
    // 将来要调整必须是有意识的改动，不能是顺手加的
    assert.deepEqual([...TIDY_TOOLS], ["read", "write", "memory_search"]);
    for (const name of TIDY_TOOLS) {
      if (name === "write") {
        // write 不在只读白名单 → 走审批闸门（HookRegistry 共享，子 lane 不豁免）
        assert.ok(!READONLY_TOOLS.has(name));
      } else {
        assert.ok(READONLY_TOOLS.has(name), `${name} 应在 READONLY_TOOLS 里`);
      }
    }
    // lane 名是持久化身份（恢复、事件过滤都按它），改名等于丢历史
    assert.equal(TIDY_LANE, "memory-tidy");
  });
});
