// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 审批规则面板：查看并管理会话内记忆的放行 / 拒绝规则。
 *
 * 这些规则只存在于主进程内存、以 Colt 会话为单位存活（不落盘），
 * 一旦记错就会表现为「明明没点拒绝却总被拦」或「本该询问却不再问」，
 * 且此前没有任何入口能看到它们。本面板补齐这个可观测性缺口。
 */
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { ApprovalRuleKind, ApprovalRuleView } from "@shared/protocol";
import { cn } from "../../../lib/utils";
import { SidePanelShell } from "./SidePanelShell";

/** 一份规则的中文描述：工具 + 范围 + 签名上下文 */
function describeRule(rule: ApprovalRuleView): { scope: string; detail: string | null } {
  const tool = rule.toolName;
  if (rule.scope === "tool") {
    return { scope: `整个 ${tool}`, detail: null };
  }
  // 签名形如 "bash:<命令>" / "edit:<路径>"，去掉前缀工具名更好读
  const raw = rule.signature ?? "";
  const detail = raw.startsWith(`${tool}:`) ? raw.slice(tool.length + 1) : raw;
  return { scope: `同参数 ${tool}`, detail: detail || null };
}

export function RulesPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [rules, setRules] = useState<ApprovalRuleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.colt.invoke("approval.rules.list", { sessionId });
      setRules(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (ruleId: string) => {
      setBusy(true);
      setError(null);
      try {
        await window.colt.invoke("approval.rules.remove", { sessionId, ruleId });
        // 本地同步移除，省一次往返；失败时下面的 load 会纠正
        setRules((list) => list.filter((rule) => rule.id !== ruleId));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [sessionId, load],
  );

  const clear = useCallback(
    async (kind?: ApprovalRuleKind) => {
      setBusy(true);
      setError(null);
      try {
        await window.colt.invoke("approval.rules.clear", { sessionId, kind });
        setRules((list) => (kind === undefined ? [] : list.filter((rule) => rule.kind !== kind)));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        await load();
      } finally {
        setBusy(false);
      }
    },
    [sessionId, load],
  );

  const allowed = rules.filter((rule) => rule.kind === "allow");
  const denied = rules.filter((rule) => rule.kind === "deny");

  const section = (title: string, kind: ApprovalRuleKind, list: ApprovalRuleView[]) => {
    if (list.length === 0) return null;
    return (
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span
            className={cn(
              "text-2xs uppercase tracking-[.5px]",
              kind === "deny" ? "text-danger" : "text-text-muted",
            )}
          >
            {title} · {list.length}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void clear(kind)}
            className="text-2xs text-text-muted transition hover:text-danger disabled:opacity-50"
          >
            全部清除
          </button>
        </div>
        {list.map((rule) => {
          const { scope, detail } = describeRule(rule);
          return (
            <div
              key={rule.id}
              className={cn(
                "mb-1 flex items-start gap-2 rounded-md border px-2 py-1.5",
                kind === "deny" ? "border-danger/40 bg-danger-soft" : "border-line bg-surface-overlay",
              )}
            >
              <ShieldCheck
                {...ICON.sm}
                className={cn(
                  "mt-0.5 shrink-0",
                  kind === "deny" ? "text-danger" : "text-text-muted",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-text-primary">{scope}</div>
                {detail && (
                  <div className="mt-0.5 truncate font-mono text-2xs text-text-muted" title={detail}>
                    {detail}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(rule.id)}
                title="删除这条规则"
                className="shrink-0 text-text-muted transition hover:text-danger disabled:opacity-50"
              >
                <Trash2 {...ICON.sm} />
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <SidePanelShell
      title="审批规则"
      icon={<ShieldCheck {...ICON.sm} />}
      meta={
        rules.length > 0 ? <span className="text-text-muted">{rules.length} 条</span> : null
      }
      loading={loading}
      error={error}
      isEmpty={rules.length === 0}
      empty="本次会话还没有记住任何规则。在审批卡片上选「本会话内始终允许」或「始终拒绝」时会记在这里。"
      onRefresh={() => void load()}
    >
      <div className="mb-3 text-2xs leading-relaxed text-text-muted">
        规则仅存于内存，以会话为单位存活：删除会话或退出应用即失效。
      </div>
      {section("放行", "allow", allowed)}
      {section("拒绝", "deny", denied)}
    </SidePanelShell>
  );
}
