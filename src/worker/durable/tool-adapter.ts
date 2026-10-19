// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 旧工具（pi-agent-core 的 `AgentHarnessTool`）→ durable 工具（`ToolRegistration`）的适配器。
 *
 * 为什么走适配器而不是把工具全部重写一遍：Colt 的工具面（浏览器 / 桌面 / 记忆 / 待办 /
 * 检索 / ask_user / MCP）**行为已经稳定且有测试**，重写等于把每一条安全边界（read 的项目
 * 根校验、ask_user 不豁免审批、宿主能力只走 RPC）再实现一遍。切换内核期间最该保持的是
 * **行为不变**，所以先复用实现、只换执行容器。
 *
 * 两边签名差异只有三处，全部在这里归一：
 *  1. 旧工具 `execute(toolCallId, params, onUpdate, toolContext, invocation, context)`；
 *     durable 是 `execute(args, api, context)`；
 *  2. 旧工具用 `onUpdate(partialResult)` 推**全量快照**，durable 用 `api.output(chunk)` 推
 *     **增量**——这里按「新快照以旧快照为前缀」算增量，非前缀变化整段重发；
 *  3. 旧工具的 `toolContext.env` 由调用方给（durable 的 `HarnessOptions.env` 语义不同），
 *     适配器把它闭包进来，工具看到的执行环境与旧内核完全一致。
 *
 * 重放策略：旧工具的 `replay: "safe"` 映射到 durable 的同名值，其余一律 `unsafe`
 * （默认值；崩溃后不重跑有副作用的调用）。`"never"` 与 `unsafe` 同义。
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/** 旧工具的结果形状（只取适配器要用的字段） */
export interface LegacyToolResult {
  content: readonly unknown[];
  details?: unknown;
  isError?: boolean;
  usage?: unknown;
}

/**
 * 旧工具的结构化视图。
 *
 * 不直接 import `AgentHarnessTool`：它会拖进 pi-agent-core 的类型（以及它的 typebox 版本），
 * 而本文件只需要「名字 / 描述 / 参数 schema / execute」这四件事。结构类型还让单测能
 * 用一个假工具直接验适配器，不必起内核。
 */
export interface LegacyTool {
  name: string;
  description: string;
  parameters: unknown;
  label?: string;
  replay?: "never" | "safe";
  executionMode?: "parallel" | "sequential";
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    // 旧工具的参数由各自的 typebox schema 约束；适配器只做透传，不在这里重做校验。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
    onUpdate?: (partial: LegacyToolResult) => void,
    toolContext?: { env: unknown },
    invocation?: unknown,
    context?: Context,
  ) => Promise<LegacyToolResult>;
}

/** 从工具结果的内容块里抽文本（与 `project.ts` 的 `extractText` 同口径，但容错非数组） */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      );
    })
    .map((block) => block.text)
    .join("");
}

/**
 * 把一批旧工具转成 durable 工具。
 *
 * `env` 是旧 `NodeExecutionEnv`：durable 侧没有「按会话注入工具上下文」的口子，
 * 而旧工具的自由函数签名里第五个参数就是它——闭包住即可，工具看到的 cwd / shell
 * 与旧内核逐字一致。
 */
export function adaptLegacyTools(
  tools: readonly unknown[],
  env: unknown,
  /**
   * durable 的重放策略：标 `safe` 的工具在崩溃后会被**重新执行**，而不是留下一条
   * interrupted 结果。只该给幂等的只读工具（read / grep / glob / 检索 / 浏览器读取）。
   * 旧工具自己没有声明 replay，所以由调用方按名字表决定。
   */
  replaySafe?: (name: string) => boolean,
): ToolRegistration[] {
  // 入参放宽到 `unknown[]`：MCP runtime 交来的是 `AgentHarnessTool[]`，它的 execute
  // 把 `onUpdate` 声明成必填——两份类型在「可选性」上不可赋值，但运行时形状一致。
  return tools.map((tool) =>
    adaptLegacyTool(
      tool as LegacyTool,
      env,
      replaySafe === undefined ? undefined : { replay: replaySafe((tool as LegacyTool).name) ? "safe" : "unsafe" },
    ),
  );
}

export function adaptLegacyTool(
  tool: LegacyTool,
  env: unknown,
  options: { replay?: "safe" | "unsafe" } = {},
): ToolRegistration {
  const adapted = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: options.replay ?? (tool.replay === "safe" ? "safe" : "unsafe"),
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    ...(tool.prepareArguments === undefined
      ? {}
      : { prepareArguments: (args: unknown) => tool.prepareArguments?.(args) }),
    async execute(
      args: unknown,
      api: {
        callId: string;
        output: (chunk: string) => void;
        memo: {
          (name: string, context: Context): Promise<JsonValue | undefined>;
          (name: string, candidate: JsonValue, context: Context): Promise<JsonValue>;
        };
        taskId: unknown;
      },
      executionContext: Context,
    ): Promise<{
      output: unknown;
      details: JsonValue;
      isError: boolean;
      usage?: unknown;
    }> {
      // 旧工具推全量快照；转成 durable 的追加语义。非前缀变化（工具改了输出头）只能整段重发。
      let emitted = "";
      const onUpdate = (partial: LegacyToolResult): void => {
        const next = textOfContent(partial?.content);
        if (next.length === 0) return;
        if (next.startsWith(emitted)) {
          const delta = next.slice(emitted.length);
          if (delta.length > 0) api.output(delta);
        } else {
          api.output(next);
        }
        emitted = next;
      };
      // 旧工具的 `invocation` 只有 subagent 用到（memo 重放）；这里用 durable 的 memo 顶上，
      // 语义一致：同一个工具调用内可读写、跨重放保留。
      const invocation = {
        invocationId: api.callId,
        operationId: String(api.taskId),
        turnId: String(api.taskId),
        getMemo: (name: string) => api.memo(name, executionContext),
        setMemo: (name: string, value: JsonValue) => api.memo(name, value, executionContext),
      };
      const result = await tool.execute(
        api.callId,
        args,
        onUpdate,
        { env },
        invocation,
        executionContext,
      );
      return {
        output: result.content,
        details: (result.details ?? null) as JsonValue,
        isError: result.isError === true,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    },
  };
  // 参数 schema 来自 pi-agent-core 自带的 typebox：运行时就是一份 JSON Schema，
  // 与根 typebox 的 brand 差异只在编译期。
  return adapted as unknown as ToolRegistration;
}
