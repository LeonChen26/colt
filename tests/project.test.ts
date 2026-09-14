/**
 * worker 投影纯函数测试。
 * 这些函数是内核结构 → 渲染层 DTO 的转换层，字段语义易错，值得覆盖。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  countPatchLines,
  extractImage,
  extractText,
  extractToolCalls,
  extractToolText,
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
