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
 * 造一个当前会话设为 approval 的 store。
 * 这些测试验证的是待审队列与记忆规则的生命周期，需要「普通操作逐条确认」
 * 作为前提；会话默认是 auto，故在此显式降回 approval。
 */
function store(): ApprovalStore {
  const instance = new ApprovalStore();
  instance.register(SESSION, ROOT);
  instance.setMode("approval", SESSION);
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
  test("默认自动审批模式，可按会话切换", () => {
    const instance = new ApprovalStore();
    instance.register("s1", ROOT);
    assert.equal(instance.getMode("s1"), "auto");

    instance.setMode("full-access", "s1");
    assert.equal(instance.getMode("s1"), "full-access");
  });

  test("会话级模式：只改该会话，不影响其他会话", () => {
    const instance = new ApprovalStore();
    instance.register("s1", ROOT);
    instance.register("s2", ROOT);

    instance.setMode("full-access", "s1");

    assert.equal(instance.getMode("s1"), "full-access");
    assert.equal(instance.getMode("s2"), "auto", "其他会话应仍为默认值");
  });

  test("两个会话的审批模式互相独立", () => {
    const instance = new ApprovalStore();
    instance.register("s1", ROOT);
    instance.register("s2", ROOT);

    instance.setMode("auto", "s1");
    instance.setMode("approval", "s2");

    assert.equal(instance.getMode("s1"), "auto");
    assert.equal(instance.getMode("s2"), "approval");
  });

  test("auto 模式下只有结构白名单内的命令交给分析", () => {
    const instance = store();
    instance.setMode("auto", SESSION);

    const analyzable = instance.evaluate({
      sessionId: SESSION, toolCallId: "c1", toolName: "bash",
      argsJson: JSON.stringify({ command: "npm test" }), now: 1,
    });
    assert.ok("analyze" in analyzable, "白名单内命令应交给分析");

    const manual = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "bash",
      argsJson: JSON.stringify({ command: "./scripts/foo.sh" }), now: 2,
    });
    assert.ok("request" in manual, "白名单外命令应进待审");
    assert.equal(instance.listPending(SESSION).length, 1);
  });

  test("命令白名单可由构造参数覆盖（内置默认随之失效）", () => {
    const instance = new ApprovalStore(["mytool"]);
    instance.register(SESSION, ROOT);
    instance.setMode("auto", SESSION);

    const custom = instance.evaluate({
      sessionId: SESSION, toolCallId: "c1", toolName: "bash",
      argsJson: JSON.stringify({ command: "mytool run" }), now: 1,
    });
    assert.ok("analyze" in custom, "自定义命令应可分析");

    const npm = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "bash",
      argsJson: JSON.stringify({ command: "npm test" }), now: 2,
    });
    assert.ok("request" in npm, "被覆盖后内置默认不再生效");
  });

  test("空白名单即关闭分析器自动放行", () => {
    const instance = new ApprovalStore([]);
    instance.register(SESSION, ROOT);
    instance.setMode("auto", SESSION);

    const result = instance.evaluate({
      sessionId: SESSION, toolCallId: "c1", toolName: "bash",
      argsJson: JSON.stringify({ command: "npm test" }), now: 1,
    });
    assert.ok("request" in result);
  });

  test("setAnalyzeCommandAllowlist 可在运行期生效", () => {
    const instance = store();
    instance.setMode("auto", SESSION);

    const before = instance.evaluate({
      sessionId: SESSION, toolCallId: "c1", toolName: "bash",
      argsJson: JSON.stringify({ command: "npm test" }), now: 1,
    });
    assert.ok("analyze" in before);

    instance.setAnalyzeCommandAllowlist([]);
    const after = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "bash",
      argsJson: JSON.stringify({ command: "npm test" }), now: 2,
    });
    assert.ok("request" in after);
  });

  test("切换模式不改动已入队的待审条目（不追溯放行）", () => {
    const instance = store();
    askWrite(instance, "c1");

    instance.setMode("full-access", SESSION);

    const pending = instance.listPending(SESSION);
    assert.equal(pending.length, 1, "已弹出的卡片应保留，等待用户处置");
    assert.equal(pending[0]?.toolCallId, "c1");
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

  test("未登记会话设定模式不影响其他会话", () => {
    const instance = new ApprovalStore();
    instance.register("s2", ROOT);
    // 会话尚未 register（worker 未起）就设模式
    instance.setMode("full-access", "not-registered-yet");

    assert.equal(instance.getMode("not-registered-yet"), "full-access");
    assert.equal(instance.getMode("s2"), "auto", "其他会话不受影响");
  });

  test("未登记会话预设的模式在首次 register 后保留", () => {
    const instance = new ApprovalStore();
    instance.setMode("full-access", "s1");
    instance.register("s1", ROOT);
    assert.equal(instance.getMode("s1"), "full-access");
  });

  test("自动审批模式：普通操作交给分析，高风险仍入待审", () => {
    const instance = store();
    instance.setMode("auto", SESSION);

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
    instance.setMode("auto", SESSION);
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
    instance.setMode("auto", SESSION);
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
    instance.setMode("full-access", SESSION);
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

  test("入参无法解析时，不允许被工具级记忆放行", () => {
    // 这条守的是「看不懂」不能被当成「不传参数」：空对象是一个**合法**入参形态，
    // 若解析失败回落到 {}，下面的工具级记忆照常命中，一条内容未知的调用就自动通过了。
    const instance = store();
    askWrite(instance, "c1", "E:/proj/a.ts");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });

    const next = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "edit",
      argsJson: "{ 这不是 JSON", now: 2,
    });
    assert.ok("request" in next, "入参解析失败时必须挂起人工确认，不能自动放行");
    assert.match(next.request.reason, /无法解析/);
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
    // id 是 `removeRule` 与界面定位规则的唯一凭据，必须具体（顺序号）且重复读取不换
    assert.deepEqual(
      rules.map((rule) => rule.id),
      ["r1", "r2"],
    );
    assert.deepEqual(
      instance.listRules(SESSION).map((rule) => rule.id),
      ["r1", "r2"],
      "重复读取不该换 id",
    );
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

  test("注销会话后会话级模式回退默认值", () => {
    const instance = store();
    instance.setMode("auto", SESSION);
    assert.equal(instance.getMode(SESSION), "auto");

    instance.unregister(SESSION);

    // state 已彻底移除，回退默认模式
    assert.equal(instance.getMode(SESSION), "auto");
  });

  test("注销后再登记回退默认模式", () => {
    const instance = store();
    instance.setMode("full-access", SESSION);
    instance.unregister(SESSION);

    // 同一 id 重新登记（视为全新会话）
    instance.register(SESSION, ROOT);
    assert.equal(instance.getMode(SESSION), "auto");
  });

  test("不同会话的记忆互相隔离", () => {
    const instance = new ApprovalStore();
    instance.register("s1", ROOT);
    instance.register("s2", ROOT);
    instance.setMode("approval", "s1");
    instance.setMode("approval", "s2");

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

describe("ApprovalStore 补充：规则优先级与边界", () => {
  test("拒绝规则优先于自动分析：auto 模式下直接拒绝而非 analyze", () => {
    const instance = new ApprovalStore();
    instance.register(SESSION, ROOT);
    instance.setMode("approval", SESSION);
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: false, deny: "tool" });

    instance.setMode("auto", SESSION);
    const next = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 2,
    });
    assert.ok("decision" in next, "拒绝规则应压过 auto 的分析分支");
    assert.equal(next.decision.approved, false);
    assert.equal(instance.listPending(SESSION).length, 0);
  });

  test("auto 模式下已记忆的放行规则仍然生效", () => {
    const instance = new ApprovalStore();
    instance.register(SESSION, ROOT);
    instance.setMode("approval", SESSION);
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });

    instance.setMode("auto", SESSION);
    const next = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/b.ts" }), now: 2,
    });
    assert.ok("decision" in next);
    assert.equal(next.decision.approved, true);
  });

  test("签名级拒绝规则只拦同签名", () => {
    const instance = store();
    askWrite(instance, "c1", "E:/proj/a.ts");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: false, deny: "signature" });

    const same = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 2,
    });
    assert.ok("decision" in same && same.decision.approved === false);

    const other = instance.evaluate({
      sessionId: SESSION, toolCallId: "c3", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/b.ts" }), now: 3,
    });
    assert.ok("request" in other, "不同签名不应被拒绝规则拦下");
  });

  test("删除放行规则后同类调用重新询问", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });

    const allowRule = instance.listRules(SESSION).find((rule) => rule.kind === "allow");
    assert.ok(allowRule, "应有放行规则");
    assert.equal(instance.removeRule(SESSION, allowRule.id), true);

    const next = instance.evaluate({
      sessionId: SESSION, toolCallId: "c2", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 2,
    });
    assert.ok("request" in next, "放行规则删除后应重新询问");
  });

  test("clearRules 只清放行时拒绝规则保留", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });
    askBash(instance, "c2");
    instance.resolve({ sessionId: SESSION, toolCallId: "c2", approved: false, deny: "tool" });

    instance.clearRules(SESSION, "allow");
    const rules = instance.listRules(SESSION);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.kind, "deny");
  });

  test("规则 id 在放行与拒绝间共享且唯一", () => {
    const instance = store();
    askWrite(instance, "c1");
    instance.resolve({ sessionId: SESSION, toolCallId: "c1", approved: true, remember: "tool" });
    askBash(instance, "c2");
    instance.resolve({ sessionId: SESSION, toolCallId: "c2", approved: false, deny: "tool" });

    const ids = instance.listRules(SESSION).map((rule) => rule.id);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, ids.length, "id 不应重复");
    assert.notEqual(ids[0], ids[1]);
  });

  test("切换 full-access 只影响当前会话，其他会话规则不受影响", () => {
    const instance = new ApprovalStore();
    instance.register("s1", ROOT);
    instance.register("s2", ROOT);
    instance.setMode("approval", "s1");
    instance.setMode("approval", "s2");

    for (const sessionId of ["s1", "s2"]) {
      instance.evaluate({
        sessionId, toolCallId: `c-${sessionId}`, toolName: "edit",
        argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 1,
      });
      instance.resolve({ sessionId, toolCallId: `c-${sessionId}`, approved: true, remember: "tool" });
    }
    assert.equal(instance.listRules("s1").length, 1);
    assert.equal(instance.listRules("s2").length, 1);

    instance.setMode("full-access", "s1");

    assert.equal(instance.getMode("s1"), "full-access");
    assert.equal(instance.listRules("s1").length, 0, "当前会话的规则被清空");
    assert.equal(instance.getMode("s2"), "approval", "其他会话模式不变");
    assert.equal(instance.listRules("s2").length, 1, "其他会话规则不受影响");
  });

  test("commitAnalyzed 不校验是否先经 analyze，未分析条目也会入队", () => {
    const instance = store();
    const outcome = instance.commitAnalyzed({
      sessionId: SESSION, toolCallId: "ghost", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 1, allow: false, reason: "不确定",
    });
    assert.ok("request" in outcome);
    assert.equal(instance.listPending(SESSION).length, 1);
  });

  test("未登记会话在默认 auto 下也不放行（项目根缺失按项目外处理）", () => {
    const instance = new ApprovalStore();
    const outcome = instance.evaluate({
      sessionId: "unknown", toolCallId: "c1", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 1,
    });
    assert.ok("request" in outcome);
    assert.equal(outcome.request.risk, "dangerous");
  });

  test("待审列表按会话隔离", () => {
    const instance = new ApprovalStore();
    instance.register("s1", ROOT);
    instance.register("s2", ROOT);
    instance.setMode("approval", "s1");
    instance.setMode("approval", "s2");
    instance.evaluate({
      sessionId: "s1", toolCallId: "c1", toolName: "edit",
      argsJson: JSON.stringify({ path: "E:/proj/a.ts" }), now: 1,
    });
    assert.equal(instance.listPending("s1").length, 1);
    assert.equal(instance.listPending("s2").length, 0);
  });
});
