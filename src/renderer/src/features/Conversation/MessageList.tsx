/**
 * 消息渲染：消息气泡、可展开的工具卡片、流式光标。
 * 作者：陕耀云栈WorkMate
 */
import { useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import type { ViewMessage } from "@shared/worker-protocol";
import { TerminalOutput } from "../../components/TerminalOutput";
import { formatArgs } from "../../lib/format";
import { cn } from "../../lib/utils";

/** 一条消息：正文气泡 + 其发起的工具调用卡片 */
export function MessageBubble({
  message,
  resultMap,
}: {
  message: ViewMessage;
  resultMap: Map<string, { output: string; isError: boolean }>;
}): React.JSX.Element | null {
  // 工具结果已合并进各自的工具卡片，不再单独成条
  if (message.role === "toolResult") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (!message.text && message.toolCalls.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {message.text && <Bubble role={message.role}>{message.text}</Bubble>}
      {message.toolCalls.map((call) => (
        <ToolCard key={call.id} call={call} result={resultMap.get(call.id)} />
      ))}
    </div>
  );
}

/** 可展开的工具调用卡片：折叠时只显示名称与参数摘要 */
function ToolCard({
  call,
  result,
}: {
  call: { id: string; name: string; args: string };
  result?: { output: string; isError: boolean };
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const isBash = call.name === "bash";

  return (
    <div
      className={cn(
        "self-start overflow-hidden rounded-lg border bg-[--color-surface-raised]",
        result?.isError ? "border-[--color-danger]/50" : "border-[--color-border-subtle]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition hover:bg-[--color-surface-overlay]/50"
      >
        <ChevronRight
          size={12}
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        />
        <Terminal size={12} className="shrink-0 text-[--color-text-muted]" />
        <span className="font-mono text-xs">{call.name}</span>
        <span className="truncate font-mono text-xs text-[--color-text-muted]">{call.args}</span>
        {result?.isError && <span className="ml-auto shrink-0 text-xs text-[--color-danger]">失败</span>}
      </button>

      {open && (
        <div className="border-t border-[--color-border-subtle] p-2">
          <div className="mb-1 text-xs text-[--color-text-muted]">参数</div>
          <pre className="mb-2 max-h-32 overflow-auto rounded-md bg-black/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {formatArgs(call.args)}
          </pre>
          <div className="mb-1 text-xs text-[--color-text-muted]">输出</div>
          {result ? (
            isBash ? (
              <TerminalOutput text={result.output} className="max-h-80" />
            ) : (
              <pre className="max-h-80 overflow-auto rounded-md bg-black/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                {result.output}
              </pre>
            )
          ) : (
            <p className="px-1 text-xs text-[--color-text-muted]">（无输出）</p>
          )}
        </div>
      )}
    </div>
  );
}

/** 消息气泡；streaming 时尾部带一个闪烁光标 */
export function Bubble({
  role,
  children,
  streaming,
}: {
  role: "user" | "assistant";
  children: React.ReactNode;
  streaming?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
        role === "user"
          ? "self-end bg-[--color-accent] text-white"
          : "self-start border border-[--color-border-subtle] bg-[--color-surface-raised]",
      )}
    >
      {children}
      {streaming && (
        <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle" />
      )}
    </div>
  );
}
