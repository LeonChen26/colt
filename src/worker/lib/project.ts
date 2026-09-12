/**
 * worker 侧的纯投影辅助：从内核数据结构中抽取渲染层需要的字段。
 * 无副作用、不依赖 Electron / pi-agent-core，便于单元测试。
 * 作者：陕耀云栈WorkMate
 */
import { isAbsolute, relative } from "node:path";
import type { ViewMessage } from "@shared/worker-protocol";

/** 从消息内容块中抽取纯文本 */
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("");
}

/** 从助手消息中抽取工具调用 */
export function extractToolCalls(content: unknown): ViewMessage["toolCalls"] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is { type: "toolCall"; id: string; name: string; arguments?: unknown } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall";
    })
    .map((block) => ({
      id: block.id,
      name: block.name,
      args: (() => {
        try {
          return JSON.stringify(block.arguments ?? {});
        } catch {
          return "{}";
        }
      })(),
    }));
}

/** 从工具结果的 content 块中抽取文本（与消息 content 结构一致） */
export function extractToolText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  return extractText((result as { content?: unknown }).content);
}

/** 统计 unified patch 的增删行数 */
export function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    // 排除 --- / +++ 文件头
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

/** 把绝对路径收敛为相对工作目录的路径，便于 UI 展示 */
export function toRelative(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path.replaceAll("\\", "/");
  const rel = relative(cwd, path);
  return (rel.startsWith("..") ? path : rel).replaceAll("\\", "/");
}
