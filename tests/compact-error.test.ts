/**
 * 压缩失败原因的翻译（`describeCompactError`）。
 * 内核压缩失败走 `Result.err` 而不是抛异常：accept 阶段的拒绝带 `_tag`
 * （TaggedError），摘要请求失败是 `CompactionError`（带 `code`）。
 * 全部形态都必须给出可读说明——否则用户点压缩就是「点了没反应」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  describeCompactError,
  describeCompactOutcome,
} from "../src/worker/lib/compact-error.ts";

describe("describeCompactError", () => {
  test("accept 阶段的拒绝按 _tag 给出可读说明", () => {
    assert.equal(
      describeCompactError({ _tag: "NothingToCompact", message: 'Lane "main" has nothing to compact' }),
      "没有可压缩的内容：会话还没有消息，或刚压缩过还没有新对话。",
    );
    assert.equal(
      describeCompactError({ _tag: "LaneBusy", message: "busy" }),
      "当前有正在进行的任务，无法压缩：请等它结束，或先停止当前任务。",
    );
    assert.equal(
      describeCompactError({ _tag: "Closed", message: "closed" }),
      "会话已关闭，无法压缩。",
    );
  });

  test("摘要请求失败（CompactionError）带出底层原因；中止单独说明", () => {
    assert.equal(
      describeCompactError({ code: "summarization_failed", message: "Summarization failed: net::ERR_" }),
      "压缩上下文失败：Summarization failed: net::ERR_",
    );
    assert.equal(describeCompactError({ code: "aborted", message: "aborted" }), "压缩已中止。");
  });

  test("未知形态（含非 Error 值）也不抛，原样带出", () => {
    assert.equal(describeCompactError("boom"), "压缩上下文失败：boom");
    assert.equal(describeCompactError(undefined), "压缩上下文失败：undefined");
  });
});

describe("describeCompactOutcome", () => {
  test("中止单独说明（status 或 error.code 都算）；失败带出底层原因", () => {
    assert.equal(describeCompactOutcome({ status: "aborted" }), "压缩已中止。");
    assert.equal(
      describeCompactOutcome({ status: "failed", error: { code: "aborted", message: "aborted" } }),
      "压缩已中止。",
    );
    assert.equal(
      describeCompactOutcome({
        status: "failed",
        error: { code: "summarization_failed", message: "Summarization failed: net::ERR_" },
      }),
      "压缩上下文失败：Summarization failed: net::ERR_",
    );
  });

  test("declined 与无 error 的失败也有可读兜底，不出现 [object Object]", () => {
    assert.equal(describeCompactOutcome({ status: "declined" }), "压缩未执行。");
    assert.equal(describeCompactOutcome({ status: "failed" }), "压缩上下文失败：原因未知。");
  });
});
