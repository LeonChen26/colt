// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「测试连接」的主进程入口：补齐密钥与地址后交给 `probeProvider`。
 *
 * 密钥优先用**请求里刚粘贴的那份**：用户的常见顺序是「粘贴 → 测 → 保存」，
 * 只用已保存的密钥会让第一次测试显示「未配置」，像产品在撒谎。
 * 这份明文只用于本次请求头，不落库、不回传。
 */
import type { ProviderTestResult } from "@shared/protocol";
import { probeProvider } from "@shared/provider-probe";
import { getProvider } from "./providers";
import { getSecret } from "./secrets";

export async function testProvider(input: {
  id: string;
  apiKey?: string;
}): Promise<ProviderTestResult> {
  const provider = getProvider(input.id);
  if (!provider) throw new Error("模型服务不存在");

  const apiKey = input.apiKey?.trim() || getSecret(provider.id);
  if (provider.requiresKey && !apiKey) {
    return { ok: false, error: "尚未配置 API Key，请先填写并保存", latencyMs: 0 };
  }

  return probeProvider({ baseUrl: provider.baseUrl, apiKey });
}
