import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const server = new Server({ name: "crash-fixture", version: "0.0.1" }, {
  capabilities: { tools: {} },
});

server.setRequestHandler("tools/list", async () => ({
  tools: [
    { name: "ping", description: "正常往返", inputSchema: { type: "object", properties: {} } },
    {
      name: "boom",
      description: "让本进程立刻退出（模拟崩溃），不回响应",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name } = request.params;
  if (name === "ping") return { content: [{ type: "text", text: "pong" }] };
  if (name === "boom") process.exit(0);
  throw new Error(`未知工具：${name}`);
});

await server.connect(new StdioServerTransport());
