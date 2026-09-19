import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const ECHO_SCHEMA = {
  type: "object",
  properties: { text: { type: "string", description: "要回显的文本" } },
  required: ["text"],
};

// 三面都声明：tools + resources + prompts。能力工具只在**声明了**对应面时才加，
// 所以这个夹具是「能力面被包成内核工具」那条链路的唯一物证。
const server = new Server(
  { name: "caps", version: "0.0.1" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler("tools/list", async () => ({
  tools: [{ name: "echo", description: "回显输入文本", inputSchema: ECHO_SCHEMA }],
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "echo") return { content: [{ type: "text", text: `caps-echo:${args?.text ?? ""}` }] };
  throw new Error(`未知工具：${name}`);
});

server.setRequestHandler("resources/list", async () => ({
  resources: [
    { uri: "caps://note", name: "note", description: "一段文本资源", mimeType: "text/plain" },
    { uri: "caps://logo", name: "logo", description: "一张二进制资源", mimeType: "image/png" },
  ],
}));

server.setRequestHandler("resources/templates/list", async () => ({
  resourceTemplates: [{ uriTemplate: "caps://item/{id}", name: "item", description: "按 id 取条目" }],
}));

server.setRequestHandler("resources/read", async (request) => {
  const { uri } = request.params;
  if (uri === "caps://note") {
    return { contents: [{ uri, mimeType: "text/plain", text: "资源正文：hello" }] };
  }
  if (uri === "caps://logo") {
    // base64("ABC")——客户端**不该**把它展开进上下文（既费 token 又读不了）
    return { contents: [{ uri, mimeType: "image/png", blob: "QUJD" }] };
  }
  throw new Error(`未知资源：${uri}`);
});

server.setRequestHandler("prompts/list", async () => ({
  prompts: [
    {
      name: "greet",
      description: "按名字打招呼",
      arguments: [{ name: "who", description: "对谁打招呼", required: true }],
    },
    { name: "plain", description: "无参提示词" },
  ],
}));

server.setRequestHandler("prompts/get", async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "greet") {
    return {
      description: "按名字打招呼",
      messages: [
        { role: "user", content: { type: "text", text: `你好，${args?.who ?? "?"}` } },
      ],
    };
  }
  if (name === "plain") {
    return { messages: [{ role: "user", content: { type: "text", text: "无参提示词正文" } }] };
  }
  throw new Error(`未知提示词：${name}`);
});

await server.connect(new StdioServerTransport());
