/**
 * worker 投影纯函数测试。
 * 这些函数是内核结构 → 渲染层 DTO 的转换层，字段语义易错，值得覆盖。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { LaneSnapshot } from "@earendil-works/pi-agent-core";
import {
  countPatchLines,
  extractImage,
  extractText,
  extractToolCalls,
  extractToolText,
  isCoveredBlockType,
  project,
  projectBranchNodes,
  toRelative,
  type BranchEntry,
} from "../src/worker/lib/project.ts";

describe("extractText", () => {
  test("拼接多个 text 块", () => {
    const content = [
      { type: "text", text: "hello " },
      { type: "image", data: "..." },
      { type: "text", text: "world" },
    ];
    assert.equal(extractText(content), "hello world");
  });

  test("忽略非 text 块", () => {
    assert.equal(extractText([{ type: "toolCall", id: "x" }]), "");
  });

  test("非数组输入返回空串", () => {
    assert.equal(extractText(null), "");
    assert.equal(extractText({ type: "text", text: "x" }), "");
    assert.equal(extractText("plain"), "");
  });

  test("空数组返回空串", () => {
    assert.equal(extractText([]), "");
  });
});

describe("extractToolCalls", () => {
  test("抽取 id/name 与序列化后的 args", () => {
    const content = [
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    ];
    assert.deepEqual(extractToolCalls(content), [
      { id: "c1", name: "bash", args: '{"command":"ls"}' },
    ]);
  });

  test("无 arguments 时序列化为空对象", () => {
    const content = [{ type: "toolCall", id: "c1", name: "read" }];
    assert.equal(extractToolCalls(content)[0]?.args, "{}");
  });

  test("循环引用时回退为空对象而非抛错", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const content = [{ type: "toolCall", id: "c1", name: "x", arguments: circular }];
    assert.equal(extractToolCalls(content)[0]?.args, "{}");
  });

  test("非数组输入返回空数组", () => {
    assert.deepEqual(extractToolCalls(undefined), []);
  });
});

describe("extractToolText", () => {
  test("从 result.content 抽取文本", () => {
    assert.equal(extractToolText({ content: [{ type: "text", text: "ok" }] }), "ok");
  });

  test("无 content 返回空串", () => {
    assert.equal(extractToolText({ id: "x" }), "");
    assert.equal(extractToolText(null), "");
  });
});

describe("extractImage", () => {
  test("抽取首张图片的 base64 与 mimeType", () => {
    const content = [
      { type: "text", text: "已截取页面" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ];
    assert.deepEqual(extractImage(content), { data: "AAAA", mimeType: "image/png" });
  });

  test("无图片或无 content 返回 undefined", () => {
    assert.equal(extractImage([{ type: "text", text: "x" }]), undefined);
    assert.equal(extractImage(undefined), undefined);
    assert.equal(extractImage("plain"), undefined);
  });
});

describe("countPatchLines", () => {
  test("统计增删并排除文件头", () => {
    const patch = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,2 +1,3 @@", " keep", "+added", "-removed"].join("\n");
    assert.deepEqual(countPatchLines(patch), { added: 1, removed: 1 });
  });

  test("纯新增", () => {
    assert.deepEqual(countPatchLines("+++ b/x\n+a\n+b"), { added: 2, removed: 0 });
  });

  test("空 patch", () => {
    assert.deepEqual(countPatchLines(""), { added: 0, removed: 0 });
  });
});

describe("toRelative", () => {
  test("工作目录内的绝对路径转为相对", () => {
    const cwd = process.platform === "win32" ? "C:\\proj" : "/proj";
    const abs = process.platform === "win32" ? "C:\\proj\\src\\a.ts" : "/proj/src/a.ts";
    assert.equal(toRelative(cwd, abs), "src/a.ts");
  });

  test("反斜杠统一为正斜杠", () => {
    assert.equal(toRelative("/proj", "src\\nested\\a.ts"), "src/nested/a.ts");
  });

  test("目录外的绝对路径保留原样（仅归一分隔符）", () => {
    const cwd = process.platform === "win32" ? "C:\\proj" : "/proj";
    const outside = process.platform === "win32" ? "C:\\other\\a.ts" : "/other/a.ts";
    // 目录外不做 ../ 收敛，但分隔符仍统一为正斜杠
    const expected = process.platform === "win32" ? "C:/other/a.ts" : "/other/a.ts";
    assert.equal(toRelative(cwd, outside), expected);
  });

  test("已是相对路径时仅做分隔符归一", () => {
    assert.equal(toRelative("/proj", "src/a.ts"), "src/a.ts");
  });
});

describe("projectBranchNodes", () => {
  /** 一轮完整对话：用户提问 → 中间 LLM 轮（带工具调用）→ 工具结果 → 最终回复 */
  const turn = (): BranchEntry[] => [
    {
      id: "u1",
      parentId: null,
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "帮我读文件" }] },
    },
    {
      id: "a1",
      parentId: "u1",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "好的，我先读取" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
        ],
      },
    },
    {
      id: "t1",
      parentId: "a1",
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: "文件内容" }] },
    },
    {
      id: "a2",
      parentId: "t1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "文件里是 42" }] },
    },
  ];

  test("只保留用户输入与该轮最终回复，折叠中间轮次与工具调用", () => {
    const nodes = projectBranchNodes(turn(), "a2");
    assert.deepEqual(nodes.map((node) => node.id), ["u1", "a2"]);
    assert.deepEqual(nodes.map((node) => node.kind), ["user", "assistant"]);
    assert.equal(nodes[1]?.parentId, "u1");
    assert.equal(nodes[1]?.summary, "文件里是 42");
    assert.equal(nodes[0]?.isTip, false);
    assert.equal(nodes[1]?.isTip, true);
    assert.equal(nodes[0]?.onActivePath, true);
    assert.equal(nodes[1]?.onActivePath, true);
  });

  test("指针落在被折叠条目上时回退为活跃路径上最近的保留节点", () => {
    const nodes = projectBranchNodes(turn().slice(0, 3), "t1");
    assert.deepEqual(nodes.map((node) => node.id), ["u1"]);
    assert.equal(nodes[0]?.isTip, true);
    assert.equal(nodes[0]?.onActivePath, true);
  });

  test("压缩 / 分支摘要等结构节点保留并保持父子挂接", () => {
    const entries: BranchEntry[] = [
      {
        id: "u1",
        parentId: null,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "继续" }] },
      },
      { id: "cp", parentId: "u1", type: "compaction" },
      { id: "bs", parentId: "cp", type: "branch_summary" },
      {
        id: "a1",
        parentId: "bs",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "压缩后继续" }] },
      },
    ];
    const nodes = projectBranchNodes(entries, "a1");
    assert.deepEqual(nodes.map((node) => node.id), ["u1", "cp", "bs", "a1"]);
    assert.deepEqual(nodes.map((node) => node.kind), [
      "user",
      "compaction",
      "branch_summary",
      "assistant",
    ]);
    assert.deepEqual(nodes.map((node) => node.parentId), [null, "u1", "cp", "bs"]);
  });

  test("被折叠条目下的子节点重挂到最近的保留祖先", () => {
    const entries: BranchEntry[] = [
      {
        id: "u1",
        parentId: null,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "第一问" }] },
      },
      {
        id: "a1",
        parentId: "u1",
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] },
      },
      {
        id: "a2",
        parentId: "a1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "原分支答案" }] },
      },
      {
        id: "u2",
        parentId: "a1",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "改问别的" }] },
      },
    ];
    const nodes = projectBranchNodes(entries, "u2");
    assert.deepEqual(nodes.map((node) => node.id), ["u1", "a2", "u2"]);
    assert.equal(nodes.find((node) => node.id === "a2")?.parentId, "u1");
    assert.equal(nodes.find((node) => node.id === "u2")?.parentId, "u1");
    assert.equal(nodes.find((node) => node.id === "a2")?.onActivePath, false);
    assert.equal(nodes.find((node) => node.id === "u2")?.onActivePath, true);
    assert.equal(nodes.find((node) => node.id === "u2")?.isTip, true);
  });
});

describe("内容块覆盖哨兵（升级 pi 时的护栏）", () => {
  test("四个已知类型都算已覆盖", () => {
    for (const type of ["text", "thinking", "image", "toolCall"]) {
      assert.equal(isCoveredBlockType(type), true, type);
    }
  });

  test("未知类型与非字符串一律算未覆盖", () => {
    assert.equal(isCoveredBlockType("audio"), false);
    assert.equal(isCoveredBlockType(""), false);
    assert.equal(isCoveredBlockType(undefined), false);
    assert.equal(isCoveredBlockType(42), false);
    // 原型链上的键不算「已覆盖」——否则 constructor 之类的字符串会蒙混过关
    assert.equal(isCoveredBlockType("constructor"), false);
    assert.equal(isCoveredBlockType("__proto__"), false);
  });
});

/**
 * `project()` 整份视图。
 *
 * 前面那些 describe 覆盖的是各个 `extract*` 助手，**没人管过投影出来的整份视图**——
 * 而这里的约定恰恰是「同一份数据在视图里只能出现一次」：视图是**全量快照**、流式期间
 * 每 50ms 重推一次（见 `worker/entry.ts` 的 `scheduleFlush`），放错位置的字段，
 * 代价要乘上「被推了几次」。
 *
 * 断言尽量落在**最终产物**（整份视图序列化后的字符串）上，而不是「某个字段被赋值了」——
 * 只有断言产物本身，才抓得住「发过去、但渲染层从来不用」这种浪费。
 */
describe("project：工具结果只走 toolResults，不进 messages", () => {
  /** 只造 project() 真正读到的字段，避免把测试绑在内核的完整形状上 */
  const snapshotOf = (transcript: unknown[]): LaneSnapshot =>
    ({ transcript, operation: undefined }) as unknown as LaneSnapshot;

  const meta = {
    providerId: "test-provider",
    modelId: "test-model",
    thinkingLevel: "medium",
    skills: [],
    fileChanges: [],
    contextUsed: 0,
  } as unknown as Parameters<typeof project>[1];

  const entry = (id: string, message: unknown): unknown => ({ type: "message", id, message });

  /** 一轮完整对话：用户提问 → 助手带工具调用 → 工具结果 */
  const conversation = (): LaneSnapshot =>
    snapshotOf([
      entry("u1", { role: "user", content: [{ type: "text", text: "帮我看看这个文件" }] }),
      entry("a1", {
        role: "assistant",
        content: [
          { type: "text", text: "我来读一下" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
        ],
      }),
      entry("r1", {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "这是文件正文标记TOOLTEXT" }],
      }),
    ]);

  test("messages 里只有用户与助手，工具结果走 toolResults", () => {
    const view = project(conversation(), meta, new Map(), []);
    assert.deepEqual(
      view.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.deepEqual(
      view.toolResults.map((result) => result.id),
      ["call_1"],
    );
    assert.equal(view.toolResults[0]?.output, "这是文件正文标记TOOLTEXT");
  });

  test("同一段工具正文在整份视图里**只出现一次**（过去的重复就发生在这里）", () => {
    const serialized = JSON.stringify(project(conversation(), meta, new Map(), []));
    const occurrences = serialized.split("这是文件正文标记TOOLTEXT").length - 1;
    assert.equal(occurrences, 1, `工具正文在视图里出现了 ${occurrences} 次，应为 1 次`);
  });

  test("助手消息仍带着工具调用 id —— 工具卡就是靠它去 toolResults 取结果", () => {
    const view = project(conversation(), meta, new Map(), []);
    const assistant = view.messages.find((message) => message.role === "assistant");
    assert.deepEqual(
      assistant?.toolCalls.map((call) => call.id),
      ["call_1"],
    );
    assert.equal(assistant?.toolCalls[0]?.name, "read");
  });

  test("结构节点（header / value 等）不产生消息", () => {
    const view = project(
      snapshotOf([
        { kind: "header", id: "h1" },
        entry("u1", { role: "user", content: [{ type: "text", text: "在吗" }] }),
        { kind: "value", key: "x" },
      ]),
      meta,
      new Map(),
      [],
    );
    assert.deepEqual(
      view.messages.map((message) => message.role),
      ["user"],
    );
    assert.equal(view.toolResults.length, 0);
  });

  test("子代理总账原样带出（视图里的 subagents 是这条通道，不是从内核快照来的）", () => {
    const subagent = {
      id: "sub:researcher:abcd1234",
      toolCallId: "call_sub",
      name: "researcher",
      title: "查一下 read 工具在哪注册",
      status: "running" as const,
      startedAt: 1,
      tail: { streamingText: null, thought: null, runningTools: [], recentSteps: [], stepCount: 0 },
      stats: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
    const view = project(conversation(), meta, new Map(), [subagent]);
    assert.deepEqual(view.subagents, [subagent]);
  });
});

describe("project：工具截图能落盘的只报 hasImage", () => {
  const snapshotOf = (transcript: unknown[]): LaneSnapshot =>
    ({ transcript, operation: undefined }) as unknown as LaneSnapshot;
  const meta = {
    providerId: "test-provider",
    modelId: "test-model",
    thinkingLevel: "medium",
    skills: [],
    fileChanges: [],
    contextUsed: 0,
  } as unknown as Parameters<typeof project>[1];
  const shot = (toolCallId: string, mimeType: string): LaneSnapshot =>
    snapshotOf([
      {
        type: "message",
        id: "r1",
        message: {
          role: "toolResult",
          toolCallId,
          content: [
            { type: "text", text: "已截取主屏画面" },
            { type: "image", mimeType, data: "iVBORw0KGgoAAAANSUhEUg" },
          ],
        },
      },
    ]);
  const base64 = "iVBORw0KGgoAAAANSUhEUg";

  test("png 截图：只留标记，base64 不进视图", () => {
    const view = project(shot("call_shot", "image/png"), meta, new Map(), []);
    assert.equal(view.toolResults[0]?.hasImage, true);
    assert.equal(view.toolResults[0]?.image, undefined);
    assert.ok(!JSON.stringify(view).includes(base64), "能落盘的截图不该把 base64 留在视图里");
  });

  test("落不了盘的图片类型仍内联（宁可这一条大点，也别让用户看不到图）", () => {
    const view = project(shot("call_tiff", "image/tiff"), meta, new Map(), []);
    assert.equal(view.toolResults[0]?.hasImage, undefined);
    assert.equal(view.toolResults[0]?.image?.data, base64);
    assert.equal(view.toolResults[0]?.image?.mimeType, "image/tiff");
  });

  test("对照：同一个 id 换成能落盘的 png，行为立刻反过来——证明上面的断言不是空转", () => {
    const inline = project(shot("call_same", "image/tiff"), meta, new Map(), []);
    const spilled = project(shot("call_same", "image/png"), meta, new Map(), []);
    assert.notDeepEqual(inline.toolResults[0], spilled.toolResults[0]);
  });
});
