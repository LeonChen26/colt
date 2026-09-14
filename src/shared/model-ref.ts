/**
 * 会话模型标识（"providerId/modelId"）的拆分。
 *
 * 该格式在协议里是约定字段（sessions.model_ref、ConversationView.model、模型下拉值），
 * 主进程、worker、渲染层都要解析它，故收敛到此处，避免各处各写一遍 indexOf("/")。
 *
 * 切分规则：只在**首个**斜杠处切分，模型名本身含斜杠（如 org/model-x）不会被截断；
 * 无斜杠时整体视作 modelId，provider 回落到调用方给的 fallback。
 */
import type { ProviderConfig } from "./protocol";

export function splitModelRef(
  modelRef: string,
  fallbackProvider = "",
): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  if (slash === -1) return { provider: fallbackProvider, model: modelRef };
  return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

/** 内置 provider 的 id（DeepSeek），也是无会话选定模型时的兜底 */
export const BUILTIN_PROVIDER_ID = "deepseek";

/** 内置默认模型引用：会话从未选过模型时用它 */
export const BUILTIN_DEFAULT_MODEL_REF = `${BUILTIN_PROVIDER_ID}/deepseek-v4-flash`;

/**
 * 解析会话实际使用的 provider/model。
 * 优先级：会话选定 > 内置默认；选定项已失效（provider 被删、模型下线）同样退回内置默认，
 * 否则会话会因 provider 找不到而永久打不开。
 *
 * 主进程据此决定 fork worker 时带哪个 provider；渲染层据此判断
 * 「这次打开是否注定失败」（缺密钥时不必再调 session.open）——两处必须同源，
 * 各写一遍迟早漂移。
 */
export function resolveSessionModel(
  modelRef: string | null | undefined,
  providers: ProviderConfig[],
): { providerId: string; modelId: string } {
  const { provider: providerId, model: modelId } = splitModelRef(
    modelRef ?? BUILTIN_DEFAULT_MODEL_REF,
    BUILTIN_PROVIDER_ID,
  );
  const hit = providers.find((item) => item.id === providerId);
  if (hit && hit.models.some((item) => item.id === modelId)) return { providerId, modelId };
  const fallback = splitModelRef(BUILTIN_DEFAULT_MODEL_REF, BUILTIN_PROVIDER_ID);
  return { providerId: fallback.provider, modelId: fallback.model };
}

/**
 * 是否**存在任一**「可用」的模型服务：已配置密钥、且至少有一个可选用模型。
 *
 * 界面提示「尚未配置 API Key」的判据必须用它，而不是只看内置 DeepSeek：
 * 用户只配了 OpenAI 兼容服务、内置 DeepSeek 空着时照样能正常对话，
 * 按内置项判定会一直挂着一条黄色警告，属于假报错。
 * 反过来，配了密钥但没填模型的服务也开不了会话，不该算可用。
 */
export function hasUsableProvider(providers: ProviderConfig[]): boolean {
  return providers.some((item) => item.hasKey === true && item.models.length > 0);
}

/**
 * 取第一个可用 provider 的 id（用于提示文案）：没有则返回 undefined。
 * 内置项在列表最前，因此全都能用时提示仍指向 DeepSeek，与此前观感一致。
 */
export function firstUsableProvider(providers: ProviderConfig[]): ProviderConfig | undefined {
  return providers.find((item) => item.hasKey === true && item.models.length > 0);
}
