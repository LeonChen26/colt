/**
 * MCP 工具接入测试——验证的是**那条架构主张**，不只是客户端能跑：
 *
 *   「MCP 工具以普通内核工具的身份进入，自动过审批闸门，安全模型零例外。」
 *
 * 因此覆盖分四层：
 * 1. 装载与包装：真实 stdio 往返（夹具 server 是独立子进程）、名字前缀、通知如实；
 * 2. 内核契约：裸 JSON Schema 原样透传，且 pi-ai 的 validateToolArguments 真会拿它校验
 *    （缺 required 要抛）——这条钉的是「生产方产出什么、内核接受什么」的接口事实；
 * 3. 闸门链路：包装后的名字不在任何豁免名单（提问 / 子代理 / 只读），
 *    policy 落到「未知工具，按需确认」→ approval 模式必须 ask；
 * 4. 配置健壮性：缺文件不吵、坏 JSON 成诊断、坏 server 不拖死好 server。
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import {
  closeMcpTools,
  loadMcpConfig,
  loadMcpTools,
  mapMcpContent,
  mcpToolName,
  parseServerConfig,
} from "../src/worker/lib/mcp-tools.ts";
import { isQuestionTool } from "../src/worker/lib/ask-user-tool.ts";
import { isSubagentTool } from "../src/worker/lib/subagent.ts";
import { READONLY_TOOLS } from "../src/shared/readonly-tools.ts";
import { buildSignature, evaluateTool, type PolicyConfig } from "../src/main/approval/policy.ts";

const FIXTURE = fileURLToPath(new URL("./helpers/mcp-fixture-server.mjs", import.meta.url));

type Tool = AgentHarnessTool<ExecutionToolContext>;

/** execute 在内核里有 6 个形参，测试只关心前两个 */
async function callTool(tool: Tool, params: Record<string, unknown>) {
  const execute = tool.execute as unknown as (
    id: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text?: string }[] }>;
  return execute("tc-test", params);
}

/** 造一个带 .colt/mcp.json 的临时项目目录 */
async function fixtureProject(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "colt-mcp-"));
  await mkdir(join(dir, ".colt"), { recursive: true });
  await writeFile(join(dir, ".colt", "mcp.json"), JSON.stringify(config), "utf8");
  return dir;
}

function fixtureServerConfig(): Record<string, unknown> {
  return {
    mcpServers: {
      fixture: { command: process.execPath, args: [FIXTURE] },
    },
  };
}

after(async () => {
  await closeMcpTools();
});

describe("装载与包装（真实 stdio 子进程往返）", () => {
  test("工具按 mcp__server__tool 命名并如实通知", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const notices: string[] = [];
    const tools = await loadMcpTools(dir, (message) => notices.push(message));
    try {
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ["mcp__fixture__add", "mcp__fixture__echo", "mcp__fixture__fail"],
      );
      assert.equal(notices.length, 1);
      assert.match(notices[0]!, /已连接 1 个 MCP server：fixture（3 个工具）/);
    } finally {
      await closeMcpTools();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("echo 工具真实往返：入参到夹具、文本结果回来", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const tools = await loadMcpTools(dir, () => undefined);
    try {
      const echo = tools.find((tool) => tool.name === "mcp__fixture__echo")!;
      const result = await callTool(echo, { text: "你好 MCP" });
      assert.deepEqual(result.content, [{ type: "text", text: "echo:你好 MCP" }]);
    } finally {
      await closeMcpTools();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("isError 结果按内核约定 throw（与 host-bridge 同款）", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const tools = await loadMcpTools(dir, () => undefined);
    try {
      const fail = tools.find((tool) => tool.name === "mcp__fixture__fail")!;
      await assert.rejects(() => callTool(fail, {}), /fixture 工具按约定失败/);
    } finally {
      await closeMcpTools();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("内核契约：裸 JSON Schema 透传", () => {
  test("parameters 与夹具声明的 inputSchema 逐字相同（模型看到的就是它）", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const tools = await loadMcpTools(dir, () => undefined);
    try {
      const echo = tools.find((tool) => tool.name === "mcp__fixture__echo")!;
      assert.deepEqual(echo.parameters, {
        type: "object",
        properties: { text: { type: "string", description: "要回显的文本" } },
        required: ["text"],
      });
    } finally {
      await closeMcpTools();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pi-ai 的 validateToolArguments 接受合法入参、拒绝缺 required 的入参", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const tools = await loadMcpTools(dir, () => undefined);
    try {
      const add = tools.find((tool) => tool.name === "mcp__fixture__add")!;
      const valid = validateToolArguments(add, {
        type: "toolCall",
        id: "tc-1",
        name: add.name,
        arguments: { a: 1, b: 2 },
      });
      assert.deepEqual(valid, { a: 1, b: 2 });
      assert.throws(
        () =>
          validateToolArguments(add, {
            type: "toolCall",
            id: "tc-2",
            name: add.name,
            arguments: { a: 1 },
          }),
        /Validation failed/,
      );
    } finally {
      await closeMcpTools();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("闸门链路：MCP 工具不在任何豁免名单，必须过审批", () => {
  const config: PolicyConfig = { mode: "approval", projectRoot: "E:/proj", allowRules: [] };

  test("mcp__ 前缀的名字：非提问、非子代理、非只读", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const tools = await loadMcpTools(dir, () => undefined);
    try {
      for (const tool of tools) {
        assert.equal(isQuestionTool(tool.name), false, `${tool.name} 被误判为提问工具`);
        assert.equal(isSubagentTool(tool.name), false, `${tool.name} 被误判为子代理工具`);
        assert.equal(READONLY_TOOLS.has(tool.name), false, `${tool.name} 混进了只读白名单`);
      }
    } finally {
      await closeMcpTools();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("policy 对 MCP 工具的判定：moderate + ask（不认识就问，绝不默认放行）", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const tools = await loadMcpTools(dir, () => undefined);
    try {
      for (const tool of tools) {
        const verdict = evaluateTool({ toolName: tool.name, args: {} }, config);
        assert.equal(verdict.decision, "ask", `${tool.name} 应当进审批队列`);
        assert.equal(verdict.risk, "moderate");
        assert.match(verdict.reason, /未知工具/);
        // 「本次会话不再询问」的记忆签名按工具名整名记忆，颗粒度正确
        assert.equal(buildSignature({ toolName: tool.name, args: {} }), `${tool.name}:*`);
      }
    } finally {
      await closeMcpTools();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("配置健壮性", () => {
  test("没有 .colt/mcp.json：空配置、不通知、不抛错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "colt-mcp-"));
    const notices: string[] = [];
    try {
      const tools = await loadMcpTools(dir, (message) => notices.push(message));
      assert.deepEqual(tools, []);
      assert.deepEqual(notices, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("坏 JSON：成诊断通知，不拦会话", async () => {
    const dir = await mkdtemp(join(tmpdir(), "colt-mcp-"));
    await mkdir(join(dir, ".colt"), { recursive: true });
    await writeFile(join(dir, ".colt", "mcp.json"), "{ 这不是 JSON", "utf8");
    const notices: string[] = [];
    try {
      const tools = await loadMcpTools(dir, (message) => notices.push(message));
      assert.deepEqual(tools, []);
      assert.equal(notices.length, 1);
      assert.match(notices[0]!, /不是合法 JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("坏 server 不拖死好 server：坏的成诊断，好的照常可用", async () => {
    const dir = await fixtureProject({
      mcpServers: {
        ghost: { command: "colt-mcp-server-that-does-not-exist" },
        fixture: { command: process.execPath, args: [FIXTURE] },
      },
    });
    const notices: string[] = [];
    try {
      const tools = await loadMcpTools(dir, (message) => notices.push(message));
      assert.equal(tools.length, 3);
      assert.equal(notices.length, 1);
      assert.match(notices[0]!, /已连接 1 个 MCP server：fixture/);
      assert.match(notices[0]!, /server "ghost" 连接失败/);
    } finally {
      await closeMcpTools();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parseServerConfig 拒绝畸形声明并指名道姓", () => {
    assert.match(parseServerConfig("a", null) as string, /"a"/);
    assert.match(parseServerConfig("b", { args: [] }) as string, /缺少 command/);
    assert.match(
      parseServerConfig("c", { command: "x", args: [1] }) as string,
      /args 必须是字符串数组/,
    );
    assert.match(
      parseServerConfig("d", { command: "x", env: { K: 1 } }) as string,
      /env 必须是字符串字典/,
    );
    assert.deepEqual(parseServerConfig("e", { command: "x" }), { command: "x" });
  });

  test("loadMcpConfig 跳过畸形条目、保留合法条目", async () => {
    const dir = await fixtureProject({
      mcpServers: {
        bad: { args: [] },
        good: { command: "x" },
      },
    });
    try {
      const { servers, diagnostics } = await loadMcpConfig(dir);
      assert.deepEqual(servers, { good: { command: "x" } });
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0]!, /"bad"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("纯函数", () => {
  test("mcpToolName：清洗非法字符、封顶 64 字符", () => {
    assert.equal(mcpToolName("my server", "read.file"), "mcp__my_server__read_file");
    const long = mcpToolName("s".repeat(40), "t".repeat(40));
    assert.equal(long.length, 64);
    assert.ok(long.startsWith("mcp__"));
  });

  test("mapMcpContent：text / image / resource / structuredContent / 空结果", () => {
    assert.deepEqual(mapMcpContent({ content: [{ type: "text", text: "hi" }] }), [
      { type: "text", text: "hi" },
    ]);
    assert.deepEqual(
      mapMcpContent({ content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] }),
      [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    );
    assert.deepEqual(
      mapMcpContent({ content: [{ type: "resource", resource: { text: "文件内容" } }] }),
      [{ type: "text", text: "文件内容" }],
    );
    assert.deepEqual(mapMcpContent({ content: [], structuredContent: { x: 1 } }), [
      { type: "text", text: '{\n  "x": 1\n}' },
    ]);
    assert.deepEqual(mapMcpContent({}), [{ type: "text", text: "[mcp] 工具返回了空结果" }]);
    assert.deepEqual(mapMcpContent({ content: [{ type: "audio", data: "xx" }] }), [
      { type: "text", text: "[mcp] 不支持的内容块类型：audio" },
    ]);
  });
});
