// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「事件」面板：本会话的**安全事件**流（F3）。
 *
 * 技能装载告警、同名技能 / 子代理定义覆盖、AGENTS.md 与记忆读取失败——这些事件
 * SECURITY.md 承诺「如实告知」，但原先只经 notice 通道以 toast 呈现：5 秒即消失、
 * 无历史、无从回查。现在主进程把它们**同时落库**（session_events 表），本面板
 * 从库里读，重启后仍可回看。
 *
 * 数据来自 DB，不订阅、不轮询；唯一例外是面板打开期间收到新的安全 notice 时
 * 增量补一条（notice 事件带 kind="security"），省一次全量往返。
 */
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { SessionEvent } from "@shared/protocol";
import { SidePanelShell } from "./SidePanelShell";

/** 同一内容 5 分钟内不重复落库（主进程去重），面板如实照单全收即可 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? date.toLocaleTimeString("zh-CN")
    : `${date.toLocaleDateString("zh-CN")} ${date.toLocaleTimeString("zh-CN")}`;
}

export function EventsPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.colt.invoke("session.events.list", { sessionId });
      setEvents(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 面板开着的时候来了新的安全 notice：补到最前（主进程已落库，这里只做展示增量）
  useEffect(() => {
    const off = window.colt.on("session.notice", (notice) => {
      if (notice.sessionId !== sessionId || notice.kind !== "security") return;
      setEvents((list) =>
        list.some((item) => item.message === notice.message) ? list : [{ id: -1, message: notice.message, createdAt: Date.now() }, ...list],
      );
    });
    return off;
  }, [sessionId]);

  return (
    <SidePanelShell
      title="安全事件"
      icon={<ShieldAlert {...ICON.sm} />}
      meta={events.length > 0 ? <span className="text-text-muted">{events.length} 条</span> : null}
      loading={loading}
      error={error}
      isEmpty={events.length === 0}
      empty="还没有安全事件。技能装载告警、同名技能覆盖、AGENTS.md 与记忆读取失败等会记录在此（重启后仍可回看）。"
      onRefresh={() => void load()}
    >
      <div className="mb-3 text-[10.5px] leading-relaxed text-text-muted">
        这些事件发生时界面会短暂提示，但提示会消失——这里保留完整记录。
      </div>
      {events.map((event, index) => (
        <div
          key={event.id >= 0 ? event.id : `live-${index}`}
          className="mb-1.5 flex items-start gap-2 rounded-md border border-line bg-surface-overlay px-2 py-1.5"
        >
          <ShieldAlert {...ICON.sm} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] leading-relaxed text-text-primary">{event.message}</div>
            <div className="mt-0.5 text-[10.5px] text-text-muted">{formatTime(event.createdAt)}</div>
          </div>
        </div>
      ))}
    </SidePanelShell>
  );
}
