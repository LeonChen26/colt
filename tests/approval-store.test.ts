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

/**
 * 造一个全局默认设为 approval 的 store。
 * 这些测试验证的是待审队列与记忆规则的生命周期，需要「普通操作逐条确认」
 * 作为前提；全局默认已改为 auto，故在此显式降回 approval。设的是全局默认而非
 * 会话级，避免污染「会话级模式独立于全局默认」这类用例。
 */
function store(): ApprovalStore {
  const instance = new ApprovalStore();
  instance.setMode("approval");
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

/** 造一条 bash 待审：与 edit 用不同工具，避免规则互相干扰 */
function askBash(instance: ApprovalStore, toolCallId: string, now = 1): void {
  const outcome = instance.evaluate({
    sessionId: SESSION,
    toolCallId,
    toolName: "bash",
    argsJson: JSON.stringify({ command: "npm test" }),
    now,
  });
  assert.ok("request" in outcome, "bash 应当进入待审");
}

describe("ApprovalStore 模式", () => {
  test("默认自动审批模式，可切换", () => {
    const instance = new ApprovalStore();
    assert.equal(instance.getMode(), "auto");
    instance.setMode("full-access");
    assert.equal(instance.getMode(), "full-access");
  });

  test("会话级模式：只改该会话，不影响其他会话", () => {
    const instance = new ApprovalStore();
    instance.register("s1", ROOT);
    instance.register("s2", ROOT);

    instance.setMode("auto", "s1");

    assert.equal(instance.getMode("s1"), "auto");
    assert.equal(instance.getMode("s2"), "auto", "s2 应仍为全局默认");
    assert.equal(instance.getMode(), "auto", "全局默认不应被改动");
  });

  test("会话级模式独立于全局默认", () => {
    const instance = store();
    instance.setMode("full-access"); // 改全局
    assert.equal(instance.getMode(SESSION), "full-access", "未单独设定时回退全局");

    instance.setMode("auto", SESSION); // 单独设定会话
    instance.setMode("approval"); // 再改全局
    assert.equal(instance.getMode(SESSION), "auto", "会话设定应压过新的全局默认");
  });

  test("重登记会话（worker 重启）保留会话级模式", () => {
    const instance = store();
    instance.setMode("auto", SESSION);

    // 模拟 worker 回收后重开：重新登记同一会话
    instance.register(SESSION, ROOT);

    assert.equal(instance.getMode(SESSION), "auto", "重登记不应丢失会话模式");
  });

  test("重登记保留记忆规则：与会话级模式同寿命", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });

    // 模拟 worker 回收后重开：重新登记同一会话
    instance.register(SESSION, ROOT);

    const next = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c2",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 2,
    });
    assert.ok("decision" in next, "记忆规则不应随 worker 重登记失效");
    assert.equal(instance.listPending(SESSION).length, 0);
  });

  test("未登记会话设定模式不污染全局默认", () => {
    const instance = new ApprovalStore();
    // 会话尚未 register（worker 未起）就设模式
    instance.setMode("auto", "not-registered-yet");

    assert.equal(instance.getMode("not-registered-yet"), "auto");
    assert.equal(instance.getMode(), "auto", "全局默认不应被会话级设定改写");
    assert.equal(instance.getMode("another-session"), "auto");
  });

  test("未登记会话预设的模式在首次 register 后保留", () => {
    const instance = new ApprovalStore();
    instance.setMode("full-access", "s1");
    instance.register("s1", ROOT);
    assert.equal(instance.getMode("s1"), "full-access");
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

  test("重登记保留拒绝规则：同类调用仍自动拒绝", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: false, deny: "tool" });

    instance.register(SESSION, ROOT);

    const next = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c2",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 2,
    });
    assert.ok("decision" in next, "拒绝规则不应随 worker 重登记失效");
    assert.equal(next.decision.approved, false);
    assert.equal(instance.listPending(SESSION).length, 0, "自动拒绝不应产生待审条目");
  });

  test("切全权模式清空拒绝规则：旧拒绝不再拦住同类调用", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: false, deny: "tool" });

    // 未切模式前，同类调用被自动拒绝
    const blocked = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c2",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 2,
    });
    assert.ok("decision" in blocked && blocked.decision.approved === false);

    // 切到全权后，旧拒绝规则应失效
    instance.setMode("full-access", SESSION);
    const next = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c3",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 3,
    });
    assert.ok("decision" in next, "全权模式应直接放行，不再回到待审");
    assert.equal(next.decision.approved, true, "旧拒绝规则不应继续生效");
  });

  test("切全权模式清空放行规则", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });

    instance.setMode("full-access", SESSION);
    instance.setMode("approval", SESSION);

    // 回到严格模式后，先前的放行记忆不应残留
    const again = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c2",
      toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }),
      now: 2,
    });
    assert.ok("request" in again, "放行规则应已被清空，需重新询问");
  });

  test("规则列表：可查看已记忆的放行与拒绝规则", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "signature" });
    askBash(instance, "c2");
    instance.resolve({ sessionId: SESSION, toolCallId: "c2", approved: false, deny: "tool" });

    const rules = instance.listRules(SESSION);
    assert.equal(rules.length, 2);
    assert.equal(rules[0]!.kind, "allow");
    assert.equal(rules[0]!.toolName, "edit");
    assert.equal(rules[0]!.scope, "signature");
    assert.equal(rules[0]!.signature, "edit:e:/proj/a.ts");
    assert.equal(rules[1]!.kind, "deny");
    assert.equal(rules[1]!.toolName, "bash");
    assert.equal(rules[1]!.scope, "tool");
    assert.ok(rules.every((rule) => rule.id.length > 0), "每条规则应有稳定 id");
  });

  test("删除单条规则：立即不再生效，其余保留", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });
    askBash(instance, "c2");
    instance.resolve({ sessionId: SESSION, toolCallId: "c2", approved: false, deny: "tool" });

    const denyRule = instance.listRules(SESSION).find((rule) => rule.kind === "deny");
    assert.ok(denyRule, "应有拒绝规则");
    assert.equal(instance.removeRule(SESSION, denyRule.id), true);
    assert.equal(instance.listRules(SESSION).length, 1, "只删掉目标那条");
    assert.equal(instance.removeRule(SESSION, "not-exist"), false, "删不存在的 id 返回 false");

    // 拒绝规则已删，同类 bash 调用应重新回到待审
    const next = instance.evaluate({
      sessionId: SESSION,
      toolCallId: "c3",
      toolName: "bash",
      argsJson: JSON.stringify({ command: "npm test" }),
      now: 2,
    });
    assert.ok("request" in next, "删除拒绝规则后不应再自动拒绝");
  });

  test("清空规则：可按类别，也可全清", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });
    askBash(instance, "c2");
    instance.resolve({ sessionId: SESSION, toolCallId: "c2", approved: false, deny: "tool" });

    instance.clearRules(SESSION, "deny");
    assert.equal(instance.listRules(SESSION).length, 1);
    assert.equal(instance.listRules(SESSION)[0]!.kind, "allow");

    instance.clearRules(SESSION);
    assert.equal(instance.listRules(SESSION).length, 0);
  });

  test("未登记会话查规则返回空而非报错", () => {
    const instance = new ApprovalStore();
    assert.deepEqual(instance.listRules("nope"), []);
    assert.equal(instance.removeRule("nope", "r1"), false);
    instance.clearRules("nope");
  });

  test("重登记清空待审队列（阻塞方随进程消失）", () => {
    const instance = store();
    askWrite(instance, "c1");
    assert.equal(instance.listPending(SESSION).length, 1);

    instance.register(SESSION, ROOT);
    assert.equal(instance.listPending(SESSION).length, 0, "待审条目不应跨 worker 存活");
  });

  test("注销会话后不再持有待审", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.unregister(SESSION);
    assert.equal(instance.listPending(SESSION).length, 0);
  });

  test("注销会话后会话级模式也被清除", () => {
    const instance = store();
    instance.setMode("auto", SESSION);
    assert.equal(instance.getMode(SESSION), "auto");

    instance.unregister(SESSION);

    // state 已彻底移除，回退全局默认（此用例的 store() 显式设了 approval）
    assert.equal(instance.getMode(SESSION), "approval");
  });

  test("注销后再登记不继承旧模式", () => {
    const instance = store();
    instance.setMode("auto", SESSION);
    instance.unregister(SESSION);

    // 同一 id 重新登记（视为全新会话）
    instance.register(SESSION, ROOT);
    assert.equal(instance.getMode(SESSION), "approval");
  });

  test("不同会话的记忆互相隔离", () => {
    const instance = new ApprovalStore();
    instance.setMode("approval");
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
