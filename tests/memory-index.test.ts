/**
 * 记忆检索索引（L3a）测试：拆条、入库生命周期（active ⇄ archived）、检索两路径
 * （FTS trigram / LIKE 兜底）、项目隔离、结果格式化，以及 session-manager 的
 * memoryIndex 消息守卫（源码契约——switch 漏 case 会静默丢快照）。
 */
import { describe, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeMemoryDatabase,
  indexMemorySnapshot,
  openMemoryDatabase,
  parseMemoryEntries,
  searchMemory,
  type MemorySnapshot,
} from "../src/main/db/memory-index.ts";
import { formatMemoryHits } from "../src/main/host/memory-host.ts";
import { normalizeRootKey } from "../src/main/db/index.ts";

describe("parseMemoryEntries", () => {
  test("非空行即条目；标题行与空行跳过；CRLF 兼容；bullet 标记无损保留", () => {
    const lines = parseMemoryEntries("# 项目记忆\r\n\r\n- 用 pnpm 跑单测\n## 约定\n\n构建走 npm run build\r\n");
    assert.deepEqual(lines, ["- 用 pnpm 跑单测", "构建走 npm run build"]);
  });
});

describe("indexMemorySnapshot + searchMemory", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "colt-memidx-"));
    openMemoryDatabase(root);
  });
  afterEach(() => {
    closeMemoryDatabase();
    rmSync(root, { recursive: true, force: true });
  });

  const projKey = () => normalizeRootKey("/proj");
  const snap = (over: Partial<MemorySnapshot> = {}): MemorySnapshot => ({
    scope: "project",
    projectKey: projKey(),
    sourcePath: "/proj/.colt/memory.md",
    content: "- 用 pnpm 跑单测\n- 构建命令是 npm run build",
    sessionId: "s1",
    ...over,
  });

  test("索引 → 检索往返：≥3 字走 FTS 命中，条目原文无损", () => {
    indexMemorySnapshot(snap());
    const hits = searchMemory({ projectKey: projKey(), query: "跑单测" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.content, "- 用 pnpm 跑单测");
    assert.equal(hits[0]?.status, "active");
    assert.equal(hits[0]?.scope, "project");
  });

  test("二字词走 LIKE 兜底（trigram 有 3 字符下限）", () => {
    indexMemorySnapshot(snap());
    const hits = searchMemory({ projectKey: projKey(), query: "单测" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.content, "- 用 pnpm 跑单测");
  });

  test("文件里移除的条目进冷层（archived），仍可检索；放回去就复活", () => {
    indexMemorySnapshot(snap());
    indexMemorySnapshot(snap({ content: "- 构建命令是 npm run build", sessionId: "s2" }));
    const hits = searchMemory({ projectKey: projKey(), query: "pnpm" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.status, "archived", "被移除的条目应在冷层");
    indexMemorySnapshot(snap({ content: "- 用 pnpm 跑单测\n- 构建命令是 npm run build", sessionId: "s3" }));
    const again = searchMemory({ projectKey: projKey(), query: "pnpm" });
    assert.equal(again.length, 1);
    assert.equal(again[0]?.status, "active", "条目回到文件应复活为现行");
  });

  test("文件被删（content null）：现行条目全部归档，冷层仍可检索", () => {
    indexMemorySnapshot(snap());
    indexMemorySnapshot(snap({ content: null }));
    const hits = searchMemory({ projectKey: projKey(), query: "npm run build" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.status, "archived");
  });

  test("项目隔离：别的项目的条目不可见；用户级条目任何项目都可见", () => {
    indexMemorySnapshot(snap());
    indexMemorySnapshot(
      snap({
        scope: "project",
        projectKey: normalizeRootKey("/other"),
        sourcePath: "/other/.colt/memory.md",
        content: "- 别的项目的秘密约定",
      }),
    );
    indexMemorySnapshot(snap({ scope: "user", projectKey: "", sourcePath: "~/.colt/memory.md", content: "约定：交流用中文" }));
    const fromProj = searchMemory({ projectKey: projKey(), query: "约定" });
    assert.deepEqual(fromProj.map((h) => h.scope), ["user"], "只能看到本项目的 + 用户级的");
    const fromOther = searchMemory({ projectKey: normalizeRootKey("/other"), query: "秘密约定" });
    assert.equal(fromOther.length, 1, "自己的项目检索自己的");
    assert.equal(searchMemory({ projectKey: projKey(), query: "秘密约定" }).length, 0);
  });

  test("查询里的 LIKE/FTS 特殊字符不炸（回落或转义），空查询返回空", () => {
    indexMemorySnapshot(snap());
    assert.doesNotThrow(() => searchMemory({ projectKey: projKey(), query: "100%" }));
    assert.doesNotThrow(() => searchMemory({ projectKey: projKey(), query: "a_b" }));
    assert.doesNotThrow(() => searchMemory({ projectKey: projKey(), query: '"引用(' }));
    assert.deepEqual(searchMemory({ projectKey: projKey(), query: "  " }), []);
  });
});

describe("formatMemoryHits", () => {
  test("空结果给出如实提示；结果带 scope/状态/日期标注", () => {
    assert.match(formatMemoryHits([], "任意"), /没有匹配/);
    const text = formatMemoryHits(
      [
        { content: "- 用 pnpm 跑单测", scope: "project", status: "active", sourcePath: "/p/.colt/memory.md", lastSeenAt: 0 },
      ],
      "pnpm",
    );
    assert.match(text, /项目·现行/);
    assert.match(text, /pnpm 跑单测/);
  });
});

describe("session-manager 的 memoryIndex 守卫（源码契约）", () => {
  const SOURCE = readFileSync(new URL("../src/main/session-manager.ts", import.meta.url), "utf8");
  test("消息 switch 必须处理 memoryIndex——漏掉就是静默丢快照", () => {
    assert.match(SOURCE, /case "memoryIndex"/);
    assert.match(SOURCE, /#handleMemoryIndex/);
  });
});
