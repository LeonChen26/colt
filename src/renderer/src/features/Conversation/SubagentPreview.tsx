// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 子代理的有界预览（④ 卡展开时用）。
 *
 * 在这里只画「最近几步」而不是完整流：视图里本来就只带有界尾部（`ViewSubagent.tail`），
 * 完整流是**按需拉**的（⑦ 的下钻，走 `session.subagentTranscript`）。
 * 理由与「工具截图不进视图」同源——视图每 50ms 全量重推，被反复搬运的东西要有上限。
 *
 * 截断必须**如实**：给「最近 N / 共 M 步」，不静默砍掉——用户要能判断「还有更多」。
 */
import { Brain } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ViewSubagent } from "@shared/worker-protocol";

export function SubagentPreview({
  subagent,
}: {
  subagent: ViewSubagent;
}): React.JSX.Element {
  const { recentSteps, stepCount, streamingText, thought, runningTools } = subagent.tail;
  const hidden = stepCount - recentSteps.length;
  return (
    <div data-subagent-preview={subagent.id} className="flex flex-col gap-1.5">
      {subagent.error !== undefined && (
        <p className="rounded-sm border border-line bg-danger-soft px-2 py-1.5 text-xs leading-relaxed text-danger-fg">
          {subagent.error}
        </p>
      )}
      {hidden > 0 && (
        <p className="rounded-xs bg-surface-overlay/60 px-2 py-1 text-2xs text-text-muted">
          只列出最近 {recentSteps.length} 步（共 {stepCount} 步）——完整过程在右上「在右栏查看完整过程」
        </p>
      )}
      {recentSteps.map((step) => (
        <div
          key={step.id}
          className="rounded-sm border border-line-soft bg-surface-code px-2 py-1.5"
        >
          <div className="mb-0.5 text-2xs font-medium tracking-[.5px] text-text-muted">
            {step.role === "user" ? "任务 / 用户" : step.role === "assistant" ? "子代理" : step.role}
          </div>
          {step.thought !== undefined && (
            <div className="thought mb-1">
              <span className="flex items-center gap-1 text-2xs text-text-muted">
                <Brain {...ICON.xs} /> 思考
              </span>
              {step.thought}
            </div>
          )}
          {step.text !== "" && (
            <div className="whitespace-pre-wrap text-xs leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
              {step.text}
            </div>
          )}
          {step.toolCalls.map((call) => (
            <div key={call.id} className="truncate font-mono text-2xs text-text-muted">
              {call.name} {call.args}
            </div>
          ))}
        </div>
      ))}
      {/* 流式中的尾巴（还没进 recentSteps）——运行中才可能出现 */}
      {streamingText !== null && streamingText !== "" && (
        <div className="rounded-sm border border-line-soft bg-surface-code px-2 py-1.5">
          <div className="mb-0.5 text-2xs font-medium tracking-[.5px] text-text-muted">
            子代理（正在输出）
          </div>
          <div className="whitespace-pre-wrap text-xs leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
            {streamingText}
          </div>
        </div>
      )}
      {thought !== null && (
        <div className="thought">
          <div className="text-2xs text-text-muted">思考中</div>
          {thought}
        </div>
      )}
      {runningTools.map((tool) => (
        <div key={tool.id} className="truncate font-mono text-2xs text-text-muted">
          <span className="live-dot mr-1 inline-block" />
          {tool.name} {tool.args}
        </div>
      ))}
      {recentSteps.length === 0 && streamingText === null && runningTools.length === 0 && (
        <p className="px-1 text-xs text-text-muted">（还没有内容）</p>
      )}
      {(subagent.stats.inputTokens > 0 || subagent.stats.outputTokens > 0) && (
        <p className="text-2xs text-text-muted">
          这个子代理自己的消耗：输入 {subagent.stats.inputTokens} · 输出{" "}
          {subagent.stats.outputTokens} tokens
          {subagent.stats.costUsd > 0 ? ` · $${subagent.stats.costUsd.toFixed(4)}` : ""}
        </p>
      )}
    </div>
  );
}
