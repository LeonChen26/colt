/**
 * 渲染层纯函数测试：ANSI 解析、diff 行分类、参数格式化。
 * 作者：陕耀云栈WorkMate
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAnsi } from "../src/renderer/src/lib/ansi.ts";
import { classifyDiffLine } from "../src/renderer/src/lib/diff.ts";
import { formatArgs } from "../src/renderer/src/lib/format.ts";

describe("parseAnsi", () => {
  test("无转义时返回单个原样片段", () => {
    assert.deepEqual(parseAnsi("hello world"), [{ text: "hello world", className: "" }]);
  });

  test("解析基本前景色", () => {
    const spans = parseAnsi("\u001B[31mred\u001B[0m");
    assert.deepEqual(spans, [
      { text: "red", className: "text-red-400" },
    ]);
  });

  test("重置后又回到无色", () => {
    const spans = parseAnsi("\u001B[32mG\u001B[0m plain");
    assert.equal(spans[0]?.className, "text-green-400");
    assert.equal(spans[1]?.className, "");
    assert.equal(spans[1]?.text, " plain");
  });

  test("加粗与颜色叠加", () => {
    const spans = parseAnsi("\u001B[1;33mX\u001B[0m");
    // 按码序处理：先 1（加粗）再 33（颜色），颜色追加在末尾
    assert.equal(spans[0]?.className, "font-bold text-yellow-400");
  });

  test("换色时旧颜色被替换而非累加", () => {
    const spans = parseAnsi("\u001B[31ma\u001B[32mb\u001B[0m");
    assert.equal(spans[0]?.className, "text-red-400");
    // 第二段不应同时含红与绿
    assert.equal(spans[1]?.className, "text-green-400");
  });

  test("空文本返回空数组", () => {
    assert.deepEqual(parseAnsi(""), []);
  });

  test("裸转义无文本产出空内容", () => {
    assert.deepEqual(parseAnsi("\u001B[0m"), []);
  });
});

describe("classifyDiffLine", () => {
  test("块头", () => {
    assert.equal(classifyDiffLine("@@ -1,3 +1,4 @@"), "hunk");
  });

  test("文件头优先于增删判定", () => {
    assert.equal(classifyDiffLine("+++ b/file.ts"), "meta");
    assert.equal(classifyDiffLine("--- a/file.ts"), "meta");
  });

  test("新增与删除", () => {
    assert.equal(classifyDiffLine("+added"), "add");
    assert.equal(classifyDiffLine("-removed"), "remove");
  });

  test("上下文行", () => {
    assert.equal(classifyDiffLine(" unchanged"), "context");
    assert.equal(classifyDiffLine(""), "context");
  });
});

describe("formatArgs", () => {
  test("美化合法 JSON", () => {
    assert.equal(formatArgs('{"a":1}'), '{\n  "a": 1\n}');
  });

  test("非法 JSON 原样返回", () => {
    assert.equal(formatArgs("not json"), "not json");
  });

  test("空串原样返回", () => {
    assert.equal(formatArgs(""), "");
  });
});
