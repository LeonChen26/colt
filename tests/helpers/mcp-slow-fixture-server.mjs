import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

// 一个「慢工具」夹具：调 `sleep` 会真的等 `ms` 毫秒再回。测试靠它把「配置的调用超时
// 到底有没有传到 SDK」变成可观测的行为——太快返回的工具证明不了超时被透传了。
const SLEEP_SCHEMA = {
  type: "object",
  properties: { ms: { type: "number", description: "等待毫秒数" } },
  required: ["ms"],
};

const server = new Server({ name: "slow", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler("tools/list", async () => ({
  tools: [{ name: "sleep", description: "等待指定毫秒后返回", inputSchema: SLEEP_SCHEMA }],
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== "sleep") throw new Error(`未知工具：${name}`);
  const ms = typeof args?.ms === "number" ? args.ms : 0;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { content: [{ type: "text", text: `slept:${ms}` }] };
});

await server.connect(new StdioServerTransport());
