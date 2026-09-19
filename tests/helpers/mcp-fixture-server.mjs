import { appendFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

// 可选：每次**进程启动**往这个文件追加一行。测试靠它数「同一台 server 起了几个进程」——
// 并发重载若没做互斥，会把同一台连两遍，而那次多出来的 client（连带子进程）只留在
// `liveClients` 里，从工具清单/状态上看不出来，只有「起了几个进程」看得见。
if (process.env.COLT_MCP_START_LOG) {
  appendFileSync(process.env.COLT_MCP_START_LOG, "start\n");
}

const ECHO_SCHEMA = {
  type: "object",
  properties: { text: { type: "string", description: "要回显的文本" } },
  required: ["text"],
};

const ADD_SCHEMA = {
  type: "object",
  properties: { a: { type: "number" }, b: { type: "number" } },
  required: ["a", "b"],
};

const server = new Server({ name: "fixture", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler("tools/list", async () => ({
  tools: [
    { name: "echo", description: "回显输入文本", inputSchema: ECHO_SCHEMA },
    { name: "add", description: "两数相加", inputSchema: ADD_SCHEMA },
    { name: "fail", description: "总是以 isError 返回", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "echo") return { content: [{ type: "text", text: `echo:${args?.text ?? ""}` }] };
  if (name === "add") return { content: [{ type: "text", text: String((args?.a ?? 0) + (args?.b ?? 0)) }] };
  if (name === "fail") return { isError: true, content: [{ type: "text", text: "fixture 工具按约定失败" }] };
  throw new Error(`未知工具：${name}`);
});

await server.connect(new StdioServerTransport());
