/**
 * 浏览器工具入参校验的测试（动作链分派层）。
 *
 * 这里钉的是「假成功」防线：校验放过去的参数会直接决定页面被改成什么样，
 * 而链形态下模型最容易漏字段——一条漏了 text 的 type 会**清空字段却报成功**，
 * 模型拿着「链完成」继续走，数据其实没填上。宿主侧行为不改（空串输入是既有的
 * 显式清空能力），防线收在 worker 的分派处。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBrowserTools } from "../src/worker/lib/browser-tool";
import { systemPrompt } from "../src/worker/lib/system-prompt";
import { HostBridge } from "../src/worker/lib/host-bridge";
import type { HostResult } from "@shared/worker-protocol";

/** 记录型假桥：把每次宿主调用记下来（校验用例根本走不到 call，链用例按固定指纹应答） */
function recordingBridge(): { bridge: HostBridge; calls: { action: string; params: Record<string, unknown> }[] } {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const bridge = new HostBridge(() => undefined);
  bridge.call = (_capability, action, params) => {
    calls.push({ action, params });
    if (action === "fingerprint") return Promise.resolve({ text: "nav=0 url=http://t/" } satisfies HostResult);
    return Promise.resolve({ text: "ok" } satisfies HostResult);
  };
  return { bridge, calls };
}

/** 按内核的六参签名调用 browser_act（后四个参数在分派校验之前都用不到，传 undefined） */
async function callAct(params: Record<string, unknown>, bridge: HostBridge) {
  const tool = createBrowserTools(bridge).find((item) => item.name === "browser_act");
  assert.ok(tool !== undefined, "browser_act 工具存在");
  return tool.execute(
    "test",
    params as never,
    () => undefined,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

async function rejects(params: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const { bridge } = recordingBridge();
  await assert.rejects(
    () => callAct(params, bridge),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe("browser_act 动作链分派校验", () => {
  test("action 与 actions 同时给 → 拒绝并说明二选一（不静默忽略其中一个）", async () => {
    await rejects({ action: "click", actions: [{ action: "click", ref: "e1" }] }, /不能同时提供/);
  });

  test("空链 → 拒绝（没有可执行的动作）", async () => {
    await rejects({ actions: [] }, /不能为空数组/);
  });

  test("链中 type 缺 text → 拒绝并点名下标（否则清空字段却报「已输入」的假成功）", async () => {
    await rejects(
      {
        actions: [
          { action: "type", ref: "e1", text: "甲" },
          { action: "type", ref: "e2" }, // 漏了 text
        ],
      },
      /actions\[1\].*缺少 text/,
    );
  });

  test("type 显式 text:\"\"（有意清空）放行，且空串如实下发给宿主", async () => {
    const { bridge, calls } = recordingBridge();
    const result = await callAct(
      {
        actions: [
          { action: "type", ref: "e1", text: "" },
          { action: "click", ref: "e2" },
        ],
      },
      bridge,
    );
    const first = result.content[0];
    assert.ok(first !== undefined && first.type === "text", "链结果带文本");
    assert.match(first.text, /动作链完成/);
    const typeCall = calls.find((call) => call.action === "type");
    assert.ok(typeCall !== undefined, "type 动作真的发到了宿主");
    assert.equal(typeCall.params.text, "", "显式空串不被 definedParams 吃掉（清空是合法意图）");
  });

  test("链中 key 缺键名 → 拒绝并点名下标（宿主侧的报错指不到「链里第几个」）", async () => {
    await rejects(
      {
        actions: [
          { action: "type", ref: "e1", text: "搜索词" },
          { action: "key" }, // 漏了键名
        ],
      },
      /actions\[1\].*缺少 key/,
    );
  });

  test("单发 key：键名与修饰键原样下发（不拼成字符串，宿主侧按数组校验）", async () => {
    const { bridge, calls } = recordingBridge();
    await callAct({ action: "key", key: "a", modifiers: ["ctrl"] }, bridge);
    const call = calls.find((item) => item.action === "key");
    assert.ok(call !== undefined, "key 动作真的发到了宿主");
    assert.equal(call.params.key, "a");
    assert.deepEqual(call.params.modifiers, ["ctrl"]);
  });

  test("链里的 key 也逐动作下发（回车提交就靠它）", async () => {
    const { bridge, calls } = recordingBridge();
    const result = await callAct(
      {
        actions: [
          { action: "type", ref: "e1", text: "搜索词" },
          { action: "key", key: "Enter" },
        ],
      },
      bridge,
    );
    const call = calls.find((item) => item.action === "key");
    assert.ok(call !== undefined);
    assert.equal(call.params.key, "Enter");
    const first = result.content[0];
    assert.ok(first !== undefined && first.type === "text");
    assert.match(first.text, /动作链完成/);
  });
});

describe("登录 / 验证环节：不猜密码；用户给过凭据才可直接输入", () => {
  // 防的是「模型在登录页反复猜账号密码 / 试错」。规则落在模型能读到的**两处**文本上：
  // 基础系统提示词（总则）与 browser_act 描述（动作级须知）——任一被删都会让规则悄悄消失。
  // 注意不是「一律禁代填」：用户给过凭据时要允许直接输入，别把合法路径也堵死。
  const ruleTexts = (): string[] => {
    const tool = createBrowserTools(recordingBridge().bridge).find(
      (item) => item.name === "browser_act",
    );
    assert.ok(tool !== undefined, "browser_act 工具存在");
    return [systemPrompt("E:/proj"), tool.description];
  };

  test("两处都写明：不猜账号密码、用户给过凭据就直接输入、没给则请用户「接管」", () => {
    for (const text of ruleTexts()) {
      assert.match(text, /登录/, "必须点到「登录」这个场景");
      assert.match(text, /不要猜/, "必须明确禁止猜账号密码");
      assert.match(
        text,
        /用户给过凭据就直接输入/,
        "用户给了凭据要允许直接输入，别一刀切禁掉",
      );
      assert.match(text, /接管/, "没有凭据时给出出口：让用户接管输入");
      assert.match(text, /交还/, "必须说明交还后如何继续");
    }
  });
});
