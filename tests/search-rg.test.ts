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
  DEFAULT_RG_TIMEOUT_MS,
  MAX_RG_STDOUT_BYTES,
  buildRgArgs,
  parseRgJson,
  parseRgJsonLine,
  rgFailureKind,
  runRipgrep,
} from "../src/worker/lib/search-rg";
import { GREP_TOOL_NAME, createSearchTools } from "../src/worker/lib/search-tools";

/** 随包（开发机上是 `npm run rg:fetch` 拉进 vendor 的）rg 路径 */
function vendoredRgPath(): string {
  return fileURLToPath(
    new URL(
      `../vendor/ripgrep/${process.platform}-${process.arch}/${process.platform === "win32" ? "rg.exe" : "rg"}`,
      import.meta.url,
    ),
  );
}

/** 工具的 execute 只用到 args（durable 签名是 `(args, api, context)`） */
type LooseTool = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<{ output?: { type: string; text?: string }[] }>;
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
    const result = await tool.execute({ pattern, ...extra });
    return (result.output ?? []).map((b) => b.text ?? "").join("");
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

  test("含目录前缀的 glob + 子目录 path：两边必须一致（钉住「-g 相对 cwd」这个前提）", async (t) => {
    if (!hasRg) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    // 这一条的真正作用是钉住 **spawn 的 cwd 必须是项目根**：
    // rg 的 `-g` 相对进程 cwd 匹配，我们的 glob 相对项目根匹配（`window.rel`）。
    // 两边现在一致，只因为 `runRipgrep(..., cwd)` 传的是 root ——那不是巧合，是前提。
    // 若有人把 cwd 改成搜索的子目录（看起来更「自然」），rg 会对 `src/*.tsx` 一条都不返回，
    // 而 JS 照旧命中 `src/b.tsx` —— 本用例会红。
    for (const glob of ["src/*.ts", "src/**/*.ts", "**/a.ts"]) {
      const withRipgrep = await run("needle", { path: "src", glob }, true);
      const pureJs = await run("needle", { path: "src", glob }, false);
      assert.equal(
        splitBodyAndNotes(withRipgrep).body,
        splitBodyAndNotes(pureJs).body,
        `path=src + glob=${glob} 两个引擎给出了不同结果（cwd 锚定变了？）`,
      );
    }
    // 反向确认：不是「两边都为空」凑出来的一致
    const hit = await run("needle", { path: "src", glob: "src/**/*.ts" }, true);
    assert.match(hit, /^src\/a\.ts:1:/m, "该形态必须真的命中，否则上面的一致性断言是空转");
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

  test('以 `!` 开头的 glob 两边必须一致（我们对它是字面量，rg 对它是排除）', async (t) => {
    if (!hasRg) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    // `!*.md`：内置实现按字面量匹配（没有文件叫这个名字 → 没有匹配），
    // rg 会把 -g '!*.md' 当成「排除 .md」→ 返回其余全部命中。实测分叉过，
    // 现在的做法是这一路**不走快路径**，于是两边都按字面量语义给答案。
    const withRipgrep = await run("needle", { glob: "!*.md" }, true);
    const pureJs = await run("needle", { glob: "!*.md" }, false);
    assert.equal(splitBodyAndNotes(withRipgrep).body, splitBodyAndNotes(pureJs).body);
    assert.match(withRipgrep, /没有匹配/, "两边都该是「没有匹配」，而不是 rg 那套「排除 .md」的语义");
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

/**
 * 失败要**分性质**——这是这一轮 review 抓出来的实质缺陷。
 *
 * 原先三种失败（进程起不来 / 这次查询不被接受 / 跑太久）一律 latch 成「ripgrep 不可用」。
 * 实测后果：**一个 `(?=x)`（JS 正则合法、Rust 正则不支持）就把整个会话的快路径关掉**，
 * 之后连搜普通词都退化到纯 JS；而日志写着「ripgrep 不可用」——它在撒谎，rg 好好的。
 */
describe("调用失败的原因要分开（kind），别让一次坏查询变成永久降级", () => {
  let root = "";

  before(() => {
    root = makeTempDir("colt-rg-fail-");
  });
  after(() => {
    removeTempDir(root);
  });

  test("二进制不存在 → kind = spawn（三种里唯一该 latch 的一种）", async () => {
    await assert.rejects(
      () => runRipgrep(join(root, "no-such-dir", "rg.exe"), ["--version"], root, 5_000),
      (error: unknown) => rgFailureKind(error) === "spawn",
    );
  });

  test("超时 → kind = timeout，且**有界**（子进程还要跑 30 秒，我们必须早于它返回）", async () => {
    const started = Date.now();
    await assert.rejects(
      // 用 node 自己扮「一个永不返回的程序」：跨平台，且不依赖机器上真有 rg
      () => runRipgrep(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], root, 300),
      (error: unknown) => rgFailureKind(error) === "timeout",
    );
    assert.ok(Date.now() - started < 5_000, "该在上限附近就返回，而不是陪着子进程等完");
  });

  test("超时必须**真的杀掉**子进程，而不是「我们不再听它」", async () => {
    // 判据：让子进程在「超时之后」写一个文件。若它还能写出来，说明我们只是不再听它，
    // 每次超时都会漏一个孤儿进程 —— 而工具没有取消信号，这些孤儿会一直占着 I/O。
    const marker = join(root, "child-survived.txt");
    const script =
      `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1200);` +
      `setTimeout(() => {}, 8000);`;
    await assert.rejects(
      () => runRipgrep(process.execPath, ["-e", script], root, 300),
      (error: unknown) => rgFailureKind(error) === "timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(existsSync(marker), false, "子进程活过了超时（没被杀掉）");
  });

  test("rg 拒绝该查询（退出码 2）→ kind = exit，**不是** spawn", async (t) => {
    const rgPath = vendoredRgPath();
    if (!existsSync(rgPath)) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    // lookahead：JS 正则接受、Rust 正则不支持（实测退出码 2）
    await assert.rejects(
      () => runRipgrep(rgPath, buildRgArgs({ pattern: "(?=needle)", absolutePath: root }), root, 10_000),
      (error: unknown) => rgFailureKind(error) === "exit",
    );
  });

  test("不是我们抛的错就读不出 kind（结构判别，刻意不用 instanceof）", () => {
    assert.equal(rgFailureKind(new Error("别的错")), undefined);
    assert.equal(rgFailureKind(undefined), undefined);
    assert.equal(rgFailureKind({ kind: "随便一个值" }), undefined);
    assert.equal(DEFAULT_RG_TIMEOUT_MS > 0, true);
  });
});

/**
 * 降级的**作用范围**：只该影响该影响的东西。
 *
 * 两条都走同一个工具实例（`createSearchTools` 建的那个）——用「新建实例」来断言等于没测：
 * 新实例天然是干净的，模块级 latch 也会「看起来正常」。用附注文本分辨引擎：
 * 内置实现会说明「未启动 / 不接受该写法」，快路径没跑成时才会出现那句。
 */
describe("快路径降级的范围", () => {
  let root = "";

  before(() => {
    root = makeTempDir("colt-rg-scope-");
    writeFileSync(join(root, "a.ts"), "needle one\n", "utf8");
  });
  after(() => {
    removeTempDir(root);
  });

  /** 同一个工具实例上的多次检索（这正是 latch 语义能被观察到的前提） */
  function toolWith(options: Record<string, unknown>): (pattern: string) => Promise<string> {
    const tools = createSearchTools(root, options) as unknown as LooseTool[];
    const tool = tools.find((item) => item.name === GREP_TOOL_NAME);
    assert.ok(tool);
    return async (pattern: string) => {
      const result = await tool.execute({ pattern });
      return (result.output ?? []).map((b) => b.text ?? "").join("");
    };
  }

  test("起不来 → 只留一次痕（latch 的意义），且结果照样给得出来", async () => {
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    let results: string[] = [];
    try {
      const run = toolWith({ rgPath: join(root, "no-such-dir", "rg.exe") });
      results = [await run("needle"), await run("needle"), await run("needle")];
    } finally {
      console.error = original;
    }
    assert.equal(lines.length, 1, "三次检索只该报一次「不可用」——否则每次都白等一次注定失败的 spawn");
    assert.match(lines[0]!, /不可用/);
    for (const text of results) assert.match(text, /needle one/, "降级不是错误：结果必须照给");
  });

  test("rg 拒绝某次查询之后，**同一实例**的后续查询仍走快路径", async (t) => {
    const rgPath = vendoredRgPath();
    if (!existsSync(rgPath)) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    const run = toolWith({ rgPath });
    const bad = await run("(?=needle)");
    assert.match(bad, /内置实现/, "这次该由内置实现补上，并说明原因");
    assert.match(bad, /needle one/, "内置实现照样处理 lookahead——结果不该丢");
    const next = await run("needle");
    assert.doesNotMatch(
      next,
      /内置实现/,
      "后续查询必须还走快路径：一个坏正则不该换来整个会话的降级（修复前这条会红）",
    );
  });

  test("latch 只属于出问题的那个实例，不是模块级全局", async (t) => {
    const rgPath = vendoredRgPath();
    if (!existsSync(rgPath)) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    const broken = toolWith({ rgPath: join(root, "no-such-dir", "rg.exe") });
    await broken("needle");
    await broken("needle");
    const healthy = toolWith({ rgPath });
    assert.doesNotMatch(
      await healthy("needle"),
      /内置实现/,
      "另一个实例该重新尝试 rg（latch 写成模块级全局时这条会红：单测之间也会互相污染）",
    );
  });

  test("stdout 上限真的生效：超量时提前收工、总数降级成「至少 N 条」", async (t) => {
    const rgPath = vendoredRgPath();
    if (!existsSync(rgPath)) {
      t.diagnostic("跳过：没有 rg 二进制");
      return;
    }
    // 这是全工具**唯一一处读入无上界**的路径：为了报出「共 N 条」得读完 rg 的输出，
    // 而一次宽泛查询能吐几十万条。所以必须有这条端到端验证（此前只有常量断言）。
    // 量要够：rg 的 JSON 约是原始文本的 4～5 倍，故取上限的一半做原始文本，留一倍余量。
    const line = `needle ${"x".repeat(60)}\n`;
    const lines = Math.ceil(MAX_RG_STDOUT_BYTES / 2 / Buffer.byteLength(line));
    const bulk = join(root, "bulk.ts");
    writeFileSync(bulk, line.repeat(lines), "utf8");
    try {
      const text = await toolWith({ rgPath })("needle");
      assert.match(text, /结果不完整：输出过大/, "该走「读不完」那条诚实措辞，而不是假装扫完了");
      assert.match(text, /至少 \d+ 条匹配/, "总数必须降级成下限（它没有读完 stdout）");
      assert.match(text, /仅显示前 200 条/);
      const shown = text.split("\n\n(")[0].split("\n").filter((l) => l !== "");
      assert.equal(shown.length, 200, "展示条数仍受 MAX_GREP_MATCHES 约束");
      assert.ok(
        Buffer.byteLength(text) < 200 * 1024,
        `返回给模型的文本必须仍然很小（实测 ${(Buffer.byteLength(text) / 1024).toFixed(0)}KB）`,
      );
    } finally {
      rmSync(bulk, { force: true });
    }
  });
});
