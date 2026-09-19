/**
 * MCP 测试夹具 server（**旧式 SSE**，服务端）。
 *
 * 为什么单独一份：`transport: "sse"` 这一支此前**只验过失败路径**（连死端口 → error），
 * 成功路径一个字节都没验过——而「远程 server（HTTP/SSE）」是明写在能力表里的。
 * SSE 与 Streamable HTTP 的服务端形态**不同**（长连 GET /sse 建流 + POST /messages 送消息，
 * 有状态、一个会话一套 transport），拿 http 那份夹具凑合不了。
 *
 * 两个工具：echo（真实往返）/ ping（证明连上时确实可用）。
 *
 * SDK 已把 `SSEServerTransport` 标为 deprecated（新协议推 Streamable HTTP）——这里**故意**用它：
 * 我们要验的恰恰是「客户端能连上遗留的 SSE server」，用新类反而验不到这条。
 */
import { createServer } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import { Server } from "@modelcontextprotocol/server";

const port = Number(process.argv[2]);

/** 每个 SSE 会话一套 transport（有状态，不能像 http 那样每请求新建） */
const transports = new Map();

function makeServer() {
  const server = new Server({ name: "sse-fixture", version: "0.0.1" }, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "echo",
        description: "回显输入文本（SSE）",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      { name: "ping", description: "连通性探针", inputSchema: { type: "object", properties: {} } },
    ],
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "echo") return { content: [{ type: "text", text: `sse-echo:${args?.text ?? ""}` }] };
    if (name === "ping") return { content: [{ type: "text", text: "pong" }] };
    throw new Error(`未知工具：${name}`);
  });

  return server;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  // 建流：GET /sse。`server.connect` 内部会调 transport.start()，把 endpoint 事件发出去
  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/messages", res);
    const server = makeServer();
    transports.set(transport.sessionId, transport);
    res.on("close", () => {
      transports.delete(transport.sessionId);
      void transport.close();
      void server.close();
    });
    void server.connect(transport).catch(() => undefined);
    return;
  }

  // 送消息：POST /messages?sessionId=...
  if (req.method === "POST" && url.pathname === "/messages") {
    const transport = transports.get(url.searchParams.get("sessionId") ?? "");
    if (transport === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void transport.handlePostMessage(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end();
}).listen(port, "127.0.0.1");
