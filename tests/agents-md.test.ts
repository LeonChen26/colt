/**
 * AGENTS.md 发现与注入测试。
 *
 * 四类断言：
 * ① 候选路径顺序：外层在前、内层在后（越靠近工作目录的越具体），一路收到文件系统根；
 * ② 真文件系统装载：缺失是常态、单份失败不拦其它文件、空文件跳过；
 * ③ 注入块有界：截断真的发生且指回文件；
 * ④ 通知口径：注入了几份如实报（隐式信任通道），失败必报，没事不制造噪音。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDirAsync, removeTempDirAsync } from "./helpers/temp";
import {
  agentsMdCandidates,
  appendAgentsMdBlock,
  createAgentsMdInjector,
  describeAgentsMd,
  formatAgentsMdBlock,
  loadAgentsMd,
  MAX_AGENTS_MD_CHARS,
} from "../src/worker/lib/agents-md.ts";

describe("agentsMdCandidates", () => {
  test("从 cwd 一路收到根，外层在前（含 cwd 与根两级）", () => {
    assert.deepEqual(agentsMdCandidates("/proj"), [
      join("/", "AGENTS.md"),
      join("/proj", "AGENTS.md"),
    ]);
  });

  test("Windows 绝对路径：收到盘符根为止，不越界", () => {
    assert.deepEqual(agentsMdCandidates("C:\\a\\b"), [
      join("C:\\", "AGENTS.md"),
      join("C:\\a", "AGENTS.md"),
      join("C:\\a\\b", "AGENTS.md"),
    ]);
  });

  test("cwd 本身就是根：只有一份候选", () => {
    assert.deepEqual(agentsMdCandidates("C:\\"), [join("C:\\", "AGENTS.md")]);
  });
});

describe("loadAgentsMd（真文件系统）", () => {
  let parent = "";
  let child = "";

  before(async () => {
    parent = await makeTempDirAsync("colt-agents-");
    child = join(parent, "sub");
    await mkdir(child, { recursive: true });
  });

  after(async () => {
    await removeTempDirAsync(parent);
  });

  test("一份都没有：files 与 errors 双空（缺失是常态，不算失败）", async () => {
    const loaded = await loadAgentsMd(child);
    assert.deepEqual(loaded, { files: [], errors: [] });
  });

  test("父子两级都有：外层在前、内层在后，内容各归各的", async () => {
    await writeFile(join(parent, "AGENTS.md"), "父目录约定", "utf8");
    await writeFile(join(child, "AGENTS.md"), "子目录约定", "utf8");
    const loaded = await loadAgentsMd(child);
    assert.equal(loaded.files.length, 2);
    assert.equal(loaded.files[0]?.path, join(parent, "AGENTS.md"));
    assert.equal(loaded.files[0]?.content, "父目录约定");
    assert.equal(loaded.files[1]?.path, join(child, "AGENTS.md"));
    assert.equal(loaded.files[1]?.content, "子目录约定");
  });

  test("单份读不了（是目录）不拦其它文件：能读的照读，失败进 errors", async () => {
    const dir2 = await makeTempDirAsync("colt-agents-");
    const sub = join(dir2, "sub");
    try {
      await mkdir(join(sub, "AGENTS.md"), { recursive: true });
      await writeFile(join(dir2, "AGENTS.md"), "父目录约定", "utf8");
      const loaded = await loadAgentsMd(sub);
      assert.equal(loaded.files.length, 1, "父目录那份要照常读到");
      assert.equal(loaded.files[0]?.content, "父目录约定");
      assert.equal(loaded.errors.length, 1);
      assert.ok(loaded.errors[0]?.includes(join(sub, "AGENTS.md")), loaded.errors[0] ?? "");
    } finally {
      await removeTempDirAsync(dir2);
    }
  });

  test("全空白的文件跳过：没内容的约定不值得占上下文", async () => {
    const dir3 = await makeTempDirAsync("colt-agents-");
    try {
      await writeFile(join(dir3, "AGENTS.md"), "  \n\t\n", "utf8");
      const loaded = await loadAgentsMd(dir3);
      assert.deepEqual(loaded, { files: [], errors: [] });
    } finally {
      await removeTempDirAsync(dir3);
    }
  });
});

describe("formatAgentsMdBlock", () => {
  test("一份都没有：注入空起点块——助手得先知道这份文件可以创建（同记忆的循环起点逻辑）", () => {
    const block = formatAgentsMdBlock([]);
    assert.ok(block.includes("<agents_md>") && block.includes("</agents_md>"), block);
    assert.ok(block.includes("暂无"), block);
    assert.ok(block.includes("创建"), block);
  });

  test("有文件时：块标签、每份的来源路径与内容俱全，顺序保持外层在前", () => {
    const block = formatAgentsMdBlock([
      { path: "/repo/AGENTS.md", content: "仓库约定" },
      { path: "/repo/pkg/AGENTS.md", content: "包内约定" },
    ]);
    for (const fragment of ["<agents_md>", "</agents_md>", "仓库约定", "包内约定"]) {
      assert.ok(block.includes(fragment), `缺 ${fragment}：${block}`);
    }
    assert.ok(block.includes(`path="/repo/AGENTS.md"`), block);
    assert.ok(block.includes(`path="/repo/pkg/AGENTS.md"`), block);
    assert.ok(
      block.indexOf("仓库约定") < block.indexOf("包内约定"),
      "外层约定要排在前面",
    );
  });

  test("带维护规则：可以写（用户要求时）、与记忆的分工边界、不动父目录", () => {
    const block = formatAgentsMdBlock([{ path: "/repo/AGENTS.md", content: "仓库约定" }]);
    assert.ok(block.includes("维护规则"), block);
    assert.ok(block.includes("write / edit"), block);
    assert.ok(block.includes("记忆文件"), "与记忆的分工边界要写进规则");
    assert.ok(block.includes("父目录"), block);
  });

  test("超过上限即截断：尾部内容不进块，并指回文件", () => {
    const head = "HEAD".repeat(MAX_AGENTS_MD_CHARS / 4);
    const block = formatAgentsMdBlock([{ path: "/repo/AGENTS.md", content: `${head}TAIL_BEYOND` }]);
    assert.ok(block.includes("HEAD"), block);
    assert.ok(!block.includes("TAIL_BEYOND"), "超出上限的内容不该出现在注入块里");
    assert.ok(block.includes("已截断"), "截断要明说");
  });
});

describe("createAgentsMdInjector（每请求重读）", () => {
  /** 每个用例独立建父子目录，避免用例间状态耦合 */
  const setup = async () => {
    const parent = await makeTempDirAsync("colt-agents-inj-");
    const child = join(parent, "sub");
    await mkdir(child, { recursive: true });
    return {
      parent,
      child,
      async dispose() {
        await removeTempDirAsync(parent);
      },
    };
  };

  test("空起点：注入引导块，首次请求不报集合变化（基线）", async () => {
    const { child, dispose } = await setup();
    try {
      const notices: string[] = [];
      const injector = createAgentsMdInjector(child, (m) => notices.push(m));
      const prompt = await injector.systemPromptFor("BASE");
      assert.ok(prompt.startsWith("BASE\n\n"), prompt);
      assert.ok(prompt.includes("暂无"), prompt);
      assert.equal(notices.length, 0);
    } finally {
      await dispose();
    }
  });

  test("会话中途创建 AGENTS.md：下一次请求立即可见（静态注入做不到）", async () => {
    const { child, dispose } = await setup();
    try {
      const injector = createAgentsMdInjector(child);
      assert.ok((await injector.systemPromptFor("BASE")).includes("暂无"));
      await writeFile(join(child, "AGENTS.md"), "中途新立的约定", "utf8");
      assert.ok(
        (await injector.systemPromptFor("BASE")).includes("中途新立的约定"),
        "创建后的下一次请求就该带上",
      );
    } finally {
      await dispose();
    }
  });

  test("文件集合变化通知：新增报一次、不重复报，删除报不再注入", async () => {
    const { parent, child, dispose } = await setup();
    try {
      const notices: string[] = [];
      const injector = createAgentsMdInjector(child, (m) => notices.push(m));
      await writeFile(join(child, "AGENTS.md"), "子目录约定", "utf8");
      await injector.systemPromptFor("BASE");
      await writeFile(join(parent, "AGENTS.md"), "父目录约定", "utf8");
      await injector.systemPromptFor("BASE");
      const adds = notices.filter((m) => m.includes("新增"));
      assert.equal(adds.length, 1, `新增只报一次：${JSON.stringify(notices)}`);
      assert.ok(adds[0]?.includes(join(parent, "AGENTS.md")), adds[0] ?? "");
      await injector.systemPromptFor("BASE");
      assert.equal(notices.filter((m) => m.includes("新增")).length, 1, "集合不变不重复报");
      await rm(join(parent, "AGENTS.md"));
      await injector.systemPromptFor("BASE");
      assert.ok(
        notices.some((m) => m.includes("不再注入") && m.includes(join(parent, "AGENTS.md"))),
        notices.join("；"),
      );
    } finally {
      await dispose();
    }
  });

  test("单份读不了：其它文件照常注入，失败只报一次，恢复后再失败再报一次", async () => {
    const { parent, child, dispose } = await setup();
    try {
      const notices: string[] = [];
      const injector = createAgentsMdInjector(child, (m) => notices.push(m));
      await writeFile(join(parent, "AGENTS.md"), "父目录约定", "utf8");
      await mkdir(join(child, "AGENTS.md"), { recursive: true });
      const prompt = await injector.systemPromptFor("BASE");
      assert.ok(prompt.includes("父目录约定"), "单份失败不拦其它文件");
      const errCount = () => notices.filter((m) => m.includes("读取失败")).length;
      assert.equal(errCount(), 1);
      await injector.systemPromptFor("BASE");
      await injector.systemPromptFor("BASE");
      assert.equal(errCount(), 1, "同一段失败期不重复报");
      await rm(join(child, "AGENTS.md"), { recursive: true });
      await writeFile(join(child, "AGENTS.md"), "恢复后的约定", "utf8");
      assert.ok((await injector.systemPromptFor("BASE")).includes("恢复后的约定"));
      assert.equal(errCount(), 1, "恢复本身不该报错");
      await rm(join(child, "AGENTS.md"));
      await mkdir(join(child, "AGENTS.md"), { recursive: true });
      await injector.systemPromptFor("BASE");
      assert.equal(errCount(), 2, "恢复后再失败是新的失败期，要再报一次");
    } finally {
      await dispose();
    }
  });
});

describe("appendAgentsMdBlock", () => {
  const base = "你是 Colt 桌面工作台中的编码助手。";

  test("没有文件时也注入空起点块，base 原样在最前", () => {
    const prompt = appendAgentsMdBlock(base, []);
    assert.ok(prompt.startsWith(base), "基础提示词必须原样在前面");
    assert.ok(prompt.includes("<agents_md>") && prompt.includes("暂无"), prompt);
  });

  test("有文件时块拼在 base 后面", () => {
    const prompt = appendAgentsMdBlock(base, [{ path: "/repo/AGENTS.md", content: "仓库约定" }]);
    assert.ok(prompt.startsWith(base), "基础提示词必须原样在前面");
    assert.ok(prompt.includes("<agents_md>") && prompt.includes("仓库约定"), prompt);
  });
});

describe("describeAgentsMd", () => {
  test("注入了几份如实报（隐式信任通道要可见）", () => {
    const notice = describeAgentsMd({
      files: [
        { path: "/a/AGENTS.md", content: "x" },
        { path: "/b/AGENTS.md", content: "y" },
      ],
      errors: [],
    });
    assert.ok(notice?.includes("已注入 AGENTS.md"), notice ?? "");
    assert.ok(notice?.includes("2 份"), notice ?? "");
  });

  test("读取失败必报，且带文件路径", () => {
    const notice = describeAgentsMd({ files: [], errors: ["/x/AGENTS.md：EISDIR"] });
    assert.ok(notice?.includes("读取失败"), notice ?? "");
    assert.ok(notice?.includes("/x/AGENTS.md"), notice ?? "");
  });

  test("双空返回 null（多数项目没有 AGENTS.md，不制造噪音）", () => {
    assert.equal(describeAgentsMd({ files: [], errors: [] }), null);
  });
});
