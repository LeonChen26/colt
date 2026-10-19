/**
 * worker 投影纯函数测试。
 * 这些函数是内核结构 → 渲染层 DTO 的转换层，字段语义易错，值得覆盖。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  countPatchLines,
  extractImage,
  extractText,
  extractToolCalls,
  extractToolText,
  projectTranscript,
  toRelative,
} from "../src/worker/lib/project.ts";
import { skillPathMatcher } from "../src/worker/lib/skills.ts";
import type { ViewSkill } from "../src/shared/worker-protocol.ts";

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

describe("projectTranscript：技能调用消息带上归属标记（别再冒充用户发言）", () => {
  /** 技能消息的真实形状（模板由 `skills.test.ts` 拿真函数钉住） */
  const invocation = (instructions?: string): string => {
    const block =
      '<skill name="pdf" location="/u/skills/pdf/SKILL.md">\n' +
      "References are relative to /u/skills/pdf.\n\n" +
      "技能的正文\n</skill>";
    return instructions === undefined ? block : `${block}\n\n${instructions}`;
  };

  const entry = (id: string, message: unknown): unknown => ({ type: "message", id, message });
  const userEntry = (id: string, text: string): unknown =>
    entry(id, { role: "user", content: [{ type: "text", text }] });

  test("认出来并带上 skill；正文照旧保留（展开技能卡要看的就是它）", () => {
    const { messages } = projectTranscript([userEntry("u1", invocation("只改这一处"))], new Map());
    assert.equal(messages[0]?.role, "user");
    assert.deepEqual(messages[0]?.skill, { name: "pdf", instructions: "只改这一处" });
    assert.ok(messages[0]?.text.includes("技能的正文"), "正文不能被丢掉");
  });

  test("普通用户消息**不带** skill（别把正常发言也改归属）", () => {
    const { messages } = projectTranscript([userEntry("u1", "帮我看看这个文件")], new Map());
    assert.equal(messages[0]?.skill, undefined);
    assert.ok(!("skill" in messages[0]!), "没有技能归属时不该多出这个键");
  });

  test("视图里没有裸露的技能调用 XML（归属是标记，不是靠正则再认一遍）", () => {
    // 「同一份数据只出现一次」的另一面：原始 XML 只该留在 `text` 里（展开时看），
    // 不该出现在 `skill` 标记里——否则界面会两处显示同一段内核文案
    const { messages } = projectTranscript([userEntry("u1", invocation("只改这一处"))], new Map());
    const marker = JSON.stringify(messages[0]?.skill);
    assert.ok(!marker.includes("<skill"), marker);
    assert.ok(!marker.includes("References are relative to"), marker);
  });
});

/**
 * `projectTranscript` 投影出的「消息 + 工具结果」两列。
 *
 * 这里的约定是「同一份数据在视图里只能出现一次」：视图是**全量快照**、流式期间
 * 每 50ms 重推一次（见 `worker/durable/entry.ts` 的 `scheduleFlush`），放错位置的字段，
 * 代价要乘上「被推了几次」。
 */
describe("projectTranscript：工具结果只走 toolResults，不进 messages", () => {
  const entry = (id: string, message: unknown): unknown => ({ type: "message", id, message });

  /** 一轮完整对话：用户提问 → 助手带工具调用 → 工具结果 */
  const conversation = (): unknown[] => [
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
  ];

  test("messages 里只有用户与助手，工具结果走 toolResults", () => {
    const { messages, toolResults } = projectTranscript(conversation(), new Map());
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.deepEqual(
      toolResults.map((result) => result.id),
      ["call_1"],
    );
    assert.equal(toolResults[0]?.output, "这是文件正文标记TOOLTEXT");
  });

  test("同一段工具正文在整份投影里**只出现一次**（过去的重复就发生在这里）", () => {
    const serialized = JSON.stringify(projectTranscript(conversation(), new Map()));
    const occurrences = serialized.split("这是文件正文标记TOOLTEXT").length - 1;
    assert.equal(occurrences, 1, `工具正文在视图里出现了 ${occurrences} 次，应为 1 次`);
  });

  test("助手消息仍带着工具调用 id —— 工具卡就是靠它去 toolResults 取结果", () => {
    const { messages } = projectTranscript(conversation(), new Map());
    assert.deepEqual(messages[1]?.toolCalls.map((call) => call.id), ["call_1"]);
  });
});

describe("projectTranscript：工具截图能落盘的只报 hasImage", () => {
  const shot = (toolCallId: string, mimeType: string): unknown[] => [
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
  ];
  const base64 = "iVBORw0KGgoAAAANSUhEUg";

  test("png 截图：只留标记，base64 不进视图", () => {
    const { toolResults } = projectTranscript(shot("call_shot", "image/png"), new Map());
    assert.equal(toolResults[0]?.hasImage, true);
    assert.equal(toolResults[0]?.image, undefined);
    assert.ok(!JSON.stringify(toolResults).includes(base64), "能落盘的截图不该把 base64 留在视图里");
  });

  test("落不了盘的图片类型仍内联（宁可这一条大点，也别让用户看不到图）", () => {
    const { toolResults } = projectTranscript(shot("call_tiff", "image/tiff"), new Map());
    assert.equal(toolResults[0]?.hasImage, undefined);
    assert.equal(toolResults[0]?.image?.data, base64);
    assert.equal(toolResults[0]?.image?.mimeType, "image/tiff");
  });

  test("对照：同一个 id 换成能落盘的 png，行为立刻反过来——证明上面的断言不是空转", () => {
    const inline = projectTranscript(shot("call_same", "image/tiff"), new Map()).toolResults[0];
    const spilled = projectTranscript(shot("call_same", "image/png"), new Map()).toolResults[0];
    assert.notDeepEqual(inline, spilled);
  });
});

describe("projectTranscript：read 命中技能文件时工具卡带 skill 标记（P3）", () => {
  const cwd = join("/proj");
  const skillFile = join(cwd, ".agents", "skills", "pdf", "SKILL.md");
  const skills: ViewSkill[] = [
    {
      name: "pdf",
      description: "处理 PDF",
      source: "project",
      modelInvocable: true,
      filePath: skillFile,
      disabled: false,
    },
  ];

  /** 一次助手轮次里同时出现：读技能文件、读普通文件、跑 bash */
  const transcript = (): unknown[] => [
    {
      type: "message",
      id: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c_skill", name: "read", arguments: { path: skillFile } },
          { type: "toolCall", id: "c_other", name: "read", arguments: { path: "src/index.ts" } },
          { type: "toolCall", id: "c_bash", name: "bash", arguments: { command: "cat x" } },
        ],
      },
    },
  ];

  test("读技能文件的那次带 skill，读普通文件 / bash 都不带", () => {
    const { messages } = projectTranscript(transcript(), new Map(), skillPathMatcher(skills, cwd));
    const calls = messages[0]?.toolCalls ?? [];
    assert.equal(calls.find((call) => call.id === "c_skill")?.skill, "pdf");
    assert.equal(calls.find((call) => call.id === "c_other")?.skill, undefined);
    assert.equal(calls.find((call) => call.id === "c_bash")?.skill, undefined);
  });

  test("没有装载技能时任何调用都不带标记（不给普通 read 无中生有）", () => {
    const { messages } = projectTranscript(transcript(), new Map(), skillPathMatcher([], cwd));
    assert.equal(
      messages[0]?.toolCalls.every((call) => call.skill === undefined),
      true,
    );
  });
});
