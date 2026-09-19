import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

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
