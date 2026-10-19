/**
 * `docs/wiki` 读取层的行为与边界。
 *
 * 这一层有两条不能松的东西，所以用例分两组写：
 *   1. **布局知识**：CodeWiki 的 hierarchical / flat 两种命名、`temp/` 不算页、
 *      缺树与坏 JSON 要如实报错（而不是显示成「没有 wiki」）；
 *   2. **安全边界**：入参来自渲染层，越界 / 非 md / `temp/` 必须在碰磁盘之前拒绝
 *      （与 `tests/file-read.test.ts` 同一套判据，只是根从项目根收紧到 wiki 目录）。
 *
 * 没有用例覆盖 git 新鲜度：那一段要么依赖本机 git 与仓库状态，要么就得在用例里
 * 造仓库——两者都会让结论随机器漂移。这里只钉「非仓库时 behind 必为 null」这条
 * 不会变的语义（`null` ≠ `0`，见 `WikiStatus.behind` 的注释）。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { readWikiPage, readWikiStatus } from "../src/main/wiki/read.ts";

let root = "";
let empty = "";
let broken = "";

/** 按 CodeWiki 的 hierarchical 布局铺一份最小产物 */
function writeFullWiki(base: string): void {
  const wiki = join(base, "docs", "wiki");
  mkdirSync(join(wiki, "主进程（Electron Main）"), { recursive: true });
  mkdirSync(join(wiki, "temp", "dependency_graphs"), { recursive: true });
  writeFileSync(
    join(wiki, "module_tree.json"),
    JSON.stringify({
      "主进程（Electron Main）": {
        components: [],
        path: "src/main",
        children: {
          "会话编排与 IPC": { components: ["src/main/session-manager.ts::SessionManager"] },
          // 树上登记了、但页面没生成出来（生成中断）——必须显示「无页面」而不是死条目
          "未生成": { components: ["src/main/ghost.ts::ghost"] },
        },
      },
      构建: { components: [] },
    }),
    "utf8",
  );
  writeFileSync(
    join(wiki, "metadata.json"),
    JSON.stringify({
      generation_info: { commit_id: "abc123", timestamp: "2026-10-17T22:03:43.924415" },
    }),
    "utf8",
  );
  writeFileSync(join(wiki, "overview.md"), "# 概览\n", "utf8");
  writeFileSync(join(wiki, "主进程（Electron Main）.md"), "# 主进程\n", "utf8");
  writeFileSync(join(wiki, "主进程（Electron Main）", "会话编排与 IPC.md"), "# 会话\n", "utf8");
  writeFileSync(join(wiki, "构建.md"), "# 构建\n", "utf8");
  // temp/ 里是中间产物：一个 md 也不该算进页面数
  writeFileSync(join(wiki, "temp", "note.md"), "# 中间产物\n", "utf8");
  writeFileSync(join(wiki, "temp", "dependency_graphs", "g.json"), "{}", "utf8");
}

before(() => {
  root = makeTempDir("colt-wiki-");
  empty = makeTempDir("colt-nowiki-");
  broken = makeTempDir("colt-badwiki-");
  writeFullWiki(root);
  // 根上放一个**真实存在**的 md：用来验证「仍在项目根内、但不在 wiki 目录」这条要被拒。
  // 不存在的话会先撞上 ENOENT，测的就不是边界而是「文件不存在」了。
  writeFileSync(join(root, "package.md"), "# 根上的文件\n", "utf8");
  mkdirSync(join(broken, "docs", "wiki"), { recursive: true });
  writeFileSync(join(broken, "docs", "wiki", "module_tree.json"), "{ 这不是 JSON", "utf8");
});

after(() => {
  removeTempDir(root, empty, broken);
});

describe("readWikiStatus：没生成是正常状态", () => {
  test("没有 docs/wiki → present=false，其余字段是确定的空值", async () => {
    const status = await readWikiStatus(empty);
    assert.equal(status.present, false);
    assert.equal(status.pages, 0);
    assert.deepEqual(status.tree, []);
    assert.equal(status.error, null);
    assert.equal(status.dir, "docs/wiki");
  });
});

describe("readWikiStatus：布局与缓存目录", () => {
  test("hierarchical 布局：父页与子页都能定位", async () => {
    const status = await readWikiStatus(root);
    assert.equal(status.present, true);
    const parent = status.tree.find((node) => node.title === "主进程（Electron Main）");
    assert.ok(parent !== undefined, "顶层模块应在树上");
    assert.equal(parent.page, "docs/wiki/主进程（Electron Main）.md");
    assert.equal(
      parent.children.find((node) => node.title === "会话编排与 IPC")?.page,
      "docs/wiki/主进程（Electron Main）/会话编排与 IPC.md",
    );
  });

  test("树上登记了却没有页面的模块 → page=null（界面据此显示「无页面」）", async () => {
    const status = await readWikiStatus(root);
    const ghost = status.tree[0]?.children.find((node) => node.title === "未生成");
    assert.ok(ghost !== undefined);
    assert.equal(ghost.page, null);
  });

  test("模块的组件清单从 module_tree 带出（页面跳源码的入口）", async () => {
    const status = await readWikiStatus(root);
    const module = status.tree[0]?.children.find((node) => node.title === "会话编排与 IPC");
    assert.deepEqual(module?.components, ["src/main/session-manager.ts::SessionManager"]);
    // 没有页面的模块也照样给出组件——页面缺失不该把「这一页讲什么」一起吞掉
    const ghost = status.tree[0]?.children.find((node) => node.title === "未生成");
    assert.deepEqual(ghost?.components, ["src/main/ghost.ts::ghost"]);
  });

  test("页面数是 *.md 且不含 temp/（4 页：overview + 两个模块页 + 子页）", async () => {
    const status = await readWikiStatus(root);
    assert.equal(status.pages, 4);
  });

  test("overview 与 metadata 都读出来了", async () => {
    const status = await readWikiStatus(root);
    assert.equal(status.overview, "docs/wiki/overview.md");
    assert.equal(status.commit, "abc123");
    assert.equal(status.generatedAt, "2026-10-17T22:03:43.924415");
    assert.equal(status.error, null);
  });

  test("非 git 目录：head 与 behind 都是 null（null ≠ 0，不能显示成「最新」）", async () => {
    const status = await readWikiStatus(root);
    assert.equal(status.behind, null);
    if (status.head === null) assert.equal(status.behind, null);
  });
});

describe("readWikiStatus：缺树 / 坏 JSON 要如实说", () => {
  test("JSON 损坏 → present 仍为 true，error 说清是哪个文件", async () => {
    const status = await readWikiStatus(broken);
    assert.equal(status.present, true);
    assert.ok(status.error !== null && status.error.includes("module_tree.json"));
    assert.deepEqual(status.tree, []);
  });

  test("只有页面、没有 module_tree.json → 仍能读到页数，error 提示没有导航", async () => {
    const bare = makeTempDir("colt-wiki-bare-");
    try {
      const wiki = join(bare, "docs", "wiki");
      mkdirSync(wiki, { recursive: true });
      writeFileSync(join(wiki, "overview.md"), "# 概览\n", "utf8");
      const status = await readWikiStatus(bare);
      assert.equal(status.present, true);
      assert.equal(status.pages, 1);
      assert.deepEqual(status.tree, []);
      assert.ok(status.error !== null && status.error.includes("module_tree.json"));
    } finally {
      removeTempDir(bare);
    }
  });
});

describe("readWikiPage：只读 wiki 目录里的 md", () => {
  test("正常读取", () => {
    const page = readWikiPage(root, "docs/wiki/overview.md");
    assert.equal(page.path, "docs/wiki/overview.md");
    assert.ok(page.text.includes("概览"));
    assert.ok(page.size > 0);
  });

  test("根内绝对路径也照收（工具链里常见，与 file.read 同口径）", () => {
    const absolute = join(root, "docs", "wiki", "overview.md");
    assert.ok(readWikiPage(root, absolute).text.includes("概览"));
  });

  test("跳出项目根 → 拒绝", () => {
    assert.throws(() => readWikiPage(root, "../secret.md"), /越界/);
  });

  test("仍在项目根、但跳到 wiki 外 → 拒绝（根收紧到 wiki 目录）", () => {
    assert.throws(() => readWikiPage(root, "docs/../package.md"), /越界/);
  });

  test("temp/ 里的 md 不是页面 → 拒绝", () => {
    assert.throws(() => readWikiPage(root, "docs/wiki/temp/note.md"), /temp/);
  });

  test("非 .md → 拒绝（不给依赖图这类 JSON 开后门）", () => {
    assert.throws(
      () => readWikiPage(root, "docs/wiki/temp/dependency_graphs/g.json"),
      /\.md/,
    );
  });
});
