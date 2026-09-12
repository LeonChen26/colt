/**
 * 审批队列（主进程侧）测试。
 * 这一层负责记忆规则的写入与待审条目的生命周期，
 * 一旦出错会表现为「拒绝过一次却不再询问」，故单独覆盖。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "../src/main/approval/store.ts";

const SESSION = "s1";
const ROOT = "E:/proj";

function store(): ApprovalStore {
  const instance = new ApprovalStore();
  instance.register(SESSION, ROOT);
  return instance;
}

function askWrite(
  instance: ApprovalStore,
  toolCallId: string,
  path = "E:/proj/a.ts",
  now = 1,
): void {
  const outcome = instance.evaluate({
    sessionId: SESSION,
    toolCallId,
    toolName: "edit",
    argsJson: JSON.stringify({ path }),
    now,
  });
  assert.ok("request" in outcome, "写入应当进入待审");
}

describe("ApprovalStore 模式", () => {
  test("默认审批模式，可切换", () => {
    const instance = store();
    assert.equal(instance.getMode(), "approval");
    instance.setMode("full-access");
    assert.equal(instance.getMode(), "full-access");
  });

  test("自动审批模式：普通操作交给分析，高风险仍入待审", () => {
    const instance = store();
    instance.setMode("auto");

    // 普通写入进入 analyze 分支（由上层调用大模型分析）
    const ordinary = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 1,
    });
    assert.ok("analyze" in ordinary);
    assert.equal(ordinary.analyze.invocation.toolName, "edit");
    // 分析前不入队
    assert.equal(instance.listPending(SESSION).length, 0);

    // 高风险命令不经过分析，直接入待审
    const risky = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c2",
      toolName: "bash",
      argsJson: JSON.stringify({ command: "rm -rf build" }),
      now: 2,
    });
    assert.ok("request" in risky);
    assert.equal(instance.listPending(SESSION).length, 1);
  });

  test("commitAnalyzed 放行：不写记忆规则", () => {
    const instance = store();
    instance.setMode("auto");
    instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 1,
    });

    const outcome = instance.commitAnalyzed({
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 2,
      allow: true,
      reason: "常规项目内文件写入",
    });
    assert.ok("decision" in outcome);
    assert.equal(outcome.decision.approved, true);
    assert.match(outcome.decision.reason, /常规/);
    assert.equal(instance.listPending(SESSION).length, 0);

    // 分析放行不固化：下一次同操作仍需重新分析
    const next = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c2",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 3,
    });
    assert.ok("analyze" in next, "分析放行不应写入免问记忆");
  });

  test("commitAnalyzed 拒绝：退回人工待审", () => {
    const instance = store();
    instance.setMode("auto");
    instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 1,
    });

    const outcome = instance.commitAnalyzed({
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 2,
      allow: false,
      reason: "来源可疑，建议人工确认",
    });
    assert.ok("request" in outcome);
    assert.equal(outcome.request.toolCallId, "c1");
    assert.match(outcome.request.reason, /人工确认/);
    assert.equal(instance.listPending(SESSION).length, 1);
  });

  test("全权模式下不产生待审", () => {
    const instance = store();
    instance.setMode("full-access");
    const outcome = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "C:/outside/a.ts" }),
      now: 1,
    });
    assert.ok("decision" in outcome);
    assert.equal(outcome.decision.approved, true);
    assert.equal(instance.listPending(SESSION).length, 0);
  });
});

describe("ApprovalStore 判定", () => {
  test("只读工具直接放行且不入队", () => {
    const instance = store();
    const outcome = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "read",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 1,
    });
    assert.ok("decision" in outcome);
    assert.equal(instance.listPending(SESSION).length, 0);
  });

  test("写入类调用进入待审并带上判定依据", () => {
    const instance = store();
    const outcome = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 123,
    });
    assert.ok("request" in outcome);
    assert.equal(outcome.request.toolCallId, "c1");
    assert.equal(outcome.request.risk, "moderate");
    assert.equal(outcome.request.requestedAt, 123);
    assert.equal(outcome.request.signature, "edit:e:/proj/a.ts");
    assert.equal(instance.listPending(SESSION).length, 1);
  });

  test("参数不是合法 JSON 时不放行", () => {
    const instance = store();
    const outcome = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c1",
      toolName: "edit",
      argsJson: "not-json",
      now: 1,
    });
    assert.ok("request" in outcome, "解析失败应保守进入待审");
  });

  test("待审列表按请求时间升序", () => {
    const instance = store();
    askWrite(instance, "c1", "E:/proj/a.ts", 10);
    askWrite(instance, "c2", "E:/proj/b.ts", 20);
    assert.deepEqual(
      instance.listPending(SESSION).map((item) => item.toolCallId),
      ["c1", "c2"],
    );
  });

  test("未登记的会话仍按需询问，不默认放行", () => {
    const instance = new ApprovalStore();
    const outcome = instance.evaluate({
      sessionId: "unknown",
      toolCallId: "c1",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 1,
    });
    assert.ok("request" in outcome);
  });
});

describe("ApprovalStore 处置与记忆", () => {
  test("批准且记住签名：同签名免问", () => {
    const instance = store();
    askWrite(instance, "c1");
    const decision = instance.resolve({
      sessionId: SESSION, toolCallId: "c1", approved: true, remember: "signature",
    });
    assert.equal(decision?.approved, true);
    assert.equal(instance.listPending(SESSION).length, 0);

    const next = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 2,
    });
    assert.ok("decision" in next, "同签名应免问");
  });

  test("拒绝时不写入记忆规则", () => {
    const instance = store();
    askWrite(instance, "c1");
    const decision = instance.resolve({
      sessionId: SESSION, toolCallId: "c1", approved: false, remember: "signature",
    });
    assert.equal(decision?.approved, false);

    // 拒绝过的调用，下次仍须询问
    const next = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 2,
    });
    assert.ok("request" in next, "拒绝不应产生免问规则");
  });

  test("拒绝时带上给模型的说明", () => {
    const instance = store();
    askWrite(instance, "c1");
    const decision = instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: false });
    assert.match(decision?.reason ?? "", /拒绝/);
  });

  test("可自定义拒绝理由", () => {
    const instance = store();
    askWrite(instance, "c1");
    const decision = instance.resolve({
      sessionId: SESSION, toolCallId: "c1", approved: false, reason: "换个目录",
    });
    assert.equal(decision?.reason, "换个目录");
  });

  test("工具级记忆放行该工具的其他路径", () => {
    const instance = store();
    askWrite(instance, "c1", "E:/proj/a.ts");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });

    const next = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/other.ts" }), now: 2,
    });
    assert.ok("decision" in next, "工具级记忆应放行其他路径");
  });

  test("签名级记忆不跨路径生效", () => {
    const instance = store();
    askWrite(instance, "c1", "E:/proj/a.ts");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "signature" });

    const next = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/other.ts" }), now: 2,
    });
    assert.ok("request" in next, "签名级记忆不应跨路径");
  });

  test("高风险调用即使被批准并记住，也不产生免问规则", () => {
    const instance = store();
    const outcome = instance.evaluate({
      sessionId: SESSION, toolCallId: "c1", toolName: "bash",
      argsJson: JSON.stringify({ command: "rm -rf build" }), now: 1,
    });
    assert.ok("request" in outcome);
    assert.equal(outcome.request.risk, "dangerous");

    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });

    const next = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "bash",
      argsJson: JSON.stringify({ command: "rm -rf build" }), now: 2,
    });
    assert.ok("request" in next, "高风险必须每次单独确认");
  });

  test("重复处置同一条返回 null", () => {
    const instance = store();
    askWrite(instance, "c1");
    assert.ok(instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true }));
    assert.equal(instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true }), null);
  });

  test("处置不存在的条目返回 null", () => {
    const instance = store();
    assert.equal(instance.resolve({ sessionId: SESSION, toolCallId: "nope", approved: true }), null);
  });

  test("处置后该项从待审移除，其余保留", () => {
    const instance = store();
    askWrite(instance, "c1", "E:/proj/a.ts");
    askWrite(instance, "c2", "E:/proj/b.ts");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true });
    assert.deepEqual(
      instance.listPending(SESSION).map((item) => item.toolCallId),
      ["c2"],
    );
  });
});

describe("ApprovalStore 生命周期", () => {
  test("clearPending 清空并返回被丢弃项", () => {
    const instance = store();
    askWrite(instance, "c1");
    askWrite(instance, "c2", "E:/proj/b.ts");
    const dropped = instance.clearPending(SESSION);
    assert.equal(dropped.length, 2);
    assert.equal(instance.listPending(SESSION).length, 0);
  });

  test("重新登记会话会重置记忆规则", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });
    instance.register(SESSION, ROOT);

    askWrite(instance, "c2");
    assert.equal(instance.listPending(SESSION).length, 1, "重新登记后记忆应失效");
  });

  test("注销会话后不再持有待审", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.unregister(SESSION);
    assert.equal(instance.listPending(SESSION).length, 0);
  });

  test("不同会话的记忆互相隔离", () => {
    const instance = new ApprovalStore();
    instance.register("s1", ROOT);
    instance.register("s2", ROOT);

    instance.evaluate({
      sessionId: "s1", toolCallId: "c1", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 1,
    });
    instance.resolve({ sessionId: "s1", toolCallId: "c1", approved: true, remember: "tool" });

    const other = instance.evaluate({
      sessionId: "s2", toolCallId: "c2", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 2,
    });
    assert.ok("request" in other, "s1 的放行不应影响 s2");
  });
});
