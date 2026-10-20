// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「测试连接」的探测：请求服务商的 `/models`。
 *
 * 为什么不用 chat/completions：那会真的花模型额度，而用户想确认的只是
 * 「地址对不对、密钥被不被接受」——OpenAI 兼容服务的 `/models` 恰好能回答这两件事，
 * 且失败码分得很清（401 密钥、404 路径、ECONNREFUSED 没启动）。
 *
 * 本模块刻意不碰 Electron / 数据库：入参只有 baseUrl 与密钥，便于单测。
 * 密钥只在这一次请求头里出现，不进日志、不进任何返回字段。
 */
import type { ProviderTestResult } from "./protocol";

/** 单次探测的上限：本地服务通常 1s 内回，远端最慢也不该拖到十几秒 */
const DEFAULT_TIMEOUT_MS = 8000;
/** 错误体只读这么多：有的网关会把整页 HTML 回过来 */
const MAX_ERROR_BODY = 4096;

/** 拼探测地址：`https://api.example.com/v1` → `…/v1/models` */
export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/models`;
}

export async function probeProvider(input: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<ProviderTestResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  let response: Response;
  try {
    const headers: Record<string, string> = {};
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
    response = await fetch(modelsUrl(input.baseUrl), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      error: describeFailure(error, timeoutMs),
      latencyMs: Date.now() - startedAt,
    };
  }

  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    return { ok: false, error: await describeStatus(response), latencyMs };
  }
  return { ok: true, modelCount: await countModels(response), latencyMs };
}

/**
 * Node 的 fetch 对网络层失败只会说 `fetch failed`，真正的原因（ECONNREFUSED / ENOTFOUND …）
 * 在 `cause` 里——渲染层的错误映射正是按这些码来认的，不能把它丢掉。
 */
function describeFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `请求超时（${Math.round(timeoutMs / 1000)} 秒内没有响应）`;
  }
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const message = error instanceof Error ? error.message : String(error);
  if (cause === "") return message;
  return message === "fetch failed" ? cause : `${message}（${cause}）`;
}

/** 状态行 + 服务端给的 detail（OpenAI 兼容服务一般放在 `error.message`） */
async function describeStatus(response: Response): Promise<string> {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  try {
    const text = (await response.text()).slice(0, MAX_ERROR_BODY);
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const detail = parsed.error?.message ?? parsed.message;
    if (typeof detail === "string" && detail.trim() !== "") {
      return `${status}：${detail.trim()}`;
    }
  } catch {
    // 非 JSON 的错误体：状态行已经足够定位
  }
  return status;
}

/** 成功时数一下模型数；服务不实现 `/models`（或返回非 JSON）时如实给 null */
async function countModels(response: Response): Promise<number | null> {
  try {
    const parsed = (await response.json()) as { data?: unknown };
    return Array.isArray(parsed.data) ? parsed.data.length : null;
  } catch {
    return null;
  }
}
