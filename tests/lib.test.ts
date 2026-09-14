/**
 * 渲染层纯函数测试：ANSI 解析、diff 行分类、参数格式化、改动文件折树、⑥ 运行状态判定。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAnsi } from "../src/renderer/src/lib/ansi.ts";
import { classifyDiffLine } from "../src/renderer/src/lib/diff.ts";
import { formatArgs, runStateOf } from "../src/renderer/src/lib/format.ts";
import {
  buildFileTree,
  countTreeFiles,
  isProjectRelative,
} from "../src/renderer/src/lib/file-tree.ts";
import type { ViewFileChange } from "@shared/worker-protocol";

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

describe("runStateOf", () => {
  test("运行中优先于任何终态", () => {
    assert.equal(runStateOf(true, null), "running");
    assert.equal(runStateOf(true, { status: "failed", error: "boom" }), "running");
  });

  test("用户中断 → aborted", () => {
    assert.equal(runStateOf(false, { status: "aborted" }), "aborted");
  });

  test("异常结束 → failed（带着 / 不带 error 都算）", () => {
    assert.equal(runStateOf(false, { status: "failed", error: "请求超时" }), "failed");
    assert.equal(runStateOf(false, { status: "failed" }), "failed");
  });

  test("正常跑完与「还没跑过」一样回到空闲", () => {
    assert.equal(runStateOf(false, { status: "completed" }), "idle");
    assert.equal(runStateOf(false, null), "idle");
  });

  test("declined 不产生专门的终态（run 不会产出它）", () => {
    assert.equal(runStateOf(false, { status: "declined" }), "idle");
  });
});

/** 造一条改动记录；名字统一用小写，避免 localeCompare 在大小写上产生环境差异 */
const change = (path: string, timestamp = 0): ViewFileChange => ({
  id: path,
  path,
  kind: "edit",
  patch: null,
  addedLines: 1,
  removedLines: 0,
  timestamp,
});

describe("isProjectRelative", () => {
  test("项目内相对路径可用（含子目录、反斜杠）", () => {
    assert.equal(isProjectRelative("package.json"), true);
    assert.equal(isProjectRelative("src/main/a.ts"), true);
    assert.equal(isProjectRelative("src\\main\\a.ts"), true);
  });

  test("绝对路径不可用（四种写法）", () => {
    assert.equal(isProjectRelative("C:/x/y.txt"), false);
    assert.equal(isProjectRelative("C:\\x\\y.txt"), false);
    assert.equal(isProjectRelative("/tmp/x.txt"), false);
    assert.equal(isProjectRelative("\\\\server\\share\\x.txt"), false);
  });

  test(".. 逃逸不可用", () => {
    assert.equal(isProjectRelative("../x.txt"), false);
    assert.equal(isProjectRelative("a/../../b.txt"), false);
  });

  test("空白不可用", () => {
    assert.equal(isProjectRelative("   "), false);
    assert.equal(isProjectRelative(""), false);
  });
});

describe("buildFileTree", () => {
  test("根下文件平铺为文件节点", () => {
    const tree = buildFileTree([change("package.json"), change("readme.md")]);
    assert.deepEqual(
      tree.map((node) => [node.name, node.change !== undefined]),
      [
        ["package.json", true],
        ["readme.md", true],
      ],
    );
  });

  test("同目录文件折进同一个目录节点", () => {
    const tree = buildFileTree([change("src/a.ts"), change("src/b.ts")]);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.name, "src");
    assert.equal(tree[0]?.change, undefined);
    assert.deepEqual(
      tree[0]?.children.map((node) => node.name),
      ["a.ts", "b.ts"],
    );
  });

  test("多层目录逐段建链，叶子带上完整相对路径", () => {
    const tree = buildFileTree([change("src/main/ipc/index.ts")]);
    const leaf = tree[0]?.children[0]?.children[0]?.children[0];
    assert.equal(tree[0]?.name, "src");
    assert.equal(tree[0]?.children[0]?.name, "main");
    assert.equal(tree[0]?.children[0]?.children[0]?.name, "ipc");
    assert.equal(leaf?.path, "src/main/ipc/index.ts");
  });

  test("目录排在文件前面，同级按名字升序", () => {
    const tree = buildFileTree([change("zeta.ts"), change("alpha.ts"), change("docs/x.md")]);
    assert.deepEqual(
      tree.map((node) => node.name),
      ["docs", "alpha.ts", "zeta.ts"],
    );
  });

  test("绝对路径被排除——不可预览的条目不该出现在树里", () => {
    const tree = buildFileTree([
      change("C:\\other\\secret.txt"),
      change("/tmp/x.txt"),
      change("ok.ts"),
    ]);
    assert.deepEqual(
      tree.map((node) => node.name),
      ["ok.ts"],
    );
  });

  test(".. 逃逸被排除", () => {
    const tree = buildFileTree([change("../escape.txt"), change("a/../../b.txt"), change("ok.ts")]);
    assert.deepEqual(
      tree.map((node) => node.name),
      ["ok.ts"],
    );
  });

  test("反斜杠归一为层级", () => {
    const tree = buildFileTree([change("src\\main\\a.ts")]);
    assert.equal(tree[0]?.name, "src");
    assert.equal(tree[0]?.children[0]?.name, "main");
  });

  test("同一路径重复出现只保留最新一条", () => {
    const tree = buildFileTree([change("a.ts", 1), change("a.ts", 9)]);
    assert.equal(countTreeFiles(tree), 1);
    assert.equal(tree[0]?.change?.timestamp, 9);
  });

  test("空输入得到空树", () => {
    assert.deepEqual(buildFileTree([]), []);
  });

  test("countTreeFiles 统计可预览文件数", () => {
    const tree = buildFileTree([change("a.ts"), change("src/b.ts"), change("src/c.ts")]);
    assert.equal(countTreeFiles(tree), 3);
  });
});
