// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * ModelOption 的清洗与归一。
 *
 * 模型声明来自用户手填（设置页表单），落在 models_json 一个 JSON blob 里——
 * 字段缺失、类型漂移、手改坏数据都可能发生。消费端（provider-factory 装配、
 * 界面展示）不应该各自猜默认值，统一在这里收敛：**非法一律回落默认或剔除，
 * 宁严勿松**。
 *
 * 纯函数、零依赖：主进程保存前调用（providers.save），渲染层提交前也可用
 * 它预检，出错信息更友好。不放在 main/providers.ts 是因为那条依赖链会拖进
 * electron（secrets → safeStorage），node 单测无法导入。
 */
import type { ModelOption } from "./protocol";

/** 上下文窗口的兜底默认——与设置页表单的缺省一致 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 未声明 maxTokens 时的历史钳制：min(contextWindow, 8192) */
export const LEGACY_MAX_TOKENS = 8192;

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** 非负有限数才算有效价格；0 是合法值（免费 endpoint），undefined 表示「未声明」 */
function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizePrice(
  price: ModelOption["price"],
): NonNullable<ModelOption["price"]> | undefined {
  if (typeof price !== "object" || price === null) return undefined;
  const input = nonNegativeNumber(price.input);
  const output = nonNegativeNumber(price.output);
  const cacheRead = nonNegativeNumber(price.cacheRead);
  const cacheWrite = nonNegativeNumber(price.cacheWrite);
  const normalized: NonNullable<ModelOption["price"]> = {};
  if (input !== undefined) normalized.input = input;
  if (output !== undefined) normalized.output = output;
  if (cacheRead !== undefined) normalized.cacheRead = cacheRead;
  if (cacheWrite !== undefined) normalized.cacheWrite = cacheWrite;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * 清洗单个模型声明。id 为空（剔除整行的唯一条件）时返回 null；
 * 其余字段非法一律回落默认或剔除该可选字段。
 */
export function normalizeModelOption(raw: ModelOption): ModelOption | null {
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (!id) return null;

  const normalized: ModelOption = {
    id,
    // 显示名留空时以 id 兜底，界面不该出现空标签
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    contextWindow: positiveInt(raw.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
  };
  if (raw.imageInput === true) normalized.imageInput = true;
  if (raw.reasoning === true) normalized.reasoning = true;
  const maxTokens = positiveInt(raw.maxTokens);
  if (maxTokens !== undefined) normalized.maxTokens = maxTokens;
  const price = normalizePrice(raw.price);
  if (price) normalized.price = price;
  return normalized;
}

/** 清洗一组模型声明，剔除 id 为空的行；调用方须自行处理「清洗后为空」的情形 */
export function normalizeModelOptions(models: ModelOption[]): ModelOption[] {
  if (!Array.isArray(models)) return [];
  const normalized: ModelOption[] = [];
  for (const raw of models) {
    const item = normalizeModelOption(raw);
    if (item) normalized.push(item);
  }
  return normalized;
}
