/**
 * MCP 测试夹具 server（stdio）。
 *
 * 刻意用**低层 Server 类**而不是 McpServer 高层封装：高层封装要求 zod 声明入参，
 * 而生产方的真实 MCP server 给出的就是裸 JSON Schema——被验证的恰恰是
 * 「裸 JSON Schema 原样透传给内核」这条路径，夹具必须与生产方同构。
 *
 * 三个工具：echo（正常往返）/ add（数字入参，验证 schema 校验）/ fail（isError 路径）。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "回显输入文本", inputSchema: ECHO_SCHEMA },
    { name: "add", description: "两数相加", inputSchema: ADD_SCHEMA },
    { name: "fail", description: "总是以 isError 返回", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "echo") return { content: [{ type: "text", text: `echo:${args?.text ?? ""}` }] };
  if (name === "add") return { content: [{ type: "text", text: String((args?.a ?? 0) + (args?.b ?? 0)) }] };
  if (name === "fail") return { isError: true, content: [{ type: "text", text: "fixture 工具按约定失败" }] };
  throw new Error(`未知工具：${name}`);
});

await server.connect(new StdioServerTransport());
