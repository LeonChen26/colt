// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 子代理的**完整流**（⑦ 下钻的内容层之一，与「文件内容」并列）。
 *
 * 为什么它不在视图里：`ConversationView` 是全量快照、流式期间每 50ms 整份重推，
 * 子代理的整份 transcript 会按「子代理数 × 推送次数」乘上去。所以视图只带有界尾部
 * （`ViewSubagent.tail`），完整流是**点进来才拉**（`session.subagentTranscript`）——
 * 与「工具截图落盘、按需读回」同一条取舍。
 *
 * 复用 `MessageBubble` 渲染：同一件事（消息 + 工具卡 + 图片）不该有第二套画法。
 */
import { useCallback, useEffect, useState } from "react";
import type { ViewMessage, ViewSubagent, ViewToolResult } from "@shared/worker-protocol";
import { MessageBubble, type ToolResult } from "../MessageList";

type StreamState =
  | { status: "loading" }
  | { status: "ok"; messages: ViewMessage[]; resultMap: Map<string, ToolResult> }
  | { status: "failed"; message: string };

export function SubagentStream({
  sessionId,
  subagentId,
  reloadToken,
}: {
  sessionId: string;
  subagentId: string;
  /**
   * 重拉令牌：同一个子代理**再点一次**也会换个新值（见 `DrillRequest.token`），
   * 用来重读——它可能又跑了几步，而 `layer` / `subagentId` 都没变，光靠它们不会重拉。
   * 与文件内容层的 `FilePreview.reloadToken` 同一手法。
   */
  reloadToken: number;
}): React.JSX.Element {
  const [state, setState] = useState<StreamState>({ status: "loading" });
  /** 卡片的展开状态：本面板自己持有一份就够（这里没有「流式区 / 完成态」两处挂载的问题） */
  const [openState, setOpenState] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const toggleOpen = useCallback((id: string, open: boolean) => {
    setOpenState((prev) => new Map(prev).set(id, open));
  }, []);

  useEffect(() => {
    let stale = false;
    setState({ status: "loading" });
    void window.colt
      .invoke("session.subagentTranscript", { sessionId, id: subagentId })
      .then((result) => {
        if (stale) return;
        const resultMap = new Map<string, ToolResult>();
        for (const item of result.toolResults as ViewToolResult[]) {
          resultMap.set(item.id, {
            output: item.output,
            isError: item.isError,
            ...(item.hasImage === undefined ? {} : { hasImage: item.hasImage }),
            ...(item.image === undefined ? {} : { image: item.image }),
          });
        }
        setState({ status: "ok", messages: result.messages, resultMap });
      })
      .catch((error: unknown) => {
        if (stale) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      stale = true;
    };
  }, [sessionId, subagentId, reloadToken]);

  if (state.status === "loading") {
    return (
      <p className="px-3 py-6 text-center text-[11.5px] text-text-muted">正在读取子代理的过程…</p>
    );
  }
  if (state.status === "failed") {
    return (
      <p className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-text-muted">
        读取子代理过程失败：{state.message}
      </p>
    );
  }
  if (state.messages.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-text-muted">
        这个子代理还没有留下过程记录（可能刚启动，或它的历史已随会话进程一起回收）。
      </p>
    );
  }
  return (
    <div
      data-subagent-stream={subagentId}
      data-subagent-stream-token={reloadToken}
      className="flex flex-col gap-2 p-3"
    >
      {state.messages.map((message) => (
        <MessageBubble
          key={message.id}
          sessionId={sessionId}
          message={message}
          resultMap={state.resultMap}
          changes={[]}
          subagents={EMPTY_SUBAGENTS}
          openState={openState}
          onToggleOpen={toggleOpen}
        />
      ))}
    </div>
  );
}

/** 空表：这里不接子代理下钻（禁止递归） */
const EMPTY_SUBAGENTS: ReadonlyMap<string, ViewSubagent> = new Map();
