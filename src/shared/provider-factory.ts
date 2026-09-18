// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * Provider 装配：由会话选定的 provider 配置构造 pi-ai 的 Provider 实例。
 *
 * 主进程（审批分析器判定可否自动放行）与 worker（会话主循环）都要按同一份配置
 * 现装现用：内置 DeepSeek 走官方工厂（自带 compat 与计价元数据），自定义 endpoint
 * 用 createProvider 现搭并复用 openai-completions 的 API 层。两家协议差异必须收敛在
 * 这里，否则两侧行为会随内核升级各自分叉。
 *
 * 仅 main / worker 可用：本模块直接依赖 pi-ai，渲染层不得 import
 * （worker-protocol 保持“渲染层零 pi 依赖”的约定，故契约只引用本模块的类型）。
 */
import { createProvider, envApiKeyAuth, lazyApi } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
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

/** 装配 provider；返回类型沿用 deepseekProvider 以便统一交给 setProvider */
export function buildProvider(config: ProviderBuildConfig): ReturnType<typeof deepseekProvider> {
  if (config.kind === "deepseek") return deepseekProvider();

  const openAICompletionsApi = lazyApi(
    () => import("@earendil-works/pi-ai/api/openai-completions"),
  );

  return createProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${config.name} API key`, ["COLT_PROVIDER_KEY"]) },
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
  }) as ReturnType<typeof deepseekProvider>;
}
