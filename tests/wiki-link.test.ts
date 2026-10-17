/**
 * wiki 页内链接归一。
 *
 * 这些用例来自**真实产物**：本仓试跑生成的页间链接是
 * `[文本](<主进程（Electron Main）/会话编排与 IPC.md>)`——空格与全角括号让 Markdown
 * 必须用尖括号包裹，而解析器剥掉尖括号后给到渲染层的是裸路径（含空格时还会被
 * 百分号编码）。任何一条没考虑到，表现都是「点了没反应」或「跳到一个不存在的页」，
 * 而且不报错——所以逐条钉住。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveWikiLink } from "../src/renderer/src/lib/wiki-link.ts";

const FROM = "docs/wiki/主进程（Electron Main）.md";

describe("resolveWikiLink：相对当前页归一", () => {
  test("同级页", () => {
    assert.equal(resolveWikiLink(FROM, "构建.md"), "docs/wiki/构建.md");
  });

  test("子目录页（产物里的常见形态）", () => {
    assert.equal(
      resolveWikiLink(FROM, "主进程（Electron Main）/会话编排与 IPC.md"),
      "docs/wiki/主进程（Electron Main）/会话编排与 IPC.md",
    );
  });

  test("从子页回到父页", () => {
    assert.equal(
      resolveWikiLink("docs/wiki/主进程（Electron Main）/会话编排与 IPC.md", "../构建.md"),
      "docs/wiki/构建.md",
    );
  });

  test("带锚点：剥掉锚点再归一", () => {
    assert.equal(resolveWikiLink(FROM, "构建.md#小节"), "docs/wiki/构建.md");
  });

  test("含空格的路径经百分号编码后仍能还原", () => {
    assert.equal(
      resolveWikiLink(FROM, "%E4%B8%BB%E8%BF%9B%E7%A8%8B%EF%BC%88Electron%20Main%EF%BC%89/%E4%BC%9A%E8%AF%9D.md"),
      "docs/wiki/主进程（Electron Main）/会话.md",
    );
  });

  test("根相对写法也认（以 / 开头）", () => {
    assert.equal(resolveWikiLink(FROM, "/docs/wiki/构建.md"), "docs/wiki/构建.md");
  });
});

describe("resolveWikiLink：归一不出来就返回 null（调用方按外链处理）", () => {
  test("外链", () => {
    assert.equal(resolveWikiLink(FROM, "https://example.com/a.md"), null);
  });

  test("非 md", () => {
    assert.equal(resolveWikiLink(FROM, "diagram.png"), null);
  });

  test("锚点本身（没有目标文件）", () => {
    assert.equal(resolveWikiLink(FROM, "#小节"), null);
  });

  test("跳出 wiki 根 → null（不猜一个「差一点就对」的路径）", () => {
    assert.equal(resolveWikiLink("docs/wiki/overview.md", "../AGENTS.md"), null);
  });

  test("用 .. 绕到项目根外 → null", () => {
    assert.equal(resolveWikiLink("docs/wiki/a/b.md", "../../../etc/passwd.md"), null);
  });

  test("起始页不在 wiki 目录里 → null", () => {
    assert.equal(resolveWikiLink("docs/other.md", "构建.md"), null);
  });
});
