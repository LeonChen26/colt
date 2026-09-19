import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

/**
 * 只报一件事实的夹具：**自己的工作目录**。
 *
 * 用来钉「stdio server 的工作目录 = 会话的项目根」。用户写 `args: ["."]` / `["src"]`
 * 这类相对路径是主流写法（官方 server-filesystem 的例子就是 `.`），而 `.colt/mcp.json`
 * 就住在他的项目里——相对路径当然该相对项目根解析。若子进程继承的是**应用进程的 cwd**，
 * 这些相对路径会静默指到别处（或直接 `Cannot find module`）。
 *
 * 为什么单独一个夹具而不是塞进 `mcp-fixture-server.mjs`：那个夹具的工具清单被好几处
 * 按**逐字**断言（冒烟里「3 个工具名逐字正确」），加一个工具会连带改一堆无关断言。
 */
const server = new Server({ name: "cwd", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "where",
      description: "回报本进程的工作目录",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler("tools/call", async () => ({
  content: [{ type: "text", text: process.cwd() }],
}));

await server.connect(new StdioServerTransport());
