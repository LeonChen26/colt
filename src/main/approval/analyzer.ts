/**
 * 基于大模型的审批分析器（自动审批模式专用）。
 *
 * 只读白名单放行了「确定无副作用」的调用，剩下的 moderate 操作在自动审批
 * 模式下本想直接放行；本模块用一次独立的模型调用替用户做这个判断：
 * 让模型结合项目上下文与操作本身，判断「这个操作对项目是否是合理、低风险的」。
 *
 * 设计原则（安全第一）：
 *   - **fail-closed**：任何异常、超时、解析失败一律返回「不放行」，退回人工确认，
 *     绝不因为分析器本身出故障就把操作放过去。
 *   - **独立超时**：分析器超时不会拖住 worker 的审批等待（两者时限独立）。
 *   - **不落盘、不记忆**：分析结果只服务当前这一次调用。
 *
 * 装配 provider 的方式与 worker 共用同一实现（见 shared/provider-factory.ts）：
 * 审批要面向用户配置的任意 endpoint（内置 DeepSeek + 自定义 openai-compatible），
 * 各家协议差异由 pi-ai 的 API 层吸收，自绘 HTTP 会把多 provider 适配重写一遍。
 * 主进程只需要一次性文本回复，故走 pi-ai 的 complete() 而非流式接口。
 *
 * 本模块无状态：每次分析现装现用。装配本身只是对象构造，真正的 SDK client
 * 在每次请求内部创建，缓存装配结果省不到热路径上的开销（故不做缓存）。
 */
import { createModels, contentText } from "@earendil-works/pi-ai";
import { buildProvider, type ProviderBuildConfig } from "@shared/provider-factory";

/** 分析器的输入：一次待判定的工具调用 */
export interface AnalyzeInput {
  toolName: string;
  /** 完整入参对象 */
  args: Record<string, unknown>;
  /** 项目根目录，供模型判断写入是否在项目内 */
  projectRoot: string;
  /** policy 给出的启发式理由，作为模型的先验提示 */
  policyReason: string;
  /** 当前会话选定的 provider 配置 */
  provider: ProviderBuildConfig;
  /** 当前会话选定的模型 id */
  modelId: string;
  /** provider 的 API key，由调用方从 secrets 取出后传入（本模块不碰密钥存储） */
  apiKey: string | undefined;
}

/** 分析结论 */
export interface AnalyzeResult {
  /** 是否自动放行 */
  allow: boolean;
  /** 给用户/日志看的一句话理由 */
  reason: string;
  /** 分析是否真正完成（false 表示走了兜底拒绝，界面可标注「已自动拦截」） */
  analyzed: boolean;
}

/** 分析器整体超时：超过即视为「未放行」，不阻塞审批链路 */
export const ANALYZE_TIMEOUT_MS = 15_000;

/** 单次分析的最大输出 token：只要一段 JSON，不需要长文本 */
const ANALYZE_MAX_TOKENS = 256;

/**
 * 交给模型的判定指令。
 * 要求严格输出 JSON，且明确「不确定就拒绝」，把保守取向写进提示词。
 */
const SYSTEM_PROMPT = [
  "你是代码工作台的命令安全审查器。用户开启了三档审批中的「自动审批模式」：",
  "只读命令已自动放行，你只需审查下面这一类有副作用的操作是否足够安全、可以自动放行。",
  "",
  "放行（allow=true）的判断标准：",
  "  - 操作服务于常规编码任务（读写项目内文件、安装依赖、跑测试、格式化、git 常规操作等）；",
  "  - 影响范围局限于当前项目，且可能造成的损害容易恢复。",
  "拒绝（allow=false）的判断标准：",
  "  - 触碰项目目录之外、系统目录、凭据/密钥文件；",
  "  - 不可逆的破坏（删除、覆盖、强制推送、格式化、提权、发布等）；",
  "  - 与项目上下文明显无关、来源可疑或有数据外泄风险；",
  "  - 你无法确定其后果时，一律拒绝。",
  "",
  "只返回一个 JSON 对象，不要多余文字：",
  '{"allow": true 或 false, "reason": "一句话中文理由"}',
].join("\n");

/** 从模型回复里提取 JSON 结论；容忍 ```json 包裹与前后噪声 */
export function parseVerdict(text: string): { allow: boolean; reason: string } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.allow !== "boolean") return null;
  const reason = typeof record.reason === "string" && record.reason.trim().length > 0
    ? record.reason.trim()
    : record.allow
      ? "模型判断为安全操作"
      : "模型判断为高风险操作";
  return { allow: record.allow, reason };
}

/** 组装分析用的 prompt */
function buildUserPrompt(input: AnalyzeInput): string {
  const argsPreview = safeStringify(input.args);
  return [
    `项目根目录：${input.projectRoot}`,
    `工具：${input.toolName}`,
    `参数：${argsPreview}`,
    `启发式初判：${input.policyReason}`,
    "",
    "请判断这次调用是否可以自动放行。",
  ].join("\n");
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return "(无法序列化)";
  }
}

/**
 * 用一次模型调用判断是否放行。
 *
 * 任何环节出错（装配失败、请求超时、回复无法解析）都返回 allow=false，
 * 让上层退回人工确认——分析器绝不能成为放行的单点故障。
 */
export async function analyzeToolCall(input: AnalyzeInput): Promise<AnalyzeResult> {
  let models: ReturnType<typeof createModels>;
  let model: ReturnType<ReturnType<typeof createModels>["getModel"]>;
  try {
    models = createModels();
    models.setProvider(buildProvider(input.provider));
    model = models.getModel(input.provider.id, input.modelId);
  } catch (error) {
    return {
      allow: false,
      analyzed: false,
      reason: `审批分析器装配失败，转人工确认：${errorText(error)}`,
    };
  }
  if (!model) {
    return { allow: false, analyzed: false, reason: "审批分析器无法解析模型，转人工确认" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
  timer.unref?.();

  try {
    const message = await models.complete(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(input), timestamp: Date.now() }],
      },
      {
        apiKey: input.apiKey,
        signal: controller.signal,
        maxTokens: ANALYZE_MAX_TOKENS,
        temperature: 0,
      },
    );

    const verdict = parseVerdict(contentText(message.content));
    if (!verdict) {
      return { allow: false, analyzed: false, reason: "审批分析器未能给出有效结论，转人工确认" };
    }
    return { allow: verdict.allow, analyzed: true, reason: verdict.reason };
  } catch (error) {
    return {
      allow: false,
      analyzed: false,
      reason: `审批分析器调用失败，转人工确认：${errorText(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "分析超时" : error.message;
  }
  return String(error);
}
