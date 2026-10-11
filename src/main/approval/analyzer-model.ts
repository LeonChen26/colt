// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 审批分析器用哪个模型（工作包 C）。
 *
 * 现状：分析器固定跟会话同一个 provider/model。它每次自动审批都要真实计费地发一次
 * 请求，而这件事对模型能力的要求远低于会话本身——「便宜的小模型做审批复核」是能省钱的，
 * 也让「会话用贵模型、复核用便宜模型」这种组合成为可能。
 *
 * 三条规矩：
 *   ① **缺省即现状**：没配置过（null / 空串）= 沿用会话模型，单 provider 用户全程无感；
 *   ② **解析失败如实回落**：配置指向的服务被删了 / 模型下线了，回落到会话模型，
 *      并把 `driftedFrom` 带出去让调用方**说一声**——静默回落会让用户以为复核换了模型；
 *   ③ 密钥由调用方从 secrets 取（本模块不碰密钥存储，与 analyzer.ts 同一分工）。
 */
import type { ProviderConfig } from "@shared/protocol";
import type { ProviderBuildConfig } from "@shared/provider-factory";
import { findModelRef } from "@shared/model-ref";

/** 一次分析要用的目标：provider 配置 + 模型 id + 密钥（可能为空 = 无密钥本地服务） */
export interface AnalyzerTarget {
  provider: ProviderBuildConfig;
  modelId: string;
  apiKey: string | undefined;
  /**
   * 有值即「配置里的模型引用已失效，本次回落到会话模型」，值是失效的那个引用。
   * 调用方据此提示用户（本模块只负责把事实带出来，不决定怎么呈现）。
   */
  driftedFrom?: string;
}

/** `ProviderConfig` → 装配侧的最小配置（逐字段挑，见 shared/provider-directory.ts 的同一纪律） */
export function toAnalyzerProviderConfig(provider: ProviderConfig): ProviderBuildConfig {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    models: provider.models,
  };
}

export interface ResolveAnalyzerInput {
  /** 会话当前选定的目标（回落值，也是缺省值） */
  session: { provider: ProviderConfig; modelId: string; apiKey: string | undefined };
  /** 设置里的模型引用；null / undefined / 空串 = 未配置 */
  configuredRef: string | null | undefined;
  /**
   * 当前 provider 目录（校验引用是否仍然有效）。
   *
   * 传**函数**而不是数组：本函数在**每次自动审批**都被调用，而绝大多数用户从没配过
   * 专用模型——那种情况下压根不该为了一个用不上的校验去查一遍 provider 目录。
   * 惰性求值让「没配过」这条路径零额外开销（调用方仍要保证求值结果在一次调用内一致）。
   */
  providers: () => ProviderConfig[];
  /** 按 providerId 取密钥（主进程从 secrets 读，不经 worker） */
  apiKeyOf: (providerId: string) => string | undefined;
}

export function resolveAnalyzerTarget(input: ResolveAnalyzerInput): AnalyzerTarget {
  const sessionTarget: AnalyzerTarget = {
    provider: toAnalyzerProviderConfig(input.session.provider),
    modelId: input.session.modelId,
    apiKey: input.session.apiKey,
  };
  const ref = (input.configuredRef ?? "").trim();
  if (ref === "") return sessionTarget;

  const providers = input.providers();
  const hit = findModelRef(ref, providers);
  if (hit === undefined) return { ...sessionTarget, driftedFrom: ref };

  const provider = providers.find((item) => item.id === hit.providerId);
  // findModelRef 命中即表示服务在列表里；这一道只是为了类型收窄，不改变语义
  if (provider === undefined) return { ...sessionTarget, driftedFrom: ref };
  return {
    provider: toAnalyzerProviderConfig(provider),
    modelId: hit.modelId,
    apiKey: input.apiKeyOf(hit.providerId),
  };
}
