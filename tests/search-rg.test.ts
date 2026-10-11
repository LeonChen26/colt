/**
 * ripgrep 后端的钉子，重点是**两个引擎结果一致**。
 *
 * 「同一个工具，装没装二进制会返回不同东西」是这类设计最坏的一种失败：它不会报错、
 * 不会变慢得离谱，只是**同一份查询在不同机器上给出不同答案**，而没人会想到去查这里。
 * 所以这里的花力气全在一致性上：argv 拼得对（`-e`、`--`）、JSON 解析对、路径相对化对，
 * 以及最后那条**真跑一遍两边对比**的用例。
 *
 * 纯函数部分（argv / JSON 解析）不依赖二进制，任何机器上都跑；
 * 端到端那条在没有 rg 时**跳过**并打一声招呼（跳过 ≠ 通过，但也不该让没拉二进制的
 * 检出变成红的——那是受支持的形态）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import {
  MAX_RG_STDOUT_BYTES,
  buildRgArgs,
  parseRgJson,
  parseRgJsonLine,
} from "../src/worker/lib/search-rg";
import { GREP_TOOL_NAME, createSearchTools } from "../src/worker/lib/search-tools";

/** 工具的 execute 只用到前两个参数；测试里直接按宽松形状调它 */
type LooseTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    onUpdate: unknown,
    toolContext: unknown,
    invocation: unknown,
    context: unknown,
  ) => Promise<{ content: { type: string; text?: string }[] }>;
};

describe("buildRgArgs", () => {
  test("`-e` 分隔模式：以 - 开头的模式不会被当成选项", () => {
    const args = buildRgArgs({ pattern: "--no-ignore", absolutePath: "E:/p" });
    const at = args.indexOf("-e");
    assert.ok(at >= 0, "必须有 -e");
    assert.equal(args[at + 1], "--no-ignore", "模式要跟在 -e 后面");
    assert.equal(args.at(-1), "E:/p");
  });

  test("末尾用 `--` 把路径与选项隔开", () => {
    const args = buildRgArgs({ pattern: "x", absolutePath: "E:/p" });
    assert.deepEqual(args.slice(-2), ["--", "E:/p"]);
  });

  test("必须带 --json（解析靠它）、--no-messages（别把警告混进 stdout）", () => {
    const args = buildRgArgs({ pattern: "x", absolutePath: "E:/p" });
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--no-messages"));
  });

  /**
   * `--no-require-git` 是**引擎一致性**的必需品，不是可选优化：
   * rg 默认只在 git 仓库里应用 `.gitignore`，而 Colt 会打开没有版本控制的项目目录——
   * 少了它，那些目录下 rg 会去搜构建产物、JS 那侧不会（实测踩到，夹具目录没有 `.git`）。
   */
  test("必须带 --no-require-git（否则非 git 目录下两个引擎分叉）", () => {
    const args = buildRgArgs({ pattern: "x", absolutePath: "E:/p" });
    assert.ok(args.includes("--no-require-git"), "少了它，非 git 目录里 .gitignore 不生效");
  });

  test("ignoreCase 与 glob 只在需要时加（`-g` 常驻是因为还有排除规则）", () => {
    const bare = buildRgArgs({ pattern: "x", absolutePath: "E:/p" });
    assert.ok(!bare.includes("-i"));
    // `-g` 常驻（SKIP_DIRS 的排除 + 点文件排除），故不能断言「没有 -g」——
    // 要断言的是**用户的 glob 没被当成选项传进去**
    assert.ok(!bare.includes("*.ts"));

    const full = buildRgArgs({
      pattern: "x",
      absolutePath: "E:/p",
      ignoreCase: true,
      glob: "*.ts",
    });
    assert.ok(full.includes("-i"));
    assert.deepEqual(full.slice(full.indexOf("-g"), full.indexOf("-g") + 2), ["-g", "*.ts"]);
  });

  /**
   * 两条排除规则都必须常驻，且都不是可选优化：
   *   - `-g '!<SKIP_DIRS 成员>'`：rg 不认识 JS 那侧的硬跳过名单，不传就会搜 node_modules；
   *   - `-g '!.*'`：**传了任何 `-g` 之后，rg 不再对白名单命中的隐藏文件生效**
   *     （实测 `-g '*.ts'` 会把 `.hidden-file.ts` 搜出来）。
   */
  test("硬跳过名单与点文件都翻译成排除 glob（否则两引擎分叉）", () => {
    const args = buildRgArgs({ pattern: "x", absolutePath: "E:/p" });
    for (const name of [".git", "node_modules", "out", "dist", ".next"]) {
      assert.ok(args.includes(`!${name}`), `少了 !${name}`);
    }
    assert.ok(args.includes("!.*"), "少了点文件排除");
  });

  test("空白 glob 当没给（不产生一个空的 -g，那会让 rg 报错）", () => {
    const args = buildRgArgs({ pattern: "x", absolutePath: "E:/p", glob: "   " });
    assert.ok(!args.includes(""), "不该有空的 -g 值");
    assert.ok(args.includes("--"), "路径仍要在 -- 之后");
  });
});

describe("parseRgJsonLine / parseRgJson", () => {
  const matchLine = JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/a.ts" },
      lines: { text: "const needle = 1;\n" },
      line_number: 7,
    },
  });

  test("match 事件取到 路径 / 行号 / 行内容", () => {
    assert.deepEqual(parseRgJsonLine(matchLine), {
      path: "src/a.ts",
      lineNumber: 7,
      text: "const needle = 1;",
    });
  });

  test("行尾换行被去掉（CRLF 也是）——否则输出会多出空行、且与 JS 那侧不一致", () => {
    const crlf = JSON.stringify({
      type: "match",
      data: { path: { text: "a.ts" }, lines: { text: "x\r\n" }, line_number: 1 },
    });
    assert.equal(parseRgJsonLine(crlf)?.text, "x");
    const noEol = JSON.stringify({
      type: "match",
      data: { path: { text: "a.ts" }, lines: { text: "y" }, line_number: 2 },
    });
    assert.equal(parseRgJsonLine(noEol)?.text, "y");
  });

  test("非 match 事件（begin/end/summary）一律跳过", () => {
    for (const type of ["begin", "end", "summary", "context"]) {
      assert.equal(parseRgJsonLine(JSON.stringify({ type, data: {} })), undefined);
    }
  });

  test("坏行 / 空行 / 形状不全都不抛错，只是被跳过", () => {
    assert.equal(parseRgJsonLine(""), undefined);
    assert.equal(parseRgJsonLine("   "), undefined);
    assert.equal(parseRgJsonLine("{ 这不是 JSON"), undefined);
    assert.equal(parseRgJsonLine(JSON.stringify({ type: "match", data: {} })), undefined);
    assert.equal(
      parseRgJsonLine(JSON.stringify({ type: "match", data: { path: { text: "a" } } })),
      undefined,
    );
  });

  test("多行一次解析，只挑出 match", () => {
    const text = [
      JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } }),
      matchLine,
      JSON.stringify({ type: "end", data: {} }),
    ].join("\n");
    const out = parseRgJson(text);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.lineNumber, 7);
  });

  test("stdout 上限是个正数且有界（防止有人把它改成 Infinity）", () => {
    assert.ok(Number.isFinite(MAX_RG_STDOUT_BYTES));
    assert.ok(MAX_RG_STDOUT_BYTES >= 1024 * 1024);
  });
});

/**
 * 一致性判据拆成两部分，因为**只有一部分该逐字相同**：
 *   - **正文**（命中行）必须逐字相同——那是「结果」，两边不同就是 bug；
 *   - **附注**里「过滤过」这句必须都有（逃生口的名字要能被模型看到），
 *     但**数目**允许不同：rg 不报「忽略了多少个文件」，JS 报。这是有意的精度差异，
 *     不是语义差异（我已就此在 `search-tools.ts` 的 `FILTER_NOTE` 注里写明取舍）。
 */
function splitBodyAndNotes(text: string): { body: string; notes: string } {
  const at = text.indexOf("\n\n(");
  if (at === -1) return { body: text, notes: "" };
  return { body: text.slice(0, at), notes: text.slice(at) };
}

describe("两个引擎结果一致（装了 rg 才跑）", () => {
  let root = "";
  // 本仓是 ESM（package.json 里 `"type": "module"`），**没有 `__dirname`**——
  // 用它会在「描述块求值」阶段直接抛，整套用例**一条都不跑**，而聚合行仍然写着 `fail 0`
  // （实测踩到：`not ok` 有、`# fail 0` 也有，两行并存）。这里按仓库既有做法用 import.meta.url。
  const rgPath = fileURLToPath(
    new URL(
      `../vendor/ripgrep/${process.platform}-${process.arch}/${process.platform === "win32" ? "rg.exe" : "rg"}`,
      import.meta.url,
    ),
  );
  const hasRg = existsSync(rgPath);

  async function run(pattern: string, extra: Record<string, unknown> = {}, withRg = hasRg) {
    const tools = createSearchTools(root, withRg ? { rgPath } : {}) as unknown as LooseTool[];
    const tool = tools.find((item) => item.name === GREP_TOOL_NAME);
    assert.ok(tool);
    const result = await tool.execute("c", { pattern, ...extra }, undefined, undefined, {}, {});
    return result.content.map((b) => b.text ?? "").join("");
  }

  before(() => {
    root = makeTempDir("colt-rg-parity-");
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(root, "ignored-dir"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".hidden-dir"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "ignored-dir/\n*.ignored.txt\n", "utf8");
    writeFileSync(join(root, ".ignore"), "also-ignored.txt\n", "utf8");
    writeFileSync(join(root, "src", "a.ts"), "alpha needle 1\nbeta\n", "utf8");
    writeFileSync(join(root, "src", "deep", "b.ts"), "gamma needle 2\n", "utf8");
    writeFileSync(join(root, "README.md"), "needle in readme\n", "utf8");
    writeFileSync(join(root, "drop.ignored.txt"), "needle ignored\n", "utf8");
    writeFileSync(join(root, "also-ignored.txt"), "needle also ignored\n", "utf8");
    writeFileSync(join(root, "ignored-dir", "x.ts"), "needle in ignored dir\n", "utf8");
    writeFileSync(join(root, "node_modules", "pkg", "y.js"), "needle in modules\n", "utf8");
    writeFileSync(join(root, ".hidden-dir", "z.ts"), "needle hidden\n", "utf8");
    writeFileSync(join(root, ".hidden-file.ts"), "needle hidden file\n", "utf8");
  });

  after(() => {
    removeTempDir(root);
  });

  test("两边的命中行逐字相同（过滤集合、路径格式、行号都对齐）", async (t) => {
    if (!hasRg) {
      t.diagnostic(`跳过：没有 ${rgPath}（跑 npm run rg:fetch 就有了）`);
      return;
    }
    const withRipgrep = await run("needle", {}, true);
    const pureJs = await run("needle", {}, false);
    assert.equal(
      splitBodyAndNotes(withRipgrep).body,
      splitBodyAndNotes(pureJs).body,
      "命中行必须逐字相同",
    );
    // 顺带确认「真的过滤了」：三个被忽略/隐藏的位置一个都不该出现
    assert.match(withRipgrep, /^src\/a\.ts:1:/m);
    for (const absent of ["drop.ignored.txt", "also-ignored.txt", "ignored-dir/", "node_modules/", ".hidden-dir/", ".hidden-file.ts"]) {
      assert.doesNotMatch(withRipgrep, new RegExp(absent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  test("带 glob 过滤时命中行也一致（`-g` 与隐藏文件的交互在此暴露）", async (t) => {
    if (!hasRg) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    const withRipgrep = await run("needle", { glob: "*.ts" }, true);
    const pureJs = await run("needle", { glob: "*.ts" }, false);
    assert.equal(splitBodyAndNotes(withRipgrep).body, splitBodyAndNotes(pureJs).body);
    assert.doesNotMatch(withRipgrep, /hidden-file/, "点文件在两个引擎里都该被跳过");
  });

  test("空结果时两边都说明「过滤过」并给出逃生口（数目允许不同）", async (t) => {
    if (!hasRg) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    const withRipgrep = await run("这个词不存在zzz", {}, true);
    const pureJs = await run("这个词不存在zzz", {}, false);
    assert.equal(splitBodyAndNotes(withRipgrep).body, splitBodyAndNotes(pureJs).body);
    for (const text of [withRipgrep, pureJs]) {
      assert.match(text, /没有匹配/);
      assert.match(text, /已按 \.gitignore 等忽略文件/);
      assert.match(text, /includeIgnored: true/, "两边都要给出逃生口");
    }
  });

  /**
   * 截断时**展示哪 200 条**允许不同（rg 并行遍历 vs JS 顺序遍历），但**报告的总数必须相同**
   * ——那是模型据此决定「要不要缩小范围」的依据，两边不一致等于在撒谎。
   * 这一条是把「可以接受的差异」与「不可接受的差异」划开的那条线。
   */
  test("截断时报告的总数必须一致（展示哪几条可以不同）", async (t) => {
    if (!hasRg) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    const many = Array.from({ length: 260 }, (_item, i) => `const bulk = ${i};`).join("\n");
    writeFileSync(join(root, "big-bulk.ts"), many, "utf8");
    try {
      const withRipgrep = await run("const bulk", {}, true);
      const pureJs = await run("const bulk", {}, false);
      const totalOf = (text: string) => (text.match(/共 (\d+) 条匹配/) ?? [])[1];
      assert.ok(totalOf(withRipgrep), "两边都该报告截断总数");
      assert.equal(totalOf(withRipgrep), totalOf(pureJs), "总数必须一致");
      assert.match(withRipgrep, /仅显示前 200 条/);
      assert.match(pureJs, /仅显示前 200 条/);
    } finally {
      rmSync(join(root, "big-bulk.ts"), { force: true });
    }
  });

  test("rg 的路径以 - 开头也没问题（-e 生效的实证）", async (t) => {
    if (!hasRg) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    const text = await run("--needs-dash", {}, true);
    assert.match(text, /没有匹配/, "不该把模式当成选项而报错");
  });
});
