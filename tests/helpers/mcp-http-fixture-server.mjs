/**
 * MCP 测试夹具 server（远程 / Streamable HTTP）。
 *
 * 低层 `Server` 类 + 裸 JSON Schema，与 stdio 夹具**同构**——被验证的是「远程传输分支
 * 与 stdio 走同一条包装路径」，不是 SDK 自己的 HTTP 实现。
 *
 * **无状态模式**（`sessionIdGenerator: undefined`）必须**每个请求新建一套 transport + server**：
 * 这是 SDK 的明文要求（共用一套会让第二个请求（`notifications/initialized`）回 500，
 * 实测确认过）。所以下面是一个 `makeServer()` 工厂，而不是模块级单例。
 *
 * 两个工具：
 * - echo：正常往返，证明 url 配置真的能连上并调用；
 * - auth：回显**收到的 Authorization 头**，证明 `headers` 配置真的透传到了请求里
 *   （只看「连通了」是不够的——不传 header 也照样连通）。
 *
 * 端口由命令行给出（`node <file> <port>`），测试先取一个空闲端口再传入。
 */
import { createServer } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";

const port = Number(process.argv[2]);

const ECHO_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
};

function makeServer() {
  const server = new Server(
    { name: "http-fixture", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      { name: "echo", description: "回显输入文本（远程）", inputSchema: ECHO_SCHEMA },
      {
        name: "auth",
        description: "回显收到的 Authorization 头",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args } = request.params;
    if (name === "echo") return { content: [{ type: "text", text: `http-echo:${args?.text ?? ""}` }] };
    if (name === "auth") {
      // v2 的 `ctx.http.req` 是 Web 标准 Request，`headers` 是 **Headers 对象**：
      // 只能用 `.get()`（大小写不敏感），方括号取键在 v2 里**恒为 undefined**
      // ——迁移文档专门点了这条。不换成 .get() 会得到「永远 auth:none」的假阴性，
      // 看起来像「客户端不转发 headers」的产品缺陷（实测踩过）。
      const auth = ctx?.http?.req?.headers?.get("authorization") ?? "none";
      return { content: [{ type: "text", text: `auth:${auth}` }] };
    }
    throw new Error(`未知工具：${name}`);
  });

  return server;
}

createServer((req, res) => {
  void (async () => {
    const server = makeServer();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  })().catch((error) => {
    console.error("mcp http fixture failed", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    }
  });
}).listen(port, "127.0.0.1");
