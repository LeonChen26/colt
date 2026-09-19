/**
 * 「稳定投影」的测试（`src/renderer/src/lib/stable-view.ts`）。
 *
 * 这层做的判断只有一句：**这两份数据算不算同一份**。它判错的方向是不对称的——
 * 判成「变了」只是白重渲染一次（慢），判成「没变」是**界面停在旧数据上**（错且不可见）。
 * 所以这里的重点不是「有代表性的几个字段」，而是**契约里的每一个字段**。
 *
 * 守这件事的办法是「逐字段扰动」：拿一份字段齐全的样板，把每个字段各改一次，
 * 断言比较函数都必须判为「变了」。样板与契约字段集**逐个对齐**（下面第一条用例守着），
 * 于是「契约新增字段」→ 样板先红 → 补进样板后 → 扰动用例再红 → 逼着比较函数跟上。
 * 这条链条只要有一环断了，就会出现「后台数据变了、界面纹丝不动」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type {
  ViewFileChange,
  ViewMessage,
  ViewRunningTool,
  ViewSubagent,
  ViewToolResult,
} from "../src/shared/worker-protocol.ts";
import {
  keepStableById,
  keepStableResultMap,
  keepStableSubagentMap,
  sameViewFileChange,
  sameViewMessage,
  sameViewSubagent,
  sameViewToolResult,
} from "../src/renderer/src/lib/stable-view.ts";

/** 一条字段齐全的助手消息（可选字段也要写全，否则扰动覆盖不到） */
const MESSAGE: ViewMessage = {
  id: "m1",
  role: "assistant",
  text: "正文",
  toolCalls: [{ id: "c1", name: "bash", args: '{"command":"ls"}', durationMs: 12 }],
  thought: "先看一眼目录",
  image: { data: "QUJD", mimeType: "image/png" },
  timestamp: 1_700_000_000_000,
};

const TOOL_RESULT: ViewToolResult = {
  id: "c1",
  output: "a.txt\nb.txt",
  isError: false,
  hasImage: true,
  image: { data: "QUJD", mimeType: "image/png" },
};

const FILE_CHANGE: ViewFileChange = {
  id: "f1",
  path: "src/a.ts",
  kind: "edit",
  patch: "@@ -1 +1 @@",
  addedLines: 1,
  removedLines: 2,
  timestamp: 1_700_000_000_000,
  netAddedLines: 3,
  netRemovedLines: 4,
};

/** 运行中的工具（子代理尾部里会出现它） */
const RUNNING_TOOL: ViewRunningTool = {
  id: "c1",
  name: "read",
  args: '{"path":"a.ts"}',
  output: "读到的内容",
  fullOutputPath: "/tmp/colt/out.txt",
  startedAt: 1_700_000_000_000,
};

/** 一个字段齐全的子代理总账（可选字段也写全，否则扰动覆盖不到） */
const SUBAGENT: ViewSubagent = {
  id: "sub:researcher:abcd1234",
  toolCallId: "c1",
  name: "researcher",
  title: "查一下 read 工具在哪注册",
  status: "running",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_000_100,
  error: "连接被拒",
  tail: {
    streamingText: "正在写结论",
    thought: "先定位注册点",
    runningTools: [RUNNING_TOOL],
    recentSteps: [MESSAGE],
    stepCount: 3,
  },
  stats: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
};

/**
 * 递归改掉一个值：字符串加尾巴、数字加一、布尔取反、数组/对象逐项递归、其余换成别的值。
 * 比手写一张「字段 → 新值」的表更不容易漏——样板里有几层，它就改到几层。
 */
function perturb(value: unknown): unknown {
  if (typeof value === "string") return `${value}!`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (Array.isArray(value)) return value.map(perturb);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, perturb(item)]));
  }
  return "perturbed";
}

/** 把样板的每一个字段各改一次，逐个断言「必须判为变了」 */
function assertEveryFieldDetected<T extends object>(
  sample: T,
  same: (a: T, b: T) => boolean,
  label: string,
): void {
  for (const key of Object.keys(sample)) {
    const mutated = {
      ...sample,
      [key]: perturb((sample as Record<string, unknown>)[key]),
    } as T;
    assert.ok(!same(sample, mutated), `${label} 的字段 ${key} 被改动了，却被判成「没变」`);
  }
}

describe("稳定投影：逐字段判等", () => {
  test("样板覆盖契约的全部字段（新增字段时这条先红，逼着把样板补全）", () => {
    assert.deepEqual(Object.keys(MESSAGE).sort(), [
      "id",
      "image",
      "role",
      "text",
      "thought",
      "timestamp",
      "toolCalls",
    ]);
    assert.deepEqual(Object.keys(TOOL_RESULT).sort(), [
      "hasImage",
      "id",
      "image",
      "isError",
      "output",
    ]);
    assert.deepEqual(Object.keys(FILE_CHANGE).sort(), [
      "addedLines",
      "id",
      "kind",
      "netAddedLines",
      "netRemovedLines",
      "patch",
      "path",
      "removedLines",
      "timestamp",
    ]);
    assert.deepEqual(Object.keys(SUBAGENT).sort(), [
      "endedAt",
      "error",
      "id",
      "name",
      "startedAt",
      "stats",
      "status",
      "tail",
      "title",
      "toolCallId",
    ]);
  });

  test("对照：内容相同的两份判为「没变」（否则扰动用例可能只是恒假）", () => {
    assert.ok(sameViewMessage(MESSAGE, structuredClone(MESSAGE)));
    assert.ok(sameViewToolResult(TOOL_RESULT, structuredClone(TOOL_RESULT)));
    assert.ok(sameViewFileChange(FILE_CHANGE, structuredClone(FILE_CHANGE)));
    assert.ok(sameViewSubagent(SUBAGENT, structuredClone(SUBAGENT)));
    assert.ok(sameViewMessage(MESSAGE, MESSAGE));
  });

  test("消息：每个字段被改动都判为「变了」", () => {
    assertEveryFieldDetected(MESSAGE, sameViewMessage, "消息");
  });

  test("工具结果：每个字段被改动都判为「变了」", () => {
    assertEveryFieldDetected(TOOL_RESULT, sameViewToolResult, "工具结果");
  });

  test("文件改动：每个字段被改动都判为「变了」（含净值这两个可空字段）", () => {
    assertEveryFieldDetected(FILE_CHANGE, sameViewFileChange, "文件改动");
  });

  test("子代理：每个字段被改动都判为「变了」（尾部与统计都要逐项比）", () => {
    assertEveryFieldDetected(SUBAGENT, sameViewSubagent, "子代理");
  });

  test("子代理尾部：流式文本 / 思考 / 工具 / 步数 / 最近步任一不同都算变了", () => {
    const mutate = (patch: Partial<ViewSubagent["tail"]>): ViewSubagent => ({
      ...SUBAGENT,
      tail: { ...SUBAGENT.tail, ...patch },
    });
    assert.ok(!sameViewSubagent(SUBAGENT, mutate({ streamingText: null })));
    assert.ok(!sameViewSubagent(SUBAGENT, mutate({ thought: null })));
    assert.ok(!sameViewSubagent(SUBAGENT, mutate({ runningTools: [] })));
    assert.ok(!sameViewSubagent(SUBAGENT, mutate({ stepCount: 4 })));
    assert.ok(!sameViewSubagent(SUBAGENT, mutate({ recentSteps: [] })));
  });

  test("子代理统计：自己那一份消耗变了也要判为变了（④ 卡里会显示它）", () => {
    assert.ok(
      !sameViewSubagent(SUBAGENT, { ...SUBAGENT, stats: { ...SUBAGENT.stats, costUsd: 0.02 } }),
    );
    assert.ok(
      !sameViewSubagent(SUBAGENT, { ...SUBAGENT, stats: { ...SUBAGENT.stats, inputTokens: 11 } }),
    );
  });

  test("净值算不出（null）与 0 不是一回事", () => {
    const unknown = { ...FILE_CHANGE, netAddedLines: null };
    assert.ok(!sameViewFileChange(FILE_CHANGE, unknown));
    assert.ok(!sameViewFileChange(unknown, { ...unknown, netAddedLines: 0 }));
  });

  test("工具调用逐项比：参数、耗时、名字、顺序任一不同都算变了", () => {
    const base = MESSAGE;
    assert.ok(
      !sameViewMessage(base, {
        ...base,
        toolCalls: [{ ...base.toolCalls[0]!, args: '{"command":"ls -a"}' }],
      }),
    );
    assert.ok(
      !sameViewMessage(base, {
        ...base,
        toolCalls: [{ ...base.toolCalls[0]!, durationMs: undefined }],
      }),
    );
    assert.ok(
      !sameViewMessage(base, { ...base, toolCalls: [{ ...base.toolCalls[0]!, id: "c2" }] }),
    );
    assert.ok(!sameViewMessage(base, { ...base, toolCalls: [] }));
    assert.ok(
      !sameViewMessage(base, {
        ...base,
        toolCalls: [base.toolCalls[0]!, { id: "c2", name: "read", args: "{}" }],
      }),
    );
  });
});

describe("稳定投影：引用复用", () => {
  test("按 id 复用：内容与位置都没变时，连数组本身都不换", () => {
    const first: ViewMessage = { ...MESSAGE, id: "m1" };
    const second: ViewMessage = { ...MESSAGE, id: "m2" };
    const prev = [first, second];
    const next = [{ ...first }, { ...second }];
    const out = keepStableById(prev, next, sameViewMessage);
    assert.equal(out, prev);
    assert.equal(out[0], first);
    assert.equal(out[1], second);
  });

  test("按 id 复用：只有一条变了时，其余保持旧引用", () => {
    const first: ViewMessage = { ...MESSAGE, id: "m1" };
    const second: ViewMessage = { ...MESSAGE, id: "m2" };
    const prev = [first, second];
    const out = keepStableById(prev, [{ ...first }, { ...second, text: "改了" }], sameViewMessage);
    assert.notStrictEqual(out, prev);
    assert.equal(out[0], first);
    assert.equal(out[1]!.text, "改了");
  });

  test("按 id 复用：只是换了位置也算变了（不能返回旧数组）", () => {
    const first: ViewMessage = { ...MESSAGE, id: "m1" };
    const second: ViewMessage = { ...MESSAGE, id: "m2" };
    const prev = [first, second];
    const out = keepStableById(prev, [{ ...second }, { ...first }], sameViewMessage);
    assert.notStrictEqual(out, prev);
    assert.equal(out[0], second);
    assert.equal(out[1], first);
  });

  test("按 id 复用：追加一条时，旧条目的引用不变", () => {
    const first: ViewMessage = { ...MESSAGE, id: "m1" };
    const added: ViewMessage = { ...MESSAGE, id: "m2" };
    const out = keepStableById([first], [first, added], sameViewMessage);
    assert.equal(out.length, 2);
    assert.equal(out[0], first);
    assert.equal(out[1], added);
  });

  test("按 id 复用：两条空的保持同一引用（空态不抖）", () => {
    const empty: ViewMessage[] = [];
    assert.equal(keepStableById(empty, [], sameViewMessage), empty);
  });

  test("结果表：内容没变时返回同一个 Map 引用", () => {
    const prev = keepStableResultMap(undefined, [TOOL_RESULT]);
    assert.equal(keepStableResultMap(prev, [structuredClone(TOOL_RESULT)]), prev);
  });

  test("结果表：某条变了就换新 Map，并且只换那一条", () => {
    const prev = keepStableResultMap(undefined, [TOOL_RESULT]);
    const next = keepStableResultMap(prev, [{ ...TOOL_RESULT, output: "变了" }]);
    assert.notStrictEqual(next, prev);
    assert.equal(next.get("c1")?.output, "变了");
    assert.equal(prev.get("c1")?.output, TOOL_RESULT.output);
  });

  test("结果表：条数一样但换了一条（id 不同）也要换新 Map", () => {
    const prev = keepStableResultMap(undefined, [TOOL_RESULT]);
    const next = keepStableResultMap(prev, [{ ...TOOL_RESULT, id: "c2" }]);
    assert.notStrictEqual(next, prev);
    assert.equal(next.has("c1"), false);
    assert.equal(next.has("c2"), true);
  });

  test("子代理查表：内容没变时返回同一个 Map 引用", () => {
    const prev = keepStableSubagentMap(undefined, [SUBAGENT]);
    assert.equal(keepStableSubagentMap(prev, [structuredClone(SUBAGENT)]), prev);
  });

  test("子代理查表：某条变了就换新 Map（状态从运行中转完成）", () => {
    const prev = keepStableSubagentMap(undefined, [SUBAGENT]);
    const next = keepStableSubagentMap(prev, [{ ...SUBAGENT, status: "completed" }]);
    assert.notStrictEqual(next, prev);
    assert.equal(next.get("c1")?.status, "completed");
    assert.equal(prev.get("c1")?.status, "running");
  });

  test("子代理查表：按 toolCallId 键控（换个 toolCallId 就是另一条）", () => {
    const prev = keepStableSubagentMap(undefined, [SUBAGENT]);
    const next = keepStableSubagentMap(prev, [{ ...SUBAGENT, toolCallId: "c2" }]);
    assert.notStrictEqual(next, prev);
    assert.equal(next.has("c1"), false);
    assert.equal(next.has("c2"), true);
  });
});
