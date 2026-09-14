/**
 * Provider 配置：内置 DeepSeek + 用户自定义的 OpenAI 兼容 endpoint
 * 密钥不存这里，统一走 secrets.ts（safeStorage 加密）
 */
import type { ModelOption, ProviderConfig } from "@shared/protocol";
import { BUILTIN_PROVIDER_ID } from "@shared/model-ref";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { getDatabase } from "./db";
import { hasSecret } from "./secrets";

/**
 * 内置 DeepSeek 的模型表直接取自 pi-ai 自带的静态 catalog（DEEPSEEK_MODELS）。
 * 不手写常量：避免 pi-ai 升级模型表后此处 contextWindow 漂移。
 * 仅引静态数据模块，不引 deepseekProvider()，以免带入 auth/api 等运行时依赖。
 */
function builtinModels(): ModelOption[] {
  return Object.values(DEEPSEEK_MODELS).map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
  }));
}

/** 内置 DeepSeek：模型表由 pi-ai 自带，此处只列可选项供 UI 展示 */
export const BUILTIN_DEEPSEEK: ProviderConfig = {
  id: BUILTIN_PROVIDER_ID,
  name: "DeepSeek",
  kind: "deepseek",
  baseUrl: "https://api.deepseek.com",
  builtin: true,
  models: builtinModels(),
};

interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  models_json: string;
  created_at: number;
}

function toConfig(row: ProviderRow): ProviderConfig {
  let models: ModelOption[] = [];
  try {
    models = JSON.parse(row.models_json) as ModelOption[];
  } catch {
    models = [];
  }
  return {
    id: row.id,
    name: row.name,
    kind: "openai-compatible",
    baseUrl: row.base_url,
    builtin: false,
    models,
  };
}

/** 列出全部 provider（内置在前），并标注密钥是否已配置 */
export function listProviders(): ProviderConfig[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM providers ORDER BY created_at ASC")
    .all() as unknown as ProviderRow[];

  return [BUILTIN_DEEPSEEK, ...rows.map(toConfig)].map((provider) => ({
    ...provider,
    hasKey: hasSecret(provider.id),
  }));
}

/** 按 id 取配置（含内置） */
export function getProvider(id: string): ProviderConfig | undefined {
  return listProviders().find((item) => item.id === id);
}

/** 新增或更新自定义 provider；内置项不可改 */
export function saveProvider(input: {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelOption[];
}): void {
  if (input.id === BUILTIN_DEEPSEEK.id) throw new Error("内置 provider 不可修改");
  const id = input.id.trim();
  if (!id) throw new Error("provider id 不能为空");

  getDatabase()
    .prepare(
      `INSERT INTO providers (id, name, kind, base_url, models_json, created_at)
       VALUES (?, ?, 'openai-compatible', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         base_url = excluded.base_url,
         models_json = excluded.models_json`,
    )
    .run(id, input.name.trim() || id, input.baseUrl.trim(), JSON.stringify(input.models), Date.now());
}

/** 删除自定义 provider */
export function removeProvider(id: string): void {
  if (id === BUILTIN_DEEPSEEK.id) throw new Error("内置 provider 不可删除");
  getDatabase().prepare("DELETE FROM providers WHERE id = ?").run(id);
}
