// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * Provider 目录的**非密钥投影**：主进程在下发 init 时把全部 provider 的配置交给 worker，
 * 让子代理能按定义里的 `model: providerId/modelId` 切到**别的**服务上
 * （`docs/impl-plan-three-gaps-2026-10.md` 工作包 C）。
 *
 * ⚠️ 投影必须用**白名单手法**：逐个字段挑出来，绝不允许
 * `{ ...provider, apiKey: undefined }` 这种黑名单写法。黑名单有两个真实的坑：
 *   ① `apiKey: undefined` 这个**键名**照样会被序列化进结构化克隆的产物里，
 *      密钥字段名从此散落在沿途每一份消息对象上；
 *   ② 将来给 ProviderConfig 加一个 `oauthToken`，黑名单没人会记得回来补——
 *      白名单则天然是「没写就是不给」。
 *
 * 密钥**不在这份投影里**，也永远不该在：worker 需要某家密钥时经
 * `providerKey` 宿主能力按需取一次（见 `shared/worker-protocol.ts` 的 HostCapability）。
 */
import type { ProviderConfig } from "./protocol";
import type { ProviderBuildConfig, ProviderDirectoryEntry } from "./provider-factory";

/** 把一个 `ModelOption` 投影成装配侧的模型项（同样是逐字段白名单） */
function toDirectoryModel(option: ProviderConfig["models"][number]): ProviderBuildConfig["models"][number] {
  return {
    id: option.id,
    name: option.name,
    contextWindow: option.contextWindow,
    ...(option.imageInput === undefined ? {} : { imageInput: option.imageInput }),
    ...(option.reasoning === undefined ? {} : { reasoning: option.reasoning }),
    ...(option.maxTokens === undefined ? {} : { maxTokens: option.maxTokens }),
    ...(option.price === undefined
      ? {}
      : {
          price: {
            ...(option.price.input === undefined ? {} : { input: option.price.input }),
            ...(option.price.output === undefined ? {} : { output: option.price.output }),
            ...(option.price.cacheRead === undefined ? {} : { cacheRead: option.price.cacheRead }),
            ...(option.price.cacheWrite === undefined ? {} : { cacheWrite: option.price.cacheWrite }),
          },
        }),
  };
}

/**
 * `ProviderConfig` → 可下发给 worker 的目录项。
 *
 * 注意 `builtin` / `hasKey` 刻意不带：前者是界面用不到的展示字段，后者是「本机有没有
 * 密钥」的状态——它不该让 worker 知道（worker 只会在真的要用时问一次）。
 */
export function toDirectoryEntry(provider: ProviderConfig): ProviderDirectoryEntry {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    models: provider.models.map(toDirectoryModel),
    // 只有显式的 false 才是「无需密钥」，缺字段一律按需要密钥处理（宁严勿松）
    requiresKey: provider.requiresKey !== false,
  };
}

/** 一次投影整份目录（顺序保持主进程给的顺序：内置在前） */
export function toProviderDirectory(providers: readonly ProviderConfig[]): ProviderDirectoryEntry[] {
  return providers.map(toDirectoryEntry);
}
