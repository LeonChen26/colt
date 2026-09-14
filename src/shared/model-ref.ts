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

/** 在 provider 列表里校验一个 "providerId/modelId" 是否仍然有效（服务还在、模型还在） */
function findModelRef(
  modelRef: string,
  providers: ProviderConfig[],
): { providerId: string; modelId: string } | undefined {
  const { provider: providerId, model: modelId } = splitModelRef(modelRef, BUILTIN_PROVIDER_ID);
  const hit = providers.find((item) => item.id === providerId);
  if (hit && hit.models.some((item) => item.id === modelId)) return { providerId, modelId };
  return undefined;
}

/**
 * 解析会话实际使用的 provider/model。
 * 优先级：**会话的显式选定**（仍有效时）> 首个**可用**的服务（见 isUsableProvider）
 * > 内置默认。
 *
 * 「没选过」与「选定已失效」都要走可用回落，因此不能拿内置默认值去 list 里做命中判断：
 * 内置 DeepSeek 永远在列表里、默认模型也永远在它的模型表里，那种写法会把「没选过」
 * 误判成「选中了 DeepSeek」，回落链整条走不到（写这一版时真的这么错过，单测当场抓出）。
 *
 * 回落到「首个可用服务」而不是写死内置 DeepSeek 是必须的：用户完全可能一个 DeepSeek 密钥
 * 都不配、只用自定义服务（本地/自建 endpoint）。写死 DeepSeek 会让默认解析落在一个没密钥的
 * provider 上——界面挂着「尚未配置 DeepSeek 的 API Key」，一发消息更会被启动检查直接拒绝，
 * 于是**能用的服务一个也用不上**。DeepSeek 可用时它仍在列表最前，行为与此前一致。
 *
 * 主进程据此决定 fork worker 时带哪个 provider；渲染层据此判断
 * 「这次打开是否注定失败」（缺密钥时不必再调 session.open）——两处必须同源，
 * 各写一遍迟早漂移。
 */
export function resolveSessionModel(
  modelRef: string | null | undefined,
  providers: ProviderConfig[],
): { providerId: string; modelId: string } {
  if (modelRef) {
    const hit = findModelRef(modelRef, providers);
    if (hit) return hit;
  }
  const usable = firstUsableProvider(providers);
  if (usable) return { providerId: usable.id, modelId: usable.models[0]!.id };
  const fallback = splitModelRef(BUILTIN_DEFAULT_MODEL_REF, BUILTIN_PROVIDER_ID);
  return { providerId: fallback.provider, modelId: fallback.model };
}

/** 界面「当前模型」的显示结果 */
export interface DisplayModel {
  /** 该显示的模型引用（与「实际会用哪个模型」同源） */
  modelRef: string;
  /**
   * 落库的选定**已失效**（服务被删 / 模型下线）时回填原来的引用。
   *
   * 界面据此提示「原选定已不可用，已改用 X」——没有这条，抬头会继续显示一个
   * 永远不会被使用的模型，用户以为在用 A、实际跑的是 B。
   */
  driftedFrom?: string;
}

/**
 * 界面上「当前模型」该显示哪个引用。
 *
 * **会话选定（落库的 model_ref）优先**：它是用户的意图，而且在一个没有 worker 的会话里
 * （从未打开、或已被空闲回收）它是唯一可知的值——`session.view` 只从 worker 池取数据，
 * 没有 worker 就是 null。只认 worker 汇报的模型，会让「已经选好并落库」在界面上毫无反映，
 * 用户看到的就是「选不了模型」。
 *
 * 但「优先」不等于「无条件」：选定**已失效**时必须显示实际会用的那个（见 driftedFrom），
 * 否则界面就是在撒谎。缺密钥不算失效——那是「选定仍在、还差一步」，交给黄色提示。
 *
 * 从未选过时才回落到 worker 汇报的实际模型（它可能已经按规则回退过）。
 */
export function displayModelRef(
  sessionModelRef: string | null | undefined,
  providers: ProviderConfig[],
  workerModel: string | null | undefined,
): DisplayModel {
  if (sessionModelRef) {
    if (findModelRef(sessionModelRef, providers)) return { modelRef: sessionModelRef };
    const resolved = resolveSessionModel(sessionModelRef, providers);
    return {
      modelRef: `${resolved.providerId}/${resolved.modelId}`,
      driftedFrom: sessionModelRef,
    };
  }
  return { modelRef: workerModel ?? "" };
}

/**
 * 某个 provider 是否**可用**（能真的跑起来）。
 *
 * 判据是「有模型」+「不需要密钥 **或** 配了密钥」。
 * 不能只看 `hasKey`：本地 / 自建的 OpenAI 兼容服务（ollama、vLLM、llama.cpp …）
 * 本来就没有密钥，按「必须有密钥」判定会把它们永远排除在外——用户明明跑着模型，
 * 默认解析却落到内置 DeepSeek 上，一开口就报「尚未配置 DeepSeek 的 API Key」。
 * 「要不要密钥」是服务的属性，只能由用户显式声明（ProviderConfig.requiresKey）。
 *
 * 反过来说，配了密钥但没填模型的服务也开不了会话，不该算可用。
 */
export function isUsableProvider(provider: ProviderConfig): boolean {
  if (provider.models.length === 0) return false;
  // 只有显式 false 才免密钥；字段缺失一律按「需要密钥」处理，宁严勿松
  return provider.requiresKey === false || provider.hasKey === true;
}

/**
 * 是否**存在任一**可用的模型服务（见 isUsableProvider）。
 *
 * 界面提示「尚未配置 API Key」的判据必须用它：只要有一个服务能用，对话就能开始。
 * 按内置项判定会一直挂着一条黄色警告，属于假报错。
 */
export function hasUsableProvider(providers: ProviderConfig[]): boolean {
  return providers.some(isUsableProvider);
}

/**
 * 取第一个可用 provider（用于提示文案）：没有则返回 undefined。
 * 内置项在列表最前，因此全都能用时提示仍指向 DeepSeek，与此前观感一致。
 */
export function firstUsableProvider(providers: ProviderConfig[]): ProviderConfig | undefined {
  return providers.find(isUsableProvider);
}
