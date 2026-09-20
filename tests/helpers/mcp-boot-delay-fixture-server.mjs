import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { Server } from "@modelcontextprotocol/server";

// 一个「起得慢」的夹具：进程先睡 `COLT_MCP_BOOT_MS`（默认 0 毫秒）**再**接 stdio。
// 测试靠它把两件原本看不见的事变成可观测的：
//   · 多台慢 server 是**并行**连还是逐台串行（串行的耗时会叠加）；
//   · 超预算的那台有没有真的转后台（会话应当先就绪，工具随后补上）。
// 睡眠放在 `server.connect` 之前：客户端的握手请求会一直等到进程开始读 stdin，
// 于是「连接耗时」≈ 睡眠时长，而不会被 15s 的单步超时先掐断。
// 可选：每次进程启动往这个文件追加一行**时间戳**（`COLT_MCP_START_LOG`，与
// `mcp-fixture-server.mjs` 那行 "start" 同一条通道，只是换成时刻）。
// 「并行连接」这件事从工具清单 / 状态上都看不出来（结果一样），只有「几个进程是不是
// 同时起来的」看得见——串行连接会把它们逐台错开至少一台的耗时。
if (process.env.COLT_MCP_START_LOG) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.COLT_MCP_START_LOG, `${Date.now()}\n`);
}

const boot = Number(process.env.COLT_MCP_BOOT_MS ?? 0);
if (boot > 0) await new Promise((resolve) => setTimeout(resolve, boot));

const server = new Server({ name: "boot-delay", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "ping",
      description: "总是回 pong（本夹具只用来拖慢连接，不测调用）",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler("tools/call", async () => ({ content: [{ type: "text", text: "pong" }] }));

await server.connect(new StdioServerTransport());
