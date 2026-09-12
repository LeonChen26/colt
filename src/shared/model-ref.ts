/**
 * 会话模型标识（"providerId/modelId"）的拆分。
 *
 * 该格式在协议里是约定字段（sessions.model_ref、ConversationView.model、模型下拉值），
 * 主进程、worker、渲染层都要解析它，故收敛到此处，避免各处各写一遍 indexOf("/")。
 *
 * 切分规则：只在**首个**斜杠处切分，模型名本身含斜杠（如 org/model-x）不会被截断；
 * 无斜杠时整体视作 modelId，provider 回落到调用方给的 fallback。
 */
export function splitModelRef(
  modelRef: string,
  fallbackProvider = "",
): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  if (slash === -1) return { provider: fallbackProvider, model: modelRef };
  return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}
