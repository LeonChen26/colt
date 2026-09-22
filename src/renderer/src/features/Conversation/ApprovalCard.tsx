// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 工具审批卡片：阻塞态的显式呈现，对齐 ACP 权限模型。
 *
 * lane 在等待期间是挂起的，所以必须让用户一眼看出「在等我」，
 * 并给出四档语义 + 可见超时，而不是以为程序卡死。
 */
import { useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Clock, ShieldAlert, ShieldQuestion, X } from "lucide-react";
import { ICON } from "@/lib/icon";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import type { ApprovalRequest, ApprovalRisk } from "@shared/protocol";
import type { ViewFileChange } from "@shared/worker-protocol";
import { mcpToolLabel } from "@shared/mcp-label";
import { DiffView } from "../../components/DiffView";
import { formatArgs, matchChangeByPath, parseArgsJson } from "../../lib/format";
import { cn } from "../../lib/utils";

const RISK_STYLE: Record<ApprovalRisk, { label: string; className: string }> = {
  safe: { label: "低风险", className: "text-text-secondary" },
  moderate: { label: "需确认", className: "text-warning" },
  dangerous: { label: "高风险", className: "text-danger" },
};

export function ApprovalCard({
  request,
  changes,
  onResolve,
}: {
  request: ApprovalRequest;
  changes: ViewFileChange[];
  onResolve: (input: {
    approved: boolean;
    remember?: "signature" | "tool";
    deny?: "signature" | "tool";
  }) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const risk = RISK_STYLE[request.risk];
  const dangerous = request.risk === "dangerous";
  const change = matchChangeByPath(changes, parseArgsJson(request.argsJson).path);

  // 可见超时：与主进程/worker 同一时间基准，逐秒回退（窗口不可见时暂停，F11）
  useVisibleInterval(() => setNow(Date.now()), 1000);
  const remainSec = Math.max(
    0,
    Math.ceil((request.requestedAt + request.timeoutMs - now) / 1000),
  );
  const expired = remainSec <= 0;

  function resolve(
    approved: boolean,
    extra?: { remember?: "signature" | "tool"; deny?: "signature" | "tool" },
  ): void {
    if (busy || expired) return;
    setBusy(true);
    onResolve({ approved, ...extra });
  }

  return (
    <div
      className={cn(
        "rounded-lg border bg-surface-raised p-3",
        dangerous ? "border-danger/60 bg-danger-soft/50" : "border-warning/50 bg-warning-soft",
      )}
    >
      <div className="flex items-start gap-2">
        {dangerous ? (
          <ShieldAlert {...ICON.lg} className="mt-0.5 shrink-0 text-danger" />
        ) : (
          <ShieldQuestion {...ICON.lg} className="mt-0.5 shrink-0 text-warning" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] font-medium text-text-primary">需要你的许可</span>
            <span className={cn("text-[11.5px]", risk.className)}>{risk.label}</span>
            {/* 来源：这次调用是某个子代理发起的，不是主对话（决策三 D5 的「来自 X」chip） */}
            {request.subagent !== undefined && (
              <span
                data-approval-subagent={request.subagent.name}
                title="这次调用来自一个子代理，不是主对话"
                className="flex items-center gap-1 rounded-xs border border-line px-1.5 py-0.5 text-[11.5px] text-text-secondary"
              >
                <Bot {...ICON.xs} className="shrink-0 text-text-muted" />
                来自 {request.subagent.name}
              </span>
            )}
          </div>
          <p className="mt-1 break-all font-mono text-[11.5px] text-text-primary">{request.summary}</p>
          <p className="mt-1 text-[11.5px] text-text-muted">{request.reason}</p>
        </div>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 font-mono text-[11.5px]",
            expired ? "text-text-muted" : "text-warning",
          )}
        >
          <Clock {...ICON.xs} />
          {expired ? "已超时" : `${remainSec}s 后超时`}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="mt-2 flex items-center gap-1 text-[11.5px] text-text-muted transition hover:text-text-primary"
      >
        {expanded ? <ChevronDown {...ICON.sm} /> : <ChevronRight {...ICON.sm} />}
        {change?.patch ? "查看改动" : "完整参数"}
      </button>
      {expanded &&
        (change?.patch ? (
          <div className="mt-1">
            <DiffView patch={change.patch} />
          </div>
        ) : (
          <pre className="mt-1 max-h-48 overflow-auto rounded-xs bg-surface-code p-2 font-mono text-[11.5px] text-text-secondary">
            {formatArgs(request.argsJson)}
          </pre>
        ))}

      {expired ? (
        <p className="mt-3 text-[11.5px] text-text-muted">已超时自动拒绝，如需执行请重新发起。</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve(true)}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-50"
          >
            <Check {...ICON.sm} />
            允许一次
          </button>
          {!dangerous && (
            <button
              type="button"
              disabled={busy}
              onClick={() => resolve(true, { remember: "tool" })}
              className="rounded-md border border-line px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:text-text-primary disabled:opacity-50"
              title={`本次会话内不再询问 ${mcpToolLabel(request.toolName) ?? request.toolName} 的同级风险调用`}
            >
              本会话内始终允许
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve(false)}
            className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:text-text-primary disabled:opacity-50"
          >
            <X {...ICON.sm} />
            拒绝一次
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve(false, { deny: "tool" })}
            className="rounded-md border border-danger/40 px-2.5 py-1 text-[11.5px] text-danger transition hover:bg-danger-soft disabled:opacity-50"
            title={`本次会话内自动拒绝 ${mcpToolLabel(request.toolName) ?? request.toolName}`}
          >
            始终拒绝
          </button>
        </div>
      )}
    </div>
  );
}
