/**
 * agent 定义（`.agents/agents/*.md`）的解析、同名取舍与目录块测试
 * （`src/worker/lib/agent-defs.ts`）。
 *
 * 这一层是**安全边界**的一部分：定义正文变成子代理的系统提示词，`tools` 那行决定
 * 子代理能碰什么。所以对不认识的写法**报错**而不是猜——静默猜错会把白名单变成一团模糊。
 *
 * 最贵的一条断言落在**最终产物**上：`renderAgentCatalog` 拼出的字符串里必须真的出现
 * `<available_subagents>` 清单（`AGENTS.md` §四「库提供了函数 ≠ 库会调用它」——
 * 目录块不自己拼进提示词，模型就根本不知道有子代理可用，而装载/计数/单测全绿）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AGENT_CATALOG_CHARS,
  agentDirs,
  builtinAgentDefs,
  dedupeAgents,
  describeAgents,
  loadAgentDefs,
  parseAgentFile,
  renderAgentCatalog,
  type AgentDef,
} from "../src/worker/lib/agent-defs.ts";

const OK_FILE = [
  "---",
  "description: 只读的代码调研员——给出带出处的结论",
  "tools: read, memory_search",
  "---",
  "你是一个只读的调研子代理。",
].join("\n");

describe("parseAgentFile：frontmatter 是极简解析，不认识就报错", () => {
  test("正常定义：description / tools / 正文都取到", () => {
    const result = parseAgentFile(OK_FILE);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.description, "只读的代码调研员——给出带出处的结论");
    assert.deepEqual(result.tools, ["read", "memory_search"]);
    assert.equal(result.body, "你是一个只读的调研子代理。");
  });

  test("缺 description 报错（它是给模型看的目录块的必需项）", () => {
    const result = parseAgentFile("---\ntools: read\n---\n正文");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.reason, /description/);
  });

  test("缺 tools 报错（白名单是安全边界，不能省略交给默认值）", () => {
    const result = parseAgentFile("---\ndescription: 调研\n---\n正文");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.reason, /tools/);
  });

  test("tools 列成空报错（至少要有一个名字）", () => {
    const result = parseAgentFile("---\ndescription: 调研\ntools:\n---\n正文");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.reason, /tools/);
  });

  test("没有 frontmatter 报错", () => {
    const result = parseAgentFile("直接就是正文");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.reason, /frontmatter/);
  });

  test("frontmatter 没闭合报错", () => {
    const result = parseAgentFile("---\ndescription: 调研\ntools: read\n");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.reason, /闭合/);
  });

  test("frontmatter 里出现非 key: value 的行报错", () => {
    const result = parseAgentFile("---\ndescription: 调研\ntools: read\n这行没有冒号\n---\n正文");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.reason, /key: value/);
  });

  test("BOM 与 CRLF 都能处理（Windows 上编辑过的文件很常见）", () => {
    const text = `\uFEFF---\r\ndescription: 调研\r\ntools: read, memory_search\r\n---\r\n正文\r\n`;
    const result = parseAgentFile(text);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.tools, ["read", "memory_search"]);
    assert.equal(result.body, "正文");
  });
});

describe("agentDirs / builtinAgentDefs", () => {
  test("目录按「项目级在前」返回（同名时项目级胜出）", () => {
    const dirs = agentDirs("/work/proj", "/home/u");
    assert.equal(dirs.length, 2);
    assert.ok(dirs[0]!.includes("proj"));
    assert.ok(dirs[1]!.includes(".agents"));
  });

  test("内建兜底两个：researcher 是只读白名单，general 用默认工具集（null）", () => {
    const defs = builtinAgentDefs();
    const names = defs.map((def) => def.name);
    assert.ok(names.includes("researcher"));
    assert.ok(names.includes("general"));
    const researcher = defs.find((def) => def.name === "researcher")!;
    assert.deepEqual(researcher.tools, ["read", "memory_search"]);
    assert.equal(researcher.source, "builtin");
    assert.equal(defs.find((def) => def.name === "general")!.tools, null);
  });
});

describe("dedupeAgents：同名只留第一个，被遮蔽的名字如实收集", () => {
  const def = (name: string, source: AgentDef["source"]): AgentDef => ({
    name,
    description: `${name} 的描述`,
    tools: ["read"],
    body: "",
    source,
    path: `${name}.md`,
  });

  test("项目级在前时，同名用户级被遮蔽并报出名字", () => {
    const { agents, shadowed } = dedupeAgents([
      [def("researcher", "project")],
      [def("researcher", "user"), def("helper", "user")],
    ]);
    assert.deepEqual(agents.map((item) => item.name), ["researcher", "helper"]);
    assert.equal(agents[0]!.source, "project");
    assert.deepEqual(shadowed, ["researcher"]);
  });

  test("没有重名时什么都不遮蔽", () => {
    const { shadowed } = dedupeAgents([[def("a", "project")], [def("b", "user")]]);
    assert.deepEqual(shadowed, []);
  });
});

describe("renderAgentCatalog：有界、如实、最终产物上看得见", () => {
  const def = (name: string, description: string): AgentDef => ({
    name,
    description,
    tools: ["read"],
    body: "",
    source: "builtin",
    path: "内置",
  });

  test("空名单返回空串（不产出空壳标题）", () => {
    assert.equal(renderAgentCatalog([]), "");
  });

  test("清单真的拼进了最终字符串（模型能不能看见，判据在这里）", () => {
    const out = renderAgentCatalog([def("researcher", "只读调研")]);
    assert.ok(out.startsWith("<available_subagents>"));
    assert.ok(out.endsWith("</available_subagents>"));
    assert.ok(out.includes("- researcher：只读调研"));
  });

  test("超过预算时如实说还剩几个没列出，不静默截断", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      def(`agent-${index}`, "x".repeat(100)),
    );
    const out = renderAgentCatalog(many);
    const listed = out.split("\n").filter((line) => line.startsWith("- ")).length;
    assert.ok(listed > 0, "至少要列出几条");
    assert.ok(listed < many.length, "40 条不可能全塞进预算");
    assert.ok(out.includes("未列出"), "被截掉的部分必须如实说明");
    // 预算约束的唯一实质：列出的行数由 MAX_AGENT_CATALOG_CHARS 决定，不是「全都在」
    assert.ok(
      out.length <= MAX_AGENT_CATALOG_CHARS + 60,
      `目录块超出预算太多：${out.length}`,
    );
  });
});

describe("loadAgentDefs / describeAgents", () => {
  test("目录都不存在时回落内建（子代理不是死功能），计数为 0", async () => {
    const loaded = await loadAgentDefs([
      "/definitely/not/here/project",
      "/definitely/not/here/user",
    ]);
    assert.deepEqual(loaded.counts, [0, 0]);
    assert.deepEqual(loaded.shadowed, []);
    assert.deepEqual(loaded.failures, []);
    assert.ok(loaded.agents.some((item) => item.name === "researcher"));
    assert.ok(loaded.agents.some((item) => item.name === "general"));
  });

  test("没什么可说时返回 null（不产出「已加载 0 个」这种噪声）", () => {
    assert.equal(
      describeAgents({ agents: [], shadowed: [], counts: [0, 0], failures: [] }),
      null,
    );
  });

  test("装到东西时如实报数量与来源；被遮蔽的名字也要说", () => {
    const message = describeAgents({
      agents: [],
      shadowed: ["researcher", "helper"],
      counts: [1, 3],
      failures: [{ path: "/work/bad.md", reason: "缺 description" }],
    });
    assert.ok(message !== null);
    assert.match(message, /项目级 1/);
    assert.match(message, /用户级 3/);
    assert.match(message, /researcher/);
    assert.match(message, /bad\.md/);
  });
});
