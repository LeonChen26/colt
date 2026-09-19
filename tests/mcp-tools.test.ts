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
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import {
  closeMcpTools,
  configKey,
  createMcpRuntime,
  interpolateConfig,
  loadMcpConfig,
  loadMcpTools,
  mapMcpContent,
  mcpToolName,
  parseServerConfig,
  targetOf,
  transportOf,
  type McpServerConfig,
} from "../src/worker/lib/mcp-tools.ts";
import { isQuestionTool } from "../src/worker/lib/ask-user-tool.ts";
import { isSubagentTool } from "../src/worker/lib/subagent.ts";
import { READONLY_TOOLS } from "../src/shared/readonly-tools.ts";
import { buildSignature, evaluateTool, type PolicyConfig } from "../src/main/approval/policy.ts";

const FIXTURE = fileURLToPath(new URL("./helpers/mcp-fixture-server.mjs", import.meta.url));
const PAGED_FIXTURE = fileURLToPath(
  new URL("./helpers/mcp-paged-fixture-server.mjs", import.meta.url),
);
const HTTP_FIXTURE = fileURLToPath(new URL("./helpers/mcp-http-fixture-server.mjs", import.meta.url));
const CRASH_FIXTURE = fileURLToPath(
  new URL("./helpers/mcp-crash-fixture-server.mjs", import.meta.url),
);
const SSE_FIXTURE = fileURLToPath(new URL("./helpers/mcp-sse-fixture-server.mjs", import.meta.url));

type Tool = AgentHarnessTool<ExecutionToolContext>;

/** 取一个空闲端口：绑 0 号端口读到号，再立刻释放（随后由 HTTP 夹具去绑它） */
async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 等端口真的能连上：夹具是独立进程，listen 之前连过去会被拒 */
async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connectTcp({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`等待 HTTP 夹具端口 ${port} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 轮询直到条件成立：等「子进程退出 → transport close → onclose」这类异步传播 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待条件成立超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

describe("远程配置解析（纯函数）", () => {
  test("transportOf / targetOf：stdio 与远程分流", () => {
    assert.equal(transportOf({ command: "x" }), "stdio");
    assert.equal(transportOf({ url: "https://h/mcp" }), "http");
    assert.equal(transportOf({ url: "https://h/mcp", transport: "sse" }), "sse");
    assert.equal(transportOf({}), undefined);
    assert.equal(targetOf({ command: "npx", args: ["-y", "pkg"] }), "npx -y pkg");
    assert.equal(targetOf({ url: "https://h/mcp" }), "https://h/mcp");
  });

  test("parseServerConfig：command / url 二选一，不许多也不许少", () => {
    assert.match(parseServerConfig("a", {}) as string, /缺少 command 或 url/);
    assert.match(
      parseServerConfig("b", { command: "x", url: "https://h" }) as string,
      /不能同时声明/,
    );
    assert.deepEqual(parseServerConfig("c", { url: "https://h/mcp" }), { url: "https://h/mcp" });
    assert.deepEqual(parseServerConfig("d", { url: "https://h/mcp", transport: "sse" }), {
      url: "https://h/mcp",
      transport: "sse",
    });
    assert.match(
      parseServerConfig("e", { url: "https://h", transport: "ws" }) as string,
      /transport 只能是/,
    );
  });

  test("configKey：键序无关（只调整书写顺序不算变更，不该白重连）", () => {
    const a: McpServerConfig = { command: "x", env: { A: "1", B: "2" } };
    const b: McpServerConfig = { command: "x", env: { B: "2", A: "1" } };
    assert.equal(configKey(a), configKey(b));
    assert.notEqual(configKey(a), configKey({ command: "x", env: { A: "1" } }));
  });

  test("interpolateConfig：展开 ${VAR}；缺变量成诊断而非静默留空", () => {
    const env = { HOST: "example.com", TOKEN: "s3cr3t" };
    assert.deepEqual(
      interpolateConfig(
        { url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
        env,
      ),
      { url: "https://example.com/mcp", headers: { Authorization: "Bearer s3cr3t" } },
    );
    assert.match(
      interpolateConfig({ command: "run", args: ["--key", "${MISSING}"] }, env) as string,
      /未定义的环境变量：MISSING/,
    );
  });
});

describe("listTools 分页", () => {
  test("跟随 nextCursor 把工具收全（5 个工具跨 3 页）", async () => {
    const dir = await fixtureProject({
      mcpServers: { paged: { command: process.execPath, args: [PAGED_FIXTURE] } },
    });
    try {
      const tools = await loadMcpTools(dir, () => undefined);
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        [
          "mcp__paged__page1",
          "mcp__paged__page2",
          "mcp__paged__page3",
          "mcp__paged__page4",
          "mcp__paged__page5",
        ],
      );
    } finally {
      await closeMcpTools();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("传输：远程（Streamable HTTP）", () => {
  test("url 配置真的连上并调用；headers 透传到请求", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [HTTP_FIXTURE, String(port)], { stdio: "ignore" });
    const dir = await fixtureProject({
      mcpServers: {
        remote: {
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: "Bearer test-token" },
        },
      },
    });
    try {
      await waitForPort(port);
      const runtime = await createMcpRuntime(dir, () => undefined);
      try {
        assert.deepEqual(
          runtime.tools.map((tool) => tool.name).sort(),
          ["mcp__remote__auth", "mcp__remote__echo"],
        );
        assert.equal(runtime.status()[0]?.transport, "http");
        assert.equal(runtime.status()[0]?.status, "connected");

        const echo = runtime.tools.find((tool) => tool.name === "mcp__remote__echo")!;
        assert.deepEqual((await callTool(echo, { text: "远程" })).content, [
          { type: "text", text: "http-echo:远程" },
        ]);
        // headers 透传的物证：server 回显它收到的 Authorization（只验「连通」会漏掉它）
        const auth = runtime.tools.find((tool) => tool.name === "mcp__remote__auth")!;
        assert.deepEqual((await callTool(auth, {})).content, [
          { type: "text", text: "auth:Bearer test-token" },
        ]);
      } finally {
        await runtime.close();
      }
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("连不上（死端口）成 error 态，不抛穿装载；SSE 传输同样走通这条分支", async () => {
    const port = await freePort();
    const dir = await fixtureProject({
      mcpServers: { dead: { url: `http://127.0.0.1:${port}/mcp`, transport: "sse" } },
    });
    const notices: string[] = [];
    try {
      const runtime = await createMcpRuntime(dir, (message) => notices.push(message));
      try {
        assert.deepEqual(runtime.tools, []);
        assert.equal(runtime.status()[0]?.transport, "sse");
        assert.equal(runtime.status()[0]?.status, "error");
        assert.match(notices.join("；"), /server "dead" 连接失败/);
      } finally {
        await runtime.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("传输：远程（旧式 SSE）", () => {
  test("transport: sse 真的连上并往返（此前只验过失败路径）", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [SSE_FIXTURE, String(port)], { stdio: "ignore" });
    const dir = await fixtureProject({
      mcpServers: { legacy: { url: `http://127.0.0.1:${port}/sse`, transport: "sse" } },
    });
    try {
      await waitForPort(port);
      const runtime = await createMcpRuntime(dir, () => undefined);
      try {
        assert.equal(runtime.status()[0]?.transport, "sse");
        assert.equal(runtime.status()[0]?.status, "connected");
        assert.deepEqual(runtime.tools.map((tool) => tool.name).sort(), [
          "mcp__legacy__echo",
          "mcp__legacy__ping",
        ]);
        const echo = runtime.tools.find((tool) => tool.name === "mcp__legacy__echo")!;
        assert.deepEqual((await callTool(echo, { text: "SSE" })).content, [
          { type: "text", text: "sse-echo:SSE" },
        ]);
      } finally {
        await runtime.close();
      }
    } finally {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("热重载与状态", () => {
  test("reload 只重连变更的 server，并把新工具清单与现状返出来", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const runtime = await createMcpRuntime(dir, () => undefined);
    try {
      assert.equal(runtime.tools.length, 3);
      assert.deepEqual(runtime.status().map((server) => server.name), ["fixture"]);
      assert.equal(runtime.status()[0]?.status, "connected");

      // 加一个坏 server：reload 后它就是 error 态；fixture 配置没变，不必重连
      await writeFile(
        join(dir, ".colt", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            fixture: { command: process.execPath, args: [FIXTURE] },
            ghost: { command: "colt-mcp-server-that-does-not-exist" },
          },
        }),
        "utf8",
      );
      const reloaded = await runtime.reload();
      assert.deepEqual(reloaded.tools.map((tool) => tool.name).sort(), [
        "mcp__fixture__add",
        "mcp__fixture__echo",
        "mcp__fixture__fail",
      ]);
      const byName = new Map(reloaded.statuses.map((server) => [server.name, server]));
      assert.equal(byName.get("fixture")?.status, "connected");
      assert.equal(byName.get("ghost")?.status, "error");
      assert.match(reloaded.summary, /server "ghost" 连接失败/);

      // 再删掉 fixture：reload 后它连工具一起消失（删工具必须连主 lane 清单一起删，见 mcp-reload.ts）
      await writeFile(join(dir, ".colt", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
      const emptied = await runtime.reload();
      assert.deepEqual(emptied.tools, []);
      assert.deepEqual(emptied.statuses, []);
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("工具重名：保留先到的、记进汇总，不把装载整个搞崩", async () => {
    // "a.b" 与 "a_b" 清洗后同形 → mcp__a_b__echo 撞名（内核 validateToolNames 见重名会直接 TypeError）
    const dir = await fixtureProject({
      mcpServers: {
        "a.b": { command: process.execPath, args: [FIXTURE] },
        a_b: { command: process.execPath, args: [FIXTURE] },
      },
    });
    const notices: string[] = [];
    try {
      const runtime = await createMcpRuntime(dir, (message) => notices.push(message));
      try {
        assert.deepEqual(runtime.tools.map((tool) => tool.name).sort(), [
          "mcp__a_b__add",
          "mcp__a_b__echo",
          "mcp__a_b__fail",
        ]);
        assert.match(notices.join("；"), /MCP 工具重名 3 条/);
      } finally {
        await runtime.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("连接生命周期：失败可重试、掉线如实上报", () => {
  test("热重载会重试上一轮连失败的 server（配置一字未改）", async () => {
    const port = await freePort();
    // 刚开始 server 不在：连不上 → error 态。此后配置**一字不改**，只让 server 起来
    const dir = await fixtureProject({
      mcpServers: { late: { url: `http://127.0.0.1:${port}/mcp` } },
    });
    let child: ReturnType<typeof spawn> | undefined;
    const runtime = await createMcpRuntime(dir, () => undefined);
    try {
      assert.equal(runtime.status()[0]?.status, "error");
      assert.deepEqual(runtime.tools, []);

      // 「server 起晚了」（后端刚发布 / 网络刚恢复）——这正是「重新加载」该救回来的场景
      child = spawn(process.execPath, [HTTP_FIXTURE, String(port)], { stdio: "ignore" });
      await waitForPort(port);

      const reloaded = await runtime.reload();
      assert.equal(reloaded.statuses[0]?.status, "connected");
      assert.equal(reloaded.statuses[0]?.error, undefined);
      assert.deepEqual(reloaded.tools.map((tool) => tool.name).sort(), [
        "mcp__late__auth",
        "mcp__late__echo",
      ]);
    } finally {
      await runtime.close();
      child?.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("连上后 server 死亡：status 转 error（不再永久 connected），且「重新加载」能救回", async () => {
    const dir = await fixtureProject({
      mcpServers: { crash: { command: process.execPath, args: [CRASH_FIXTURE] } },
    });
    const runtime = await createMcpRuntime(dir, () => undefined);
    try {
      assert.equal(runtime.status()[0]?.status, "connected");
      const ping = runtime.tools.find((tool) => tool.name === "mcp__crash__ping")!;
      assert.deepEqual((await callTool(ping, {})).content, [{ type: "text", text: "pong" }]);

      // 让 server 自杀：它不回响应，这次调用注定失败——只当扳机用
      const boom = runtime.tools.find((tool) => tool.name === "mcp__crash__boom")!;
      void callTool(boom, {}).catch(() => undefined);

      await waitFor(() => runtime.status()[0]?.status === "error");
      assert.match(runtime.status()[0]?.error ?? "", /连接已断开/);

      // 掉线态同样走「重载可救回」：重载会拉一个全新进程起来
      const reloaded = await runtime.reload();
      assert.equal(reloaded.statuses[0]?.status, "connected");
      assert.equal(reloaded.statuses[0]?.error, undefined);
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
