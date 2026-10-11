/**
 * `search-tools.ts` 的行为钉子：grep / glob 两个只读工具。
 *
 * 这个模块的失败方式是**静默且危险**的两头：
 *   - 边界守不住（接受绝对路径 / `..`）→ 模型能读到项目外的文件，而只读白名单
 *     **放行时不看路径**，没有任何别的机制会拦它；
 *   - 输出不封顶 → 一次检索吃掉整个上下文预算，而工具调用本身报「成功」。
 * 两者都不会让 typecheck 或别的测试变红，故逐条钉在**真实目录夹具**上（不碰本仓库）。
 *
 * 夹具刻意包含 `.git` / `node_modules` / 二进制文件与一个 250 行的文件：
 * 跳过规则与截断标注属于「说的和做的一致」，不测就等于没有。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  MAX_FILE_BYTES,
  MAX_GREP_MATCHES,
  createSearchTools,
  globToRegExp,
  resolveInRoot,
} from "../src/worker/lib/search-tools";

let root = "";

/** 250 行同一个词，专供截断用例（用别的词，免得污染其余用例的匹配数） */
const MANY_LINES = 250;

before(() => {
  root = makeTempDir("colt-search-");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "docs", "sub"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });

  writeFileSync(join(root, "src", "a.ts"), "const needle = 1;\nconst other = 2;\n", "utf8");
  writeFileSync(join(root, "src", "deep", "b.ts"), "export const needle2 = 3;\n", "utf8");
  writeFileSync(join(root, "README.md"), "# needle at root\n", "utf8");
  writeFileSync(join(root, "docs", "readme.md"), "# needle doc\n", "utf8");
  writeFileSync(join(root, "docs", "sub", "c.md"), "# needle deep doc\n", "utf8");
  writeFileSync(join(root, "notes.txt"), "needle text\n", "utf8");
  writeFileSync(join(root, ".git", "config"), "needle in git\n", "utf8");
  writeFileSync(join(root, "node_modules", "pkg", "x.js"), "needle in modules\n", "utf8");
  // 二进制：前 8KB 里带 NUL 字节，按约定整份跳过
  writeFileSync(join(root, "bin.dat"), Buffer.from("needle\0binary\n", "utf8"));
  writeFileSync(
    join(root, "many.ts"),
    Array.from({ length: MANY_LINES }, (_item, index) => `MANY line ${index}`).join("\n"),
    "utf8",
  );
  // 超过单文件上限的那个（8MB+）：内容里也有 needle，但必须整份跳过并**计数**
  writeFileSync(
    join(root, "huge.log"),
    `needle at the very start\n${"x".repeat(MAX_FILE_BYTES + 1024)}`,
    "utf8",
  );
  // —— gitignore 过滤的夹具（用独立的词 `ignoredword`，免得污染上面的匹配数）——
  writeFileSync(join(root, ".gitignore"), "ignored-dir/\n*.ignored.txt\n!keep.ignored.txt\n", "utf8");
  mkdirSync(join(root, "ignored-dir"), { recursive: true });
  writeFileSync(join(root, "ignored-dir", "inside.ts"), "ignoredword inside dir\n", "utf8");
  writeFileSync(join(root, "drop.ignored.txt"), "ignoredword in ignored file\n", "utf8");
  // 反选：同一后缀但以 ! 放行，必须仍被搜到
  writeFileSync(join(root, "keep.ignored.txt"), "ignoredword in kept file\n", "utf8");
  // `.ignore` 的优先级高于 .gitignore：这里把上面忽略掉的一个文件重新放行
  writeFileSync(join(root, ".ignore"), "!again.ignored.txt\n", "utf8");
  writeFileSync(join(root, "again.ignored.txt"), "ignoredword via .ignore override\n", "utf8");
  // 子目录里的 ignore 文件：只作用于该子树
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", ".gitignore"), "local.txt\n", "utf8");
  writeFileSync(join(root, "sub", "local.txt"), "ignoredword sub-local\n", "utf8");
  writeFileSync(join(root, "sub", "kept.txt"), "ignoredword sub-kept\n", "utf8");
  writeFileSync(join(root, "local.txt"), "ignoredword at root (不该被子目录规则影响)\n", "utf8");
});

after(() => {
  removeTempDir(root);
});

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

async function run(name: string, params: Record<string, unknown>): Promise<string> {
  const tools = createSearchTools(root) as unknown as LooseTool[];
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `没有名为 ${name} 的工具`);
  const result = await tool.execute("call-1", params, undefined, undefined, {}, {});
  return result.content.map((block) => block.text ?? "").join("");
}

/** 同 `run`，但把「最多扫几个文件」压到很低，用来造「仓库过大」这个前提 */
async function runLimited(
  name: string,
  params: Record<string, unknown>,
  maxScannedFiles: number,
): Promise<string> {
  const tools = createSearchTools(root, { maxScannedFiles }) as unknown as LooseTool[];
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `没有名为 ${name} 的工具`);
  const result = await tool.execute("call-1", params, undefined, undefined, {}, {});
  return result.content.map((block) => block.text ?? "").join("");
}

describe("grep：命中格式与范围", () => {
  test("返回 `相对路径:行号:行内容`，路径用 / 分隔", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "needle" });
    // 行号与正文都要真的对得上（只给路径的话模型还得再 read 一遍才知道改哪一行）
    assert.match(text, /^src\/a\.ts:1:const needle = 1;$/m);
    assert.match(text, /^src\/deep\/b\.ts:1:export const needle2 = 3;$/m);
    assert.match(text, /^docs\/sub\/c\.md:1:# needle deep doc$/m);
    assert.doesNotMatch(text, /\\/, "路径一律用正斜杠，Windows 上也不许出现反斜杠");
  });

  test("glob 只匹配文件名时，任意层级的 ts 都被搜到，别的类型不出现", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "needle", glob: "*.ts" });
    assert.match(text, /src\/a\.ts:1:/);
    assert.match(text, /src\/deep\/b\.ts:1:/);
    assert.doesNotMatch(text, /notes\.txt/);
    assert.doesNotMatch(text, /readme\.md/);
  });

  test("grep 的 glob 含 / 时按相对路径匹配（能锁定单个目录）", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "needle", glob: "docs/**/*.md" });
    assert.match(text, /docs\/readme\.md:1:/);
    assert.match(text, /docs\/sub\/c\.md:1:/);
    assert.doesNotMatch(text, /README\.md/);
  });

  test("ignoreCase 生效与不生效的差别是真的", async () => {
    const caseSensitive = await run(GREP_TOOL_NAME, { pattern: "NEEDLE" });
    assert.match(caseSensitive, /没有匹配/);
    const insensitive = await run(GREP_TOOL_NAME, { pattern: "NEEDLE", ignoreCase: true });
    assert.match(insensitive, /src\/a\.ts:1:/);
  });
});

describe("grep：路径边界（只读白名单放行时不看路径，边界只能由本工具自己守）", () => {
  test("绝对路径被拒且返回结构化错误，不抛异常", async () => {
    for (const bad of [join(root, "src", "a.ts"), "C:/outside/a.ts", "\\\\server\\share\\x"]) {
      const text = await run(GREP_TOOL_NAME, { pattern: "needle", path: bad });
      assert.match(text, /^错误：/, `应回结构化错误：${text}`);
      assert.match(text, /相对路径/);
    }
  });

  test("`..` 出现在任何一段都被拒", async () => {
    for (const bad of ["../outside", "src/../../outside", ".."]) {
      const text = await run(GREP_TOOL_NAME, { pattern: "needle", path: bad });
      assert.match(text, /^错误：/);
      assert.match(text, /\.\./);
    }
  });

  test("resolveInRoot 落在项目根之内，越界的拼接结果一律拒绝", () => {
    const inside = resolveInRoot(root, "src/deep");
    assert.equal(inside.ok, true);
    if (inside.ok) assert.equal(inside.rel, "src/deep");
    assert.equal(resolveInRoot(root, "..").ok, false);
    assert.equal(resolveInRoot(root, "/etc").ok, false);
  });

  test("路径不存在时给一句能照着改的错误，而不是空结果", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "needle", path: "nope" });
    assert.match(text, /^错误：路径不存在/);
  });
});

describe("grep：错误与封顶", () => {
  test("正则不合法返回结构化错误、不 throw", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "([unclosed" });
    assert.match(text, /^错误：正则不合法/);
  });

  test(`超过 ${MAX_GREP_MATCHES} 条时截断，并在末尾标注匹配总数`, async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "MANY" });
    const matched = text.split("\n").filter((line) => line.startsWith("many.ts:"));
    assert.equal(matched.length, MAX_GREP_MATCHES);
    assert.match(text, /已截断/);
    assert.match(text, new RegExp(`共 ${MANY_LINES} 条匹配`));
  });

  test("扫到文件数上限时停手，并明确说「结果不完整、总数只是下限」", async () => {
    // 上限压到 1：无论从哪个文件开始，都必然扫不完
    const text = await runLimited(GREP_TOOL_NAME, { pattern: "needle" }, 1);
    assert.match(text, /结果不完整/, "必须明说这份结果不完整");
    assert.match(text, /只扫描了前 1 个文件/, "要报出实际扫了多少、上限多少");
    assert.match(text, /至少 \d+ 条匹配/, "总数降级成下限，不能再说「共 N 条」");
    assert.doesNotMatch(text, /共 \d+ 条匹配/, "扫不完整时不许给一个像确定值的总数");
    assert.match(text, /缩小范围/, "要给出下一步怎么做");
  });

  test("「扫到一半」与「匹配超量」是两件不同的事，不许混成一句", async () => {
    const exhausted = await runLimited(GREP_TOOL_NAME, { pattern: "MANY" }, 1);
    assert.match(exhausted, /结果不完整/);
    assert.doesNotMatch(exhausted, /已截断：/);
  });

  test("上限没到时行为不变（默认路径不被这条新限制影响）", async () => {
    const text = await runLimited(GREP_TOOL_NAME, { pattern: "needle" }, 1000);
    assert.match(text, /^src\/a\.ts:1:/m);
    assert.doesNotMatch(text, /结果不完整/);
  });

  test("一个文件都没匹配、且扫不完时，「没有匹配」也要带上不确定性说明", async () => {
    // 上限 1 + 一个在根目录（排序靠后）必然扫不到的模式
    const text = await runLimited(GREP_TOOL_NAME, { pattern: "绝对不存在的词" }, 1);
    assert.match(text, /没有匹配/);
    assert.match(text, /结果不完整/, "没扫完就说「没有匹配」是撒谎");
  });

  test("glob 扫不完时明确报错（绝不回一份看似完整、实则缺文件的清单）", async () => {
    const text = await runLimited(GLOB_TOOL_NAME, { pattern: "**/*.ts" }, 1);
    assert.match(text, /^错误：/);
    assert.match(text, /缩小范围/);
  });
});

describe("grep：噪声与二进制", () => {
  test(".git / node_modules 下的文件不出现在结果里", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "needle" });
    assert.doesNotMatch(text, /\.git\//);
    assert.doesNotMatch(text, /node_modules\//);
  });

  test("二进制文件被跳过，且跳过数量如实标注", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "needle" });
    assert.doesNotMatch(text, /bin\.dat/);
    assert.match(text, /已跳过 1 个二进制文件/);
  });

  /**
   * 超过单文件上限的要**整份跳过并计数**，而不是读进来再丢。
   *
   * 这一条盯的是「说的和做的一致」：跳过是承诺，计数是「如实」（不静默丢）。
   * ⚠️ 它**测不出**「先 stat 再 read」这个顺序本身——顺序只影响耗时，两种写法都跳过该文件。
   * 那个顺序由 `scanFile` 的注释与这次的实测基准（全仓 3618ms → 1342ms）守着；
   * 想用单测钉住它，得有「文件读得慢」这种可观测假设，那会变成脆弱的计时断言。
   */
  test(`超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 的文件整份跳过并计入「已跳过」`, async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "needle" });
    assert.doesNotMatch(text, /huge\.log/, "超大文件不该出现在结果里");
    assert.match(text, /已跳过 1 个超过 8MB 的文件/);
  });

  test("超大文件里的匹配**不计入**「共 N 条」（它根本没被扫）", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "needle at the very start" });
    assert.match(text, /没有匹配/, "唯一含这行的是那个被跳过的超大文件");
    assert.match(text, /已跳过 1 个超过 8MB 的文件/, "跳过的事实要跟着说出来");
  });
});

describe("gitignore 过滤（默认开、可关、且如实报数）", () => {
  test("被忽略的**目录**不下沉：`.gitignore` 里的 `ignored-dir/` 命中的文件搜不到", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "ignoredword" });
    assert.doesNotMatch(text, /ignored-dir\//, "被忽略的目录整棵不该出现");
    assert.doesNotMatch(text, /drop\.ignored\.txt/, "被 *.ignored.txt 命中的文件不该出现");
  });

  test("反选（`!`）生效：被 .gitignore 放行的同名文件照样搜得到", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "ignoredword" });
    assert.match(text, /^keep\.ignored\.txt:1:/m, "`!keep.ignored.txt` 必须把它救回来");
  });

  test("`.ignore` 的优先级高于 `.gitignore`（内核与 ripgrep 同一口径）", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "ignoredword" });
    assert.match(text, /^again\.ignored\.txt:1:/m, "`.ignore` 的反选应盖过 .gitignore 的忽略");
  });

  test("子目录里的 ignore 规则只作用于该子树", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "ignoredword" });
    assert.doesNotMatch(text, /^sub\/local\.txt:/m, "sub/.gitignore 的 local.txt 应被忽略");
    assert.match(text, /^sub\/kept\.txt:1:/m, "同一子目录里的别的文件不受影响");
    assert.match(
      text,
      /^local\.txt:1:/m,
      "根目录同名文件不该被**子目录**的规则连坐（前缀化就是为这件事）",
    );
  });

  test("跳过多少会**如实报数**，并指出逃生口的名字", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "ignoredword" });
    assert.match(text, /已按 \.gitignore 等忽略文件跳过 \d+ 项/);
    assert.match(text, /其中目录 \d+ 个/);
    assert.match(text, /includeIgnored: true/, "要给出下一步怎么做，否则模型不知道还能打开");
  });

  test("没有命中、且确实被过滤过时，「没有匹配」也要带上过滤说明", async () => {
    // 这个词只在被忽略的文件里出现：默认搜不到，但必须说明「是被过滤了，不是不存在」
    const text = await run(GREP_TOOL_NAME, { pattern: "只在drop文件里出现的词" });
    assert.match(text, /没有匹配/);
    assert.match(text, /已按 \.gitignore 等忽略文件跳过/);
  });

  test("includeIgnored: true 连被忽略的一起搜", async () => {
    const text = await run(GREP_TOOL_NAME, { pattern: "ignoredword", includeIgnored: true });
    assert.match(text, /^drop\.ignored\.txt:1:/m);
    assert.match(text, /^ignored-dir\/inside\.ts:1:/m);
    assert.doesNotMatch(text, /已按 \.gitignore/, "全搜时不该再报「跳过了多少」");
  });

  test("glob 同样过滤，且报数口径一致", async () => {
    const filtered = await run(GLOB_TOOL_NAME, { pattern: "**/*.ignored.txt" });
    assert.doesNotMatch(filtered, /drop\.ignored\.txt/);
    assert.match(filtered, /^keep\.ignored\.txt$/m, "反选放行的要留下");
    assert.match(filtered, /已按 \.gitignore 等忽略文件跳过/);

    const all = await run(GLOB_TOOL_NAME, {
      pattern: "**/*.ignored.txt",
      includeIgnored: true,
    });
    assert.match(all, /^drop\.ignored\.txt$/m);
  });

  test("单文件检索不过滤（模型点名要看的文件就该看到）", async () => {
    const text = await run(GREP_TOOL_NAME, {
      pattern: "ignoredword",
      path: "drop.ignored.txt",
    });
    assert.match(text, /^drop\.ignored\.txt:1:/m, "显式指定被忽略的文件时仍然要搜");
  });
});

describe("glob：跨目录语义与截断", () => {
  test("`**` 能跨目录（含零层目录），`*` 不跨目录", async () => {
    const deep = await run(GLOB_TOOL_NAME, { pattern: "**/*.md" });
    assert.match(deep, /^README\.md$/m);
    assert.match(deep, /^docs\/readme\.md$/m);
    assert.match(deep, /^docs\/sub\/c\.md$/m);

    const shallow = await run(GLOB_TOOL_NAME, { pattern: "*.md" });
    assert.match(shallow, /^README\.md$/m);
    assert.doesNotMatch(shallow, /docs\//);
  });

  test("分支模式与目录起始位置", async () => {
    const brace = await run(GLOB_TOOL_NAME, { pattern: "*.{json,md}" });
    assert.match(brace, /^README\.md$/m);

    const scoped = await run(GLOB_TOOL_NAME, { pattern: "**/*.ts", path: "src" });
    assert.match(scoped, /^src\/a\.ts$/m);
    assert.match(scoped, /^src\/deep\/b\.ts$/m);
    assert.doesNotMatch(scoped, /many\.ts/);
  });

  test("glob 同样受路径边界约束，并跳过噪声目录", async () => {
    const escaped = await run(GLOB_TOOL_NAME, { pattern: "**/*.js", path: "../outside" });
    assert.match(escaped, /^错误：/);
    const all = await run(GLOB_TOOL_NAME, { pattern: "**/*" });
    assert.doesNotMatch(all, /node_modules\//);
    assert.doesNotMatch(all, /\.git\//);
  });

  test("没有命中时说没有命中，而不是回空串", async () => {
    const text = await run(GLOB_TOOL_NAME, { pattern: "**/*.zzz" });
    assert.match(text, /没有匹配的文件/);
  });
});

describe("globToRegExp：最小模式集的边界", () => {
  test("`?` 只吃单段内一个字符", () => {
    assert.equal(globToRegExp("a?c").test("abc"), true);
    assert.equal(globToRegExp("a?c").test("a/c"), false);
    assert.equal(globToRegExp("a?c").test("ac"), false);
  });

  test("`*` 不吃 `/`，`**` 吃", () => {
    assert.equal(globToRegExp("src/*.ts").test("src/a/b.ts"), false);
    assert.equal(globToRegExp("src/**/*.ts").test("src/a/b.ts"), true);
    assert.equal(globToRegExp("src/**/*.ts").test("src/b.ts"), true, "**/ 应能匹配零层目录");
  });

  test("正则元字符按字面匹配（模式里写 . 不该变成任意字符）", () => {
    assert.equal(globToRegExp("a.ts").test("aXts"), false);
    assert.equal(globToRegExp("a.ts").test("a.ts"), true);
  });
});
