// M1 前置冒烟：直连验证 DeepSeek + JsonlSessionRepo + AgentHarness 全链路
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { AgentHarness, BACKGROUND_CONTEXT, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

const keyFile = "C:\\Users\\glche\\Desktop\\deepseek.txt";
process.env.DEEPSEEK_API_KEY = readFileSync(keyFile, "utf8").trim();

const context = BACKGROUND_CONTEXT;
const cwd = process.cwd();

const models = createModels();
models.setProvider(deepseekProvider());
const model = models.getModel("deepseek", "deepseek-v4-flash");
if (!model) throw new Error("模型未找到");
console.log("[1/5] 模型就绪:", model.provider + "/" + model.id);

const executionEnv = new NodeExecutionEnv({ cwd });
const sessionsRoot = mkdtempSync(join(tmpdir(), "colt-smoke-"));
const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot });
const session = await repo.create({ cwd }, context);
console.log("[2/5] 会话已建:", session.metadata.id);

const { harness } = await AgentHarness.create(
  {
    session,
    models,
    model,
    tools: [],
    toolContext: { env: executionEnv },
    systemPrompt: "你是一个简洁的中文助手。回答控制在一句话内。",
  },
  context,
);
console.log("[3/5] harness 装配完成");

const lane = await harness.lane("main", context);
console.log("[4/5] lane 就绪:", lane.name);

const watch = await lane.watch(context);
let eventCount = 0;
const eventTypes = new Set();
// watch() 后事件先缓冲，start() 才开始投递并排空缓冲
watch.start((event) => {
  eventCount += 1;
  if (event && event.type) eventTypes.add(String(event.type));
});
console.log("[5/6] watch 已订阅，初始快照键:", Object.keys(watch.snapshot || {}).join(","));

const result = await lane.prompt("用一句话说明什么是 SQLite。", undefined, context);
console.log("[6/6] 对话完成");
console.log("---- 回复 ----");
for (const message of result.messages ?? []) {
  if (message.role !== "assistant") continue;
  for (const block of message.content ?? []) {
    if (block.type === "text") console.log(block.text);
  }
  if (message.usage) {
    console.log("---- 用量 ----");
    console.log(JSON.stringify(message.usage));
  }
}
console.log("事件总数:", eventCount);
console.log("事件类型:", [...eventTypes].join(", "));

// 检查最终快照的 transcript 结构（UI 数据源）
const finalSnapshot = await watch.resnapshot(context);
console.log("---- transcript ----");
console.log("条目数:", finalSnapshot.transcript.length);
for (const entry of finalSnapshot.transcript) {
  const kind = entry.type ?? "?";
  if (kind === "message") {
    const msg = entry.message;
    const text = (msg.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    console.log(`  [${kind}] role=${msg.role} text=${JSON.stringify(text.slice(0, 80))}`);
  } else {
    console.log(`  [${kind}]`, JSON.stringify(entry).slice(0, 120));
  }
}
console.log("---- stats ----");
console.log(JSON.stringify(finalSnapshot.stats));

watch.unsubscribe();
await harness.close(context);
await repo.close(context);
console.log("SMOKE_OK");
