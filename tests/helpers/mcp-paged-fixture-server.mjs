import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

const TOOL_NAMES = ["page1", "page2", "page3", "page4", "page5"];
const PAGE_SIZE = 2;

const server = new Server({ name: "paged", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler("tools/list", async (request) => {
  const start = request.params?.cursor === undefined ? 0 : Number(request.params.cursor);
  const slice = TOOL_NAMES.slice(start, start + PAGE_SIZE);
  const next = start + slice.length;
  return {
    tools: slice.map((name) => ({
      name,
      description: `分页工具 ${name}`,
      inputSchema: { type: "object", properties: {} },
    })),
    ...(next < TOOL_NAMES.length ? { nextCursor: String(next) } : {}),
  };
});

server.setRequestHandler("tools/call", async (request) => {
  const { name } = request.params;
  if (TOOL_NAMES.includes(name)) return { content: [{ type: "text", text: `paged:${name}` }] };
  throw new Error(`未知工具：${name}`);
});

await server.connect(new StdioServerTransport());
