/**
 * 仓库 Wiki 的**布局规则**（`@shared/wiki-tree`）与**注入块**（`@shared/wiki-map`）。
 *
 * 这两块以前散在 `main/wiki/read.ts` 里，现在被主进程读取与 worker 提示词注入共用，
 * 于是「错了也没人报」的代价变高了，得单独钉住：
 *
 * 1. **布局**：hierarchical 优先、flat 兜底——两种布局并存时选信息更全的那个；
 *    页面不存在的节点要留在树上（`page: null`），否则纯分组节点会整枝消失。
 * 2. **新鲜度**：`null`（不知道）与 `0`（一致）必须说成两句话。把不知道说成最新，
 *    就是这个功能最贵的一种撒谎。
 * 3. **预算**：截断必须写出「还剩多少页」。静默裁掉会让模型以为 wiki 只覆盖了前几块。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { renderWikiMap, WIKI_MAP_BUDGET_CHARS } from "@shared/wiki-map";
import { buildWikiTree, flattenWikiPages, pageCandidates } from "@shared/wiki-tree";
import { createWikiMapInjector } from "../src/worker/lib/wiki-map.ts";

/** 造一棵最小树：`{ 父: { children: { 子: {} } }, 平铺: {} }` */
const RAW = {
  父: { children: { 子: {}, 无页子: {} } },
  平铺: {},
};

/** hierarchical 布局：`父/子.md` 存在；`父/无页子.md` 与 `父.md` 不存在 */
const HIERARCHICAL = new Set(["父/子.md", "平铺.md"]);

describe("布局规则：页面路径", () => {
  test("hierarchical 优先于 flat", () => {
    assert.deepEqual(pageCandidates(["父", "子"]), ["父/子.md", "子.md"]);
  });

  test("顶层模块只有一种候选", () => {
    assert.deepEqual(pageCandidates(["平铺"]), ["平铺.md", "平铺.md"]);
  });

  test("空名字不给候选（避免拼出 `.md`）", () => {
    assert.deepEqual(pageCandidates([]), []);
  });
});

describe("布局规则：建树", () => {
  const tree = buildWikiTree(RAW, (rel) => HIERARCHICAL.has(rel));

  test("层级与页面路径按 hierarchical 解析", () => {
    assert.equal(tree[0]?.title, "父");
    assert.equal(tree[0]?.page, null, "父.md 不存在 → 节点保留、页面为空");
    assert.deepEqual(
      tree[0]?.children.map((node) => [node.title, node.page]),
      [
        ["子", "docs/wiki/父/子.md"],
        ["无页子", null],
      ],
    );
  });

  test("没有子页面的模块同样在树上（纯分组节点不该消失）", () => {
    assert.equal(tree.length, 2);
    assert.equal(tree[1]?.page, "docs/wiki/平铺.md");
  });

  test("flat 布局回退：只有 `子.md` 时也能指到页面", () => {
    const flat = buildWikiTree(RAW, (rel) => rel === "子.md" || rel === "平铺.md");
    assert.equal(flat[0]?.children[0]?.page, "docs/wiki/子.md");
  });
});

describe("布局规则：摊平给注入用", () => {
  test("保持树序，标题带层级（父 / 子）", () => {
    const pages = flattenWikiPages(buildWikiTree(RAW, (rel) => HIERARCHICAL.has(rel)));
    assert.deepEqual(pages, [
      { path: "docs/wiki/父/子.md", title: "父 / 子" },
      { path: "docs/wiki/平铺.md", title: "平铺" },
    ]);
  });
});

describe("注入块：该说与不该说", () => {
  const base = {
    overview: "docs/wiki/overview.md",
    entries: [
      { path: "docs/wiki/父/子.md", title: "父 / 子" },
      { path: "docs/wiki/平铺.md", title: "平铺" },
    ],
    generatedAt: "2026-10-17T22:03:43.924415",
  };

  test("没有任何产物 → 空串（不制造常态噪声）", () => {
    assert.equal(
      renderWikiMap({ overview: null, entries: [], generatedAt: null, behind: null }),
      "",
    );
  });

  test("一致：说「生成后没有新提交」", () => {
    const text = renderWikiMap({ ...base, behind: 0 });
    assert.match(text, /生成于 2026-10-17/);
    assert.match(text, /没有新提交/);
    assert.doesNotMatch(text, /过期/);
    assert.match(text, /docs\/wiki\/父\/子\.md/);
  });

  test("落后：报出提交数并明说可能过期", () => {
    const text = renderWikiMap({ ...base, behind: 3 });
    assert.match(text, /3 个提交/);
    assert.match(text, /过期/);
  });

  test("比较不了：说「未知」，**不能**说成最新", () => {
    const text = renderWikiMap({ ...base, behind: null });
    assert.match(text, /未知/);
    assert.doesNotMatch(text, /没有新提交/);
  });

  test("只有概览没有树：仍注入，且不出现空的导航小节", () => {
    const text = renderWikiMap({ ...base, entries: [], behind: 0 });
    assert.match(text, /overview\.md/);
    assert.doesNotMatch(text, /还有 0 页/);
  });

  test("尾注恒定：冲突以源码为准 + 用 read 打开", () => {
    const text = renderWikiMap({ ...base, behind: 0 });
    assert.match(text, /源码为准/);
    assert.match(text, /用 read 打开/);
  });

  test("超预算：截断且**如实写出还剩多少页**", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      path: `docs/wiki/模块${index}/页面${index}.md`,
      title: `模块${index} / 页面${index}`,
    }));
    const text = renderWikiMap({ overview: null, entries: many, generatedAt: null, behind: 0 }, 400);
    const listed = text.split("\n").filter((line) => line.startsWith("- 模块")).length;
    assert.ok(listed > 0 && listed < many.length, `应部分列出，实际 ${listed}/${many.length}`);
    assert.match(text, new RegExp(`还有 ${many.length - listed} 页未列出`));
  });

  test("预算充足时整段不超过预算（按字符计）", () => {
    const text = renderWikiMap({ ...base, behind: 0 });
    assert.ok(text.length <= WIKI_MAP_BUDGET_CHARS, `实际 ${text.length} 字符`);
  });
});

/**
 * 注入器本身（读盘 + 缓存 + 失败上报）。
 *
 * 不测 git 新鲜度的具体数字：那取决于本机是否装了 git、临时目录是不是仓库，
 * 结论会随机器漂移。只钉两条不会变的东西：**没有产物就一个字不注入**、
 * **产物坏了要报出来而不是静默少一段**。
 */
describe("注入器：读盘与失败上报", () => {
  const dirs: string[] = [];
  const makeRoot = (): string => {
    const dir = makeTempDir("colt-wiki-map-");
    dirs.push(dir);
    return dir;
  };
  const writeWiki = (root: string, files: Record<string, string>): void => {
    mkdirSync(join(root, "docs/wiki"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, "docs/wiki", name);
      // 页面可能落在子目录里（hierarchical 布局），得把父目录一并建出来
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
  };

  test("没有 docs/wiki → 原样返回 base（常态不注入）", async () => {
    const root = makeRoot();
    const injector = createWikiMapInjector(root);
    assert.equal(await injector.systemPromptFor("BASE"), "BASE");
  });

  test("有产物 → 追加索引，且明确不是「最新」而是「未知」", async () => {
    const root = makeRoot();
    writeWiki(root, {
      "module_tree.json": JSON.stringify({ 核心: { children: { 调度: {} } } }),
      "metadata.json": JSON.stringify({
        generation_info: { timestamp: "2026-10-17T22:03:43.924415", commit_id: "deadbeef" },
      }),
      "overview.md": "# 概览\n",
      "核心/调度.md": "# 调度\n",
    });
    const injector = createWikiMapInjector(root);
    const text = await injector.systemPromptFor("BASE");
    assert.match(text, /^BASE\n\n## 仓库 Wiki/);
    assert.match(text, /docs\/wiki\/核心\/调度\.md/);
    // 临时目录不是 git 仓库，也没有真的 deadbeef 提交 → 只能报「未知」
    assert.match(text, /未知/);
  });

  test("树坏了：报一次，概览仍可用（不静默少一段）", async () => {
    const root = makeRoot();
    writeWiki(root, { "module_tree.json": "{ 不是 JSON", "overview.md": "# 概览\n" });
    const errors: string[] = [];
    const injector = createWikiMapInjector(root, (message) => errors.push(message));
    const text = await injector.systemPromptFor("BASE");
    assert.equal(errors.length, 1, `应只报一次，实际：${errors.join(" | ")}`);
    assert.match(errors[0] ?? "", /module_tree\.json/);
    assert.match(text, /overview\.md/);
    // 再请求一次不应重复上报
    await injector.systemPromptFor("BASE");
    assert.equal(errors.length, 1);
  });

  test.after(() => {
    for (const dir of dirs) removeTempDir(dir);
  });
});
