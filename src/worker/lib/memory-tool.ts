/**
 * 记忆检索工具：worker 侧的薄封装（与 browser-tool 同款形态）。
 *
 * 只读、本地、无副作用——在 READONLY_TOOLS 名单里，不进审批（与 read 同级）。
 * 检索范围与项目隔离都由主进程强制（见 main/host/memory-host.ts），本层不做任何
 * 越界假设；真正「知道以前记过什么」的价值在冷层——现行条目每请求已注入上下文，
 * 这里主要捞的是「曾沉淀过、后来从记忆文件清理掉」的内容。
 */
import { Type } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { definedParams, hostResultToContent, type HostBridge } from "./host-bridge";

const searchSchema = Type.Object({
  query: Type.String({ description: "检索词；中文二字词与英文单词都能命中" }),
  limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 8" })),
});

export function createMemoryTools(bridge: HostBridge): AgentHarnessTool<ExecutionToolContext>[] {
  const searchTool: AgentHarnessTool<ExecutionToolContext, typeof searchSchema, undefined> = {
    name: "memory_search",
    label: "Memory Search",
    description:
      "检索跨会话的记忆条目（只读、无副作用）。当前记忆文件里的内容每轮都已在你可见的上下文里，" +
      "这个工具的价值在「冷层」：曾沉淀过、后来从记忆文件清理掉的内容，以及历史会话的沉淀" +
      "（结果会标注「现行/已归档」与日期）。何时用：想确认以前记过的某个坑、偏好或决策的原文，" +
      "或怀疑存在相关历史记忆时。范围限当前项目与用户级记忆。",
    parameters: searchSchema,
    async execute(_toolCallId, params) {
      const result = await bridge.call("memory", "search", definedParams(params as Record<string, unknown>));
      return { content: hostResultToContent(result), details: undefined };
    },
  };
  return [searchTool];
}
