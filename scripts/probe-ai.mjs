import { createModels, createProvider, envApiKeyAuth, lazyApi } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

// 看一个真实 model 的完整结构
const models = createModels();
models.setProvider(deepseekProvider());
const m = models.getModel("deepseek", "deepseek-v4-flash");
console.log("MODEL SHAPE:", JSON.stringify(m, null, 2).slice(0, 900));

// 自建 OpenAI 兼容 provider
const api = () => lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions"));
const custom = createProvider({
  id: "custom-test",
  name: "自定义测试",
  baseUrl: "https://api.deepseek.com",
  auth: { apiKey: envApiKeyAuth("Custom API key", ["CUSTOM_API_KEY"]) },
  models: [{ ...m, id: "deepseek-v4-flash", provider: "custom-test" }],
  api: api(),
});
models.setProvider(custom);
const cm = models.getModel("custom-test", "deepseek-v4-flash");
console.log("CUSTOM OK:", cm?.id, cm?.provider, cm?.baseUrl);
