// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 遥测投影：把内核的 usage / tool 事件转成上报给主进程的消息。
 * 这层逻辑字段语义易错（时间戳取开始还是结束、哪些消耗该记），
 * 故与 worker 的事件订阅解耦，便于单测覆盖。
 */
import type { WorkerMessage } from "@shared/worker-protocol";
import { splitModelRef } from "@shared/model-ref";

type UsageUpload = Extract<WorkerMessage, { type: "usage" }>;
type ToolCallUpload = Extract<WorkerMessage, { type: "toolCall" }>;

/**
 * 主 lane 名：会话的对话主线。entry 用它开 lane、`transform_context` 用它分流，
 * 而这里只用在一个判据上——上下文占用条（`contextUsedFromUsage`）：
 * 子 lane 与主对话共用同一份模型上下文预算没有意义，占用条该答的是「主对话还剩多少」。
 */
export const MAIN_LANE = "main";

/**
 * 从一条 usage 行算出「本轮上下文占用」（prompt tokens）。
 * pi-ai 的 Usage.input 是扣除 cache 后的净输入，
 * prompt tokens = input + cacheRead + cacheWrite，这才是实际喂给模型的上下文量。
 * 返回 null 表示该行不计入占用（非主 lane 或 adjustment 补记行）。
 *
 * ⚠️ **这条过滤只属于「占用」，不属于「费用」**：子 lane（记忆整理、子代理）的消耗
 * 同样是用户付的钱，必须计入会话统计（见 `buildUsageUpload`）。以前两者共用一条
 * `lane !== MAIN_LANE` 过滤，于是「整理/子代理花了钱」在用量明细里**静默消失**。
 */
export function contextUsedFromUsage(event: KernelUsageEvent): number | null {
  if (event.lane !== MAIN_LANE) return null;
  if (event.row.adjustment) return null;
  const usage = event.row.usage;
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** 内核 usage 事件中本模块关心的部分 */
export interface KernelUsageEvent {
  lane: string;
  row: {
    id: string;
    adjustment: boolean;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: { total: number };
    };
  };
}

/** 内核 tool_end 事件中本模块关心的部分 */
export interface KernelToolEndEvent {
  lane: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  isError: boolean;
}

/** tool_start 时缓存的信息，tool_end 时取回配对 */
export interface ToolMetaEntry {
  startedAt: number;
  argsJson: string | null;
}

/**
 * 构造一条用量上报；返回 null 表示这条不该记账。
 * 只跳过 adjustment 行（手工补记与旧版历史导入，它们不是新的模型调用，计入会重复累计）。
 *
 * ⚠️ **不过滤 lane**：子 lane（记忆整理 `memory-tidy`、子代理 `sub:*`）的调用同样是
 * 真实发生的计费请求。「只采主 lane」会让用户**付了钱却在用量明细里看不到**——
 * 那是静默（`docs/ERRORS.md`）。归属由调用方（子代理注册表）另外累计，
 * 不在这里往线上加一个没人读的字段。
 */
export function buildUsageUpload(
  event: KernelUsageEvent,
  modelRef: string,
  fallbackProvider: string,
  now: number,
): UsageUpload | null {
  if (event.row.adjustment) return null;

  const { provider, model } = splitModelRef(modelRef, fallbackProvider);
  const usage = event.row.usage;
  return {
    type: "usage",
    kernelUsageId: event.row.id,
    provider,
    model,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    costUsd: usage.cost.total,
    timestamp: now,
  };
}

/**
 * 一条内核 usage 事件的完整处理：
 * 先更新「最近一轮上下文占用」（非主 lane / adjustment 行不计），再构造用量上报。
 *
 * 占用写回与 view 推送是 worker 的副作用，由调用方经 `onContextUsed` 注入，
 * 这里保持纯投影逻辑，便于单测。
 */
export function handleUsageEvent(
  event: KernelUsageEvent,
  deps: {
    modelRef: string;
    fallbackProvider: string;
    now: number;
    /** 会话已就绪时注入；占用值只在该回调里消费一次 */
    onContextUsed?: (used: number) => void;
  },
): UsageUpload | null {
  const used = contextUsedFromUsage(event);
  if (used !== null) deps.onContextUsed?.(used);
  return buildUsageUpload(event, deps.modelRef, deps.fallbackProvider, deps.now);
}

/** 把工具入参序列化；含循环引用等无法序列化的值时回退为 null */
export function serializeArgs(args: unknown): string | null {
  try {
    return JSON.stringify(args ?? null);
  } catch {
    return null;
  }
}

/**
 * 配对 tool_start / tool_end。
 * args 只在 start 上、耗时需要两端时间，故必须缓存 start。
 */
export class ToolCallTracker {
  private readonly meta = new Map<string, ToolMetaEntry>();
  private readonly limit: number;

  /**
   * @param limit 兜底上限：未配对的 start 长期驻留时淘汰最旧条目，避免无界增长。
   * 注：此处不能用 TS 参数属性写法，测试走 Node 的 strip-only 类型擦除，不支持需要代码生成的语法。
   */
  constructor(limit = 256) {
    this.limit = limit;
  }

  get size(): number {
    return this.meta.size;
  }

  start(toolCallId: string, args: unknown, now: number): void {
    if (this.meta.size >= this.limit) {
      const oldest = this.meta.keys().next().value;
      if (oldest !== undefined) this.meta.delete(oldest);
    }
    this.meta.set(toolCallId, { startedAt: now, argsJson: serializeArgs(args) });
  }

  /**
   * 构造一条工具调用上报。
   *
   * ⚠️ **不过滤 lane**：子代理的工具调用与主对话的一样，是真实发生过的动作（也照样过闸门），
   * 统计页里应该看得到；只按主 lane 过滤会让整段子代理的活动凭空消失。
   * 无论是否配对到 start，都会清理该条目（避免未配对的 start 长期驻留）。
   */
  end(event: KernelToolEndEvent, now: number): ToolCallUpload {
    const meta = this.meta.get(event.toolCallId);
    this.meta.delete(event.toolCallId);

    return {
      type: "toolCall",
      toolCallId: event.toolCallId,
      runId: event.runId,
      toolName: event.toolName,
      inputJson: meta?.argsJson ?? null,
      isError: event.isError,
      durationMs: meta === undefined ? null : now - meta.startedAt,
      // 记录调用「发生」的时刻，即开始时间。
      // 用结束时刻会让并行的快工具（先结束）排在慢工具之前，与模型实际调用顺序相反。
      timestamp: meta?.startedAt ?? now,
    };
  }

  clear(): void {
    this.meta.clear();
  }
}
