// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * Provider 装配：由会话选定的 provider 配置构造 pi-ai 的 Provider 实例。
 *
 * 主进程（审批分析器判定可否自动放行）与 worker（会话主循环）都要按同一份配置
 * 现装现用：内置 DeepSeek 与自定义 endpoint 都走 createProvider，复用
 * openai-completions 的 API 层。两家装配差异必须收敛在这里，否则两侧行为会随内核升级各自分叉。
 *
 * ⚠️ **密钥只经参数进来，绝不读环境变量**（工作包 B）：
 * 装配走的是 `memoryApiKeyAuth`（闭包持有密钥），`envApiKeyAuth` 那条路已经拆掉——
 * worker 的环境里不再有任何密钥（见 `main/lib/worker-env.ts`），只要这里还留着
 * 「回落读 env」的写法，那条链就随时会被人重新接上。
 *
 * 仅 main / worker 可用：本模块直接依赖 pi-ai，渲染层不得 import
 * （worker-protocol 保持“渲染层零 pi 依赖”的约定，故契约只引用本模块的类型）。
 */
import { createProvider, lazyApi, type ApiKeyAuth } from "@earendil-works/pi-ai";
import type { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { LEGACY_MAX_TOKENS } from "./model-option";

/** 装配所需的模型项（与 protocol 的 ModelOption 同形；能力/计价均为可选声明） */
export interface ProviderBuildModel {
  id: string;
  name: string;
  contextWindow: number;
  imageInput?: boolean;
  reasoning?: boolean;
  maxTokens?: number;
  price?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

/** 装配所需的最小 provider 配置（不含 builtin / hasKey 等仅供界面展示的字段） */
export interface ProviderBuildConfig {
  id: string;
  name: string;
  kind: "deepseek" | "openai-compatible";
  baseUrl: string;
  models: ProviderBuildModel[];
}

/**
 * 下发到 worker 的 provider 目录项：`ProviderBuildConfig` + 一个「要不要密钥」的声明。
 *
 * 为什么要 `requiresKey`：worker 拿到的是**非密钥**配置，而「这家要不要密钥」决定了
 * 「取不到密钥」是错误还是正常（无密钥的本地服务拿到的会是占位符）。
 */
export interface ProviderDirectoryEntry extends ProviderBuildConfig {
  requiresKey: boolean;
}

/**
 * 无密钥本地服务（ollama / vLLM / llama.cpp …）装配时用的占位密钥。
 *
 * ⚠️ 不是 bug 是特性：`openai-completions` 在 apiKey 为空时直接抛
 * 「No API key for provider」——它分不清「本地服务不需要密钥」和「用户忘了填」。
 * 故「没有密钥」这件事必须有两条表达：**要不要密钥**是 provider 的属性（requiresKey），
 * **给什么值**是装配层的事（这个占位符）。让空串代替它，就会打破上面那条校验。
 *
 * 定义在这里而不是某个调用方：主进程（fork / 取密钥）与 worker（取密钥）都要用同一份。
 */
export const KEYLESS_PLACEHOLDER = "colt-local-no-key";

/** 装配 provider；返回类型沿用 deepseekProvider 以便统一交给 setProvider */
export function buildProvider(
  config: ProviderBuildConfig,
  apiKey: string | undefined,
): ReturnType<typeof deepseekProvider> {
  const openAICompletionsApi = lazyApi(
    () => import("@earendil-works/pi-ai/api/openai-completions"),
  );

  if (config.kind === "deepseek") {
    // 与 `deepseekProvider()` **逐字段同装配**，只把密钥来源换掉：模型表仍取
    // `DEEPSEEK_MODELS` 原表（不是 `config.models` 那份投影——兼容层要的 `compat`、
    // `thinkingLevelMap`、价格都在原表里，用投影会静默丢掉思考等级与计价）。
    return createProvider<"openai-completions">({
      id: config.id,
      name: config.name,
      baseUrl: config.baseUrl,
      auth: { apiKey: memoryApiKeyAuth(`${config.name} API key`, apiKey) },
      models: Object.values(DEEPSEEK_MODELS),
      api: openAICompletionsApi,
    });
  }

  return createProvider<"openai-completions">({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: { apiKey: memoryApiKeyAuth(`${config.name} API key`, apiKey) },
    models: config.models.map((option) => ({
      id: option.id,
      name: option.name,
      api: "openai-completions" as const,
      baseUrl: config.baseUrl,
      provider: config.id,
      // 能力与计价都来自用户的显式声明（设置页表单），缺省值即历史行为
      reasoning: option.reasoning === true,
      input: option.imageInput === true ? (["text", "image"] as const) : (["text"] as const),
      cost: {
        input: option.price?.input ?? 0,
        output: option.price?.output ?? 0,
        cacheRead: option.price?.cacheRead ?? 0,
        cacheWrite: option.price?.cacheWrite ?? 0,
      },
      contextWindow: option.contextWindow,
      maxTokens:
        option.maxTokens !== undefined && option.maxTokens > 0
          ? option.maxTokens
          : Math.min(option.contextWindow, LEGACY_MAX_TOKENS),
    })),
    api: openAICompletionsApi,
  });
}

/**
 * 密钥**只从内存里读**的 ApiKeyAuth：闭包持有传进来的那一个字符串。
 *
 * 与 `envApiKeyAuth` 的唯一区别就是不再去看环境变量——本模块存在的意义有一半在这一行。
 * `apiKey` 为空时**返回 undefined**（而不是给一个空串）：这与「环境变量没配」是同一语义，
 * 上层（审批分析器）本来就会另外显式传 `apiKey` 给 `models.complete`，行为不变。
 */
function memoryApiKeyAuth(name: string, apiKey: string | undefined): ApiKeyAuth {
  return {
    name,
    resolve: async () =>
      apiKey === undefined || apiKey === "" ? undefined : { auth: { apiKey } },
  };
}
