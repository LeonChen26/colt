/**
 * 压缩失败原因的翻译（`describeCompactOutcome`）。
 *
 * durable 的压缩是一次任务：`waitForTask` 的 `outcome.status` 不是 `completed` 时
 * 才失败。全部形态都必须给出可读说明——否则用户点压缩就是「点了没反应」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeCompactOutcome } from "../src/worker/lib/compact-error.ts";

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
