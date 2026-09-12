/**
 * worker 投影纯函数测试。
 * 这些函数是内核结构 → 渲染层 DTO 的转换层，字段语义易错，值得覆盖。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  countPatchLines,
  extractText,
  extractToolCalls,
  extractToolText,
  toRelative,
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
