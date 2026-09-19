/**
 * MCP 工具接入测试——验证的是**那条架构主张**，不只是客户端能跑：
 *
 *   「MCP 工具以普通内核工具的身份进入，自动过审批闸门，安全模型零例外。」
 *
 * 因此覆盖分六层：
 * 1. 装载与包装：真实 stdio 往返（夹具 server 是独立子进程）、名字前缀、通知如实；
 * 2. 内核契约：裸 JSON Schema 原样透传，且 pi-ai 的 validateToolArguments 真会拿它校验
 *    （缺 required 要抛）——这条钉的是「生产方产出什么、内核接受什么」的接口事实；
 * 3. 闸门链路：包装后的名字不在任何豁免名单（提问 / 子代理 / 只读），
 *    policy 落到「未知工具，按需确认」→ approval 模式必须 ask；
 * 4. 配置健壮性：缺文件不吵、坏 JSON 成诊断、坏 server 不拖死好 server；
 * 5. 能力面（resources / prompts）：**声明了才**包成内核工具，且真实往返到服务端；
 * 6. 声明值与解析值分离、`instructions` 拼进提示词——都在**最终产物**上断言
 *    （与 `renderAgentCatalog` / `renderTodoBlock` 同款：渲染函数验拼出的串）。
 *    注意：`entry.ts` 那**一行调用**本身没有结构断言覆盖（本仓库惯例如此）——
 *    见 `docs/DESIGN-mcp.md` 决策 14 末条的「已知未覆盖」。
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { createServer as createTcpServer, connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import {
  callTimeoutOf,
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
import { composeMcpInstructions } from "../src/worker/lib/mcp-reload.ts";
import { isSubagentTool } from "../src/worker/lib/subagent.ts";
import { READONLY_TOOLS } from "../src/shared/readonly-tools.ts";
import { mcpToolLabel } from "../src/shared/mcp-label.ts";
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
const CAPS_FIXTURE = fileURLToPath(
  new URL("./helpers/mcp-capabilities-fixture-server.mjs", import.meta.url),
);
const CWD_FIXTURE = fileURLToPath(new URL("./helpers/mcp-cwd-fixture-server.mjs", import.meta.url));
const SLOW_FIXTURE = fileURLToPath(new URL("./helpers/mcp-slow-fixture-server.mjs", import.meta.url));

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

/** 数夹具进程启动了几次：`COLT_MCP_START_LOG` 每启一次追加一行，文件不存在即 0 次 */
function countStarts(logPath: string): number {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "").length;
  } catch {
    return 0;
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

  test("stdio server 的工作目录是**项目根**（不是应用进程的 cwd）", async () => {
    const dir = await fixtureProject({
      mcpServers: { cwd: { command: process.execPath, args: [CWD_FIXTURE] } },
    });
    const runtime = await createMcpRuntime(dir, () => undefined);
    try {
      const where = runtime.tools.find((tool) => tool.name === "mcp__cwd__where")!;
      const result = await callTool(where, {});
      // 判据：子进程自报的 cwd **逐字等于**夹具项目目录。
      // worker 是 `utilityProcess.fork(workerPath, [], {…})` 起的、**没带 cwd**，所以不显式传的话
      // 子进程继承的是**应用进程的** cwd（本测试里就是仓库根）——用户的 `args: ["."]` / `["src"]`
      // 随之指到别处（实测：相对参数被解析成 `E:\code\tests\…`，server 直接 Cannot find module）。
      // 先 realpath 归一化再比，免得临时目录的短名 / 符号链接造成假红。
      assert.equal((result.content[0] as { text: string }).text, await realpath(dir));
    } finally {
      await runtime.close();
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
    // 内嵌资源里的**二进制**：只说清「二进制 + MIME + 长度」、不展开；**更不能**被说成
    // 「不支持的内容块类型：resource」——`resource` 是支持的类型，此前只认 `.text` 的说法是反的
    const blob = mapMcpContent({
      content: [
        { type: "resource", resource: { uri: "caps://logo", mimeType: "image/png", blob: "QUJD" } },
      ],
    });
    const blobText = (blob[0] as { text: string }).text;
    assert.match(blobText, /二进制/);
    assert.match(blobText, /image\/png/);
    assert.ok(!blobText.includes("不支持"), `把支持的类型说成了不支持：${blobText}`);
    assert.ok(!blobText.includes("QUJD"), `二进制被展开进上下文了：${blobText}`);
    // 既没有 text 也没有 blob：如实说「没有可读内容」，同样不算「不支持的类型」
    assert.deepEqual(mapMcpContent({ content: [{ type: "resource", resource: { uri: "caps://void" } }] }), [
      { type: "text", text: "[mcp] 资源 caps://void 没有可读内容" },
    ]);
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

  test("单次 listTools()（不传 cursor）就拿回全部 5 个、nextCursor 为空——我们据此不写循环", async () => {
    // 这条钉的是**依赖的契约**（同 validateToolArguments 那条）：生产代码 `listAllTools`
    // 只调一次 `listTools()`，成不成全看 v2 这句「不传 cursor 就自己翻完所有页」。
    // 哪天 SDK 改成不聚合，这条先红，而不是等到线上只剩第一页工具。夹具 5 个工具 / 每页 2 个。
    const client = new Client({ name: "paged-probe", version: "0.0.1" }, { listMaxPages: 100 });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [PAGED_FIXTURE] }),
    );
    try {
      const all = await client.listTools();
      assert.equal(all.tools.length, 5);
      assert.equal(all.nextCursor, undefined);
      // 反面：显式给 cursor 才回单页（证明上面那 5 条真是「翻完聚合」，不是 server 一页给全）
      const page = await client.listTools({ cursor: "0" });
      assert.equal(page.tools.length, 2);
      assert.equal(page.nextCursor, "2");
    } finally {
      await client.close();
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

  test("两个 reload 并发：同一台 server 只连一次（命令入口不排队，共享状态得自己互斥）", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const startLog = join(dir, "starts.log");
    const runtime = await createMcpRuntime(dir, () => undefined);
    try {
      // 改配置（加一个无害的 env）：下一次重载**必须重连**，这才有「连两遍」的机会。
      // 启动日志只在改了配置之后才挂上，于是它数的正好是**这次重载起了几个进程**。
      await writeFile(
        join(dir, ".colt", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            fixture: {
              command: process.execPath,
              args: [FIXTURE],
              env: { COLT_MCP_START_LOG: startLog },
            },
          },
        }),
        "utf8",
      );
      const [a, b] = await Promise.all([runtime.reload(), runtime.reload()]);
      assert.equal(a.statuses[0]?.status, "connected");
      assert.equal(b.statuses[0]?.status, "connected");
      assert.deepEqual(a.tools.map((tool) => tool.name), b.tools.map((tool) => tool.name));
      // 判据：并发重载只**起了一个** server 进程。没有互斥时两个 reload 都会判定「配置变了」，
      // 各自 close 一次、各自 connect 一次——多出来的那个 client 只留在 liveClients 里（连着
      // 一个子进程），从工具清单和 status 上都看不出来，只有「起了几个进程」看得见。
      assert.equal(countStarts(startLog), 1, "并发重载把同一台 server 连了两遍（泄漏一个子进程）");
    } finally {
      await runtime.close();
      // maxRetries：Windows 上刚退出的子进程会短暂占着它的 cwd（正是本项目目录），
      // 目录可能当场删不掉（EBUSY）——那是**清理**的时序问题，不该变成假红
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    const notices: string[] = [];
    const runtime = await createMcpRuntime(dir, (message) => notices.push(message));
    try {
      assert.equal(runtime.status()[0]?.status, "connected");
      const ping = runtime.tools.find((tool) => tool.name === "mcp__crash__ping")!;
      assert.deepEqual((await callTool(ping, {})).content, [{ type: "text", text: "pong" }]);
      // 装载摘要是**唯一**一条「没事也报一声」的通知，掉线通知不能混在里面
      const loaded = notices.length;

      // 让 server 自杀：它不回响应，这次调用注定失败——只当扳机用
      const boom = runtime.tools.find((tool) => tool.name === "mcp__crash__boom")!;
      void callTool(boom, {}).catch(() => undefined);

      await waitFor(() => runtime.status()[0]?.status === "error");
      assert.match(runtime.status()[0]?.error ?? "", /连接已断开/);

      // 掉线**必须作声**：工具还留在清单里（决策 11 不伪造结果），光翻 status 等于
      // 要用户自己开设置页才知道。判据取「通知里点名了那台 server」，且**只报一次**
      // （HTTP 传输会重复触发 onclose，重复通知就是噪音）
      const dropped = notices.filter((message) => message.includes("掉线"));
      assert.equal(dropped.length, 1, `掉线通知应当恰好一条，实得：${JSON.stringify(notices)}`);
      assert.match(dropped[0] ?? "", /"crash"/);
      assert.match(dropped[0] ?? "", /重新加载/);
      assert.equal(notices.length, loaded + 1);

      // 掉线态同样走「重载可救回」：重载会拉一个全新进程起来
      const reloaded = await runtime.reload();
      assert.equal(reloaded.statuses[0]?.status, "connected");
      assert.equal(reloaded.statuses[0]?.error, undefined);
      // 我们主动关的（reload / dispose）**不算掉线**：重连后不该又冒一条掉线通知
      assert.equal(notices.filter((message) => message.includes("掉线")).length, 1);
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("声明值与解析值分离（${VAR} 既不泄露、也不白重连）", () => {
  test("target 显示声明里的 ${VAR}（不是解析后的密钥），且配置没变时不重连", async () => {
    const previous = process.env.COLT_MCP_PROBE_TOKEN;
    process.env.COLT_MCP_PROBE_TOKEN = "s3cr3t-LEAK";
    const dir = await fixtureProject({
      mcpServers: {
        leaky: { command: process.execPath, args: [FIXTURE, "--token", "${COLT_MCP_PROBE_TOKEN}"] },
      },
    });
    const runtime = await createMcpRuntime(dir, () => undefined);
    try {
      // ① 设置页画的就是 status().target——它必须停在声明值上，否则真实密钥会画在界面上
      const target = runtime.status()[0]?.target ?? "";
      assert.ok(target.includes("${COLT_MCP_PROBE_TOKEN}"), `target 丢了声明值：${target}`);
      assert.ok(!target.includes("s3cr3t-LEAK"), `target 泄露了解析后的密钥：${target}`);

      // ② 配置一字未改 → 不该重连。判据取工具对象的**引用同一性**：重连会重新 wrap，
      //    引用就变了。若 state.config 存的是解析值，configKey 与文件里的声明永远不等，
      //    这里必红（每次「重新加载」都白重连一次，决策 7 明说不该重连）。
      const before = runtime.tools.find((tool) => tool.name === "mcp__leaky__echo");
      assert.ok(before !== undefined);
      const reloaded = await runtime.reload();
      assert.equal(reloaded.statuses[0]?.status, "connected");
      assert.equal(runtime.tools.find((tool) => tool.name === "mcp__leaky__echo"), before);
    } finally {
      await runtime.close();
      if (previous === undefined) delete process.env.COLT_MCP_PROBE_TOKEN;
      else process.env.COLT_MCP_PROBE_TOKEN = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resources / prompts 能力：声明了才包成工具，且走同一套闸门", () => {
  const gateConfig: PolicyConfig = { mode: "approval", projectRoot: "E:/proj", allowRules: [] };

  test("三面都声明的 server：多出 4 个能力工具，且真实往返到服务端", async () => {
    const dir = await fixtureProject({
      mcpServers: { caps: { command: process.execPath, args: [CAPS_FIXTURE] } },
    });
    const runtime = await createMcpRuntime(dir, () => undefined);
    try {
      assert.deepEqual(runtime.tools.map((tool) => tool.name).sort(), [
        "mcp__caps__echo",
        "mcp__caps__get_prompt",
        "mcp__caps__list_prompts",
        "mcp__caps__list_resources",
        "mcp__caps__read_resource",
      ]);

      // 能力工具与普通工具**同一套**安全模型：不在任何豁免名单、policy 落到「不认识就问」
      for (const tool of runtime.tools) {
        assert.equal(READONLY_TOOLS.has(tool.name), false, `${tool.name} 混进了只读白名单`);
        assert.equal(evaluateTool({ toolName: tool.name, args: {} }, gateConfig).decision, "ask");
      }

      const listResources = runtime.tools.find((tool) => tool.name === "mcp__caps__list_resources")!;
      const listed = (await callTool(listResources, {})).content[0]!.text ?? "";
      assert.match(listed, /caps:\/\/note/);
      // 资源模板也在（模板列举失败会被静默留空，这条正是钉住它没失败）
      assert.match(listed, /caps:\/\/item\/\{id\}/);

      const readResource = runtime.tools.find((tool) => tool.name === "mcp__caps__read_resource")!;
      assert.deepEqual((await callTool(readResource, { uri: "caps://note" })).content, [
        { type: "text", text: "资源正文：hello" },
      ]);
      // 二进制资源**不展开**成 base64——只要「二进制 + 类型」说清了
      const blob = (await callTool(readResource, { uri: "caps://logo" })).content[0]!.text ?? "";
      assert.match(blob, /二进制/);
      assert.match(blob, /image\/png/);
      assert.ok(!blob.includes("QUJD"), `二进制被展开进上下文了：${blob}`);

      const listPrompts = runtime.tools.find((tool) => tool.name === "mcp__caps__list_prompts")!;
      assert.match((await callTool(listPrompts, {})).content[0]!.text ?? "", /greet/);

      // 参数**真的到了服务端**（服务端按参数渲染）——这是「包成工具」而非「客户端格式化」的物证
      const getPrompt = runtime.tools.find((tool) => tool.name === "mcp__caps__get_prompt")!;
      assert.deepEqual(
        (await callTool(getPrompt, { name: "greet", arguments: { who: "Colt" } })).content,
        [{ type: "text", text: "user: 你好，Colt" }],
      );
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("只声明 tools 的 server：一个能力工具都不加（别放用不上的入口）", async () => {
    const dir = await fixtureProject(fixtureServerConfig());
    const notices: string[] = [];
    const runtime = await createMcpRuntime(dir, (message) => notices.push(message));
    try {
      assert.deepEqual(runtime.tools.map((tool) => tool.name).sort(), [
        "mcp__fixture__add",
        "mcp__fixture__echo",
        "mcp__fixture__fail",
      ]);
      // 摘要里的计数也不该把能力工具算进去
      assert.match(notices.join("；"), /fixture（3 个工具）/);
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("server 自报的 instructions（SDK 不会替你注入）", () => {
  test("instructions() 如实带出，composeMcpInstructions 拼成块；没报的原样返回 base", async () => {
    const capsDir = await fixtureProject({
      mcpServers: { caps: { command: process.execPath, args: [CAPS_FIXTURE] } },
    });
    const plainDir = await fixtureProject(fixtureServerConfig());
    const caps = await createMcpRuntime(capsDir, () => undefined);
    const plain = await createMcpRuntime(plainDir, () => undefined);
    try {
      // 取值口如实反映握手内容
      assert.deepEqual(caps.instructions(), [
        { server: "caps", text: "caps 用法：先 list_resources 看有什么，再 read_resource 取正文。" },
      ]);
      // 没报的 server 不产出条目（否则会给每台 server 都拼一个空标题）
      assert.deepEqual(plain.instructions(), []);

      const composed = composeMcpInstructions("BASE", caps);
      assert.ok(composed.startsWith("BASE\n\n"), `基线必须原样在前：${composed.slice(0, 24)}`);
      assert.match(composed, /MCP server 自报的用法说明/);
      assert.match(composed, /### caps/);
      assert.match(composed, /先 list_resources 看有什么/);

      // 没 instructions 时**原样返回**——多一个换行都会让拼出的串每次都变、提示词缓存失效
      assert.equal(composeMcpInstructions("BASE", plain), "BASE");
    } finally {
      await caps.close();
      await plain.close();
      await rm(capsDir, { recursive: true, force: true });
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});

describe("两级配置：用户级（~/.colt/mcp.json）+ 项目级", () => {
  /** 造一个「用户目录」（可含 .colt/mcp.json），与 fixtureProject 对称 */
  async function homeDir(config?: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "colt-home-"));
    await mkdir(join(dir, ".colt"), { recursive: true });
    if (config !== undefined) {
      await writeFile(join(dir, ".colt", "mcp.json"), JSON.stringify(config), "utf8");
    }
    return dir;
  }

  test("合并两层，项目级同名**覆盖**用户级；不传 home 只读项目级", async () => {
    const project = await fixtureProject({
      mcpServers: { shared: { command: "project-cmd" }, onlyProject: { command: "p" } },
    });
    const home = await homeDir({
      mcpServers: { shared: { command: "user-cmd" }, onlyUser: { command: "u" } },
    });
    try {
      const merged = await loadMcpConfig(project, home);
      assert.deepEqual(Object.keys(merged.servers).sort(), ["onlyProject", "onlyUser", "shared"]);
      // 覆盖：同名以项目级那条为准；用户级独有的照常带出
      assert.equal(merged.servers.shared?.command, "project-cmd");
      assert.equal(merged.servers.onlyUser?.command, "u");
      // 不传 home ⇒ 只读项目级：单测的结论不随开发者的 `~/.colt/mcp.json` 漂移
      const projectOnly = await loadMcpConfig(project);
      assert.deepEqual(Object.keys(projectOnly.servers).sort(), ["onlyProject", "shared"]);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("诊断点名是哪个文件出的问题（项目级在前、用户级在后）", async () => {
    const project = await fixtureProject({ mcpServers: { badProject: {} } });
    const home = await homeDir();
    await writeFile(join(home, ".colt", "mcp.json"), "{ 这不是 JSON", "utf8");
    try {
      const { diagnostics } = await loadMcpConfig(project, home);
      assert.equal(diagnostics.length, 2);
      assert.match(diagnostics[0]!, /^\.colt\/mcp\.json/);
      assert.match(diagnostics[0]!, /"badProject"/);
      assert.match(diagnostics[1]!, /^~\/\.colt\/mcp\.json/);
      assert.match(diagnostics[1]!, /不是合法 JSON/);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("把 home 交给 runtime，用户级声明的 server 真的连上并出工具", async () => {
    const project = await fixtureProject({ mcpServers: {} });
    const home = await homeDir({
      mcpServers: { global: { command: process.execPath, args: [FIXTURE] } },
    });
    const runtime = await createMcpRuntime(project, () => undefined, home);
    try {
      assert.deepEqual(runtime.tools.map((tool) => tool.name).sort(), [
        "mcp__global__add",
        "mcp__global__echo",
        "mcp__global__fail",
      ]);
    } finally {
      await runtime.close();
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("展示名：注册名 → 人话", () => {
  test("mcpToolLabel：MCP 工具翻成 `MCP server: tool`；非 MCP 名回落 undefined", () => {
    assert.equal(mcpToolLabel("mcp__alpha__echo"), "MCP alpha: echo");
    // 清洗过的名字照实显示（注册名与展示名同源——不给同一工具两个说法）
    assert.equal(mcpToolLabel("mcp__my_server__read_file"), "MCP my_server: read_file");
    assert.equal(mcpToolLabel("read"), undefined);
    assert.equal(mcpToolLabel("bash"), undefined);
    // 形状不完整（缺 server / 缺 tool）不硬翻
    assert.equal(mcpToolLabel("mcp__onlyserver"), undefined);
    assert.equal(mcpToolLabel("mcp__s__"), undefined);
  });
});

describe("调用超时：按 server / 工具可配（默认仍是 SDK 的 60s）", () => {
  test("callTimeoutOf：工具级覆盖 > server 级 > undefined（退回 60s）", () => {
    const config = parseServerConfig("s", {
      command: "x",
      timeout: 1000,
      toolTimeouts: { slow: 5000 },
    }) as McpServerConfig;
    assert.equal(callTimeoutOf(config), 1000);
    assert.equal(callTimeoutOf(config, "slow"), 5000);
    assert.equal(callTimeoutOf(config, "other"), 1000);
    assert.equal(callTimeoutOf({ command: "x" }), undefined);
    assert.equal(callTimeoutOf({ command: "x" }, "slow"), undefined);
  });

  test("timeout / toolTimeouts 非法时成诊断，不静默接受", () => {
    assert.match(parseServerConfig("s", { command: "x", timeout: 0 }) as string, /timeout 必须是正数/);
    assert.match(parseServerConfig("s", { command: "x", timeout: "5" }) as string, /timeout 必须是正数/);
    assert.match(
      parseServerConfig("s", { command: "x", toolTimeouts: { slow: -1 } }) as string,
      /toolTimeouts 必须是/,
    );
    assert.match(
      parseServerConfig("s", { command: "x", toolTimeouts: [] }) as string,
      /toolTimeouts 必须是/,
    );
  });

  test("改了超时就是配置变了：热重载会重连（新值才进得了 execute 的闭包）", () => {
    const base = parseServerConfig("s", { command: "x" }) as McpServerConfig;
    const bumped = parseServerConfig("s", { command: "x", timeout: 5000 }) as McpServerConfig;
    assert.notEqual(configKey(base), configKey(bumped));
    const perTool = parseServerConfig("s", {
      command: "x",
      toolTimeouts: { slow: 5000 },
    }) as McpServerConfig;
    assert.notEqual(configKey(base), configKey(perTool));
  });

  test("server 级 timeout 真的掐断长调用（超时确实传到了 SDK，不只是解析了配置）", async () => {
    const dir = await fixtureProject({
      mcpServers: {
        slow: { command: process.execPath, args: [SLOW_FIXTURE], timeout: 60 },
      },
    });
    const runtime = await createMcpRuntime(dir, () => undefined);
    try {
      const sleep = runtime.tools.find((tool) => tool.name === "mcp__slow__sleep")!;
      // 夹具要睡 400ms，而 server 级超时 60ms：调用必须被就地掐断
      await assert.rejects(() => callTool(sleep, { ms: 400 }));
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("toolTimeouts 覆盖 server 级：同一个慢调用从被掐断变成跑完", async () => {
    const dir = await fixtureProject({
      mcpServers: {
        slow: {
          command: process.execPath,
          args: [SLOW_FIXTURE],
          timeout: 40,
          toolTimeouts: { sleep: 8000 },
        },
      },
    });
    const runtime = await createMcpRuntime(dir, () => undefined);
    try {
      const sleep = runtime.tools.find((tool) => tool.name === "mcp__slow__sleep")!;
      const result = await callTool(sleep, { ms: 300 });
      assert.deepEqual(result.content, [{ type: "text", text: "slept:300" }]);
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
