// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 子代理的**过程**（⑦ 下钻的内容层之一，与「文件内容」并列）。
 *
 * 这一层要回答「它到底在干什么」，而**同一个子代理在运行中与跑完之后是两个不同的真源**：
 *
 * - **运行中** → 走**视图通道**（`ViewSubagent.tail`）：它是**实时**的，但**有界**——
 *   视图是全量快照、流式期间每 50ms 整份重推，把整份 transcript 塞进去会按
 *   「子代理数 × 推送次数」乘上去。
 * - **跑完之后** → 走**一次性快照**（`session.subagentTranscript`）：那时它不再变，
 *   拉一次就是完整流（与「工具截图落盘、按需读回」同一条取舍）。
 *
 * 为什么不能「运行中也拉完整流」：那份快照拉回来就**静止**了，而子代理还在动——表现为
 * 「概览（④ 卡）比详情新」：用户点进来看到一张旧画面，还得退出去再点一次才刷新。
 * 两个通道各归其位，这个毛病就没有了。
 *
 * 复用 `MessageBubble` 渲染：同一件事（消息 + 工具卡 + 图片）不该有第二套画法。
 */
import { useCallback, useEffect, useState } from "react";
import type { ViewMessage, ViewSubagent, ViewToolResult } from "@shared/worker-protocol";
import { MessageBubble, type ToolResult } from "../MessageList";
import { SubagentPreview } from "../SubagentPreview";

type StreamState =
  | { status: "loading" }
  | { status: "ok"; messages: ViewMessage[]; resultMap: Map<string, ToolResult> }
  | { status: "failed"; message: string };

export function SubagentStream({
  sessionId,
  subagentId,
  reloadToken,
  subagent,
}: {
  sessionId: string;
  subagentId: string;
  /**
   * 重拉令牌：同一个子代理**再点一次**也会换个新值（见 `DrillRequest.token`），
   * 用来重读——它可能又跑了几步，而 `layer` / `subagentId` 都没变，光靠它们不会重拉。
   * 与文件内容层的 `FilePreview.reloadToken` 同一手法。
   */
  reloadToken: number;
  /** 这个子代理在**当前视图**里的那份（实时通道）；取不到就只能按「已结束」处理 */
  subagent: ViewSubagent | undefined;
}): React.JSX.Element {
  // 两个分支是**不同的组件**，所以状态一变就会重新挂载：子代理一跑完，`FetchedStream`
  // 的 effect 自己跑一次，把完整流拉回来——不需要谁来通知「它跑完了」。
  if (subagent?.status === "running") return <LiveStream subagent={subagent} />;
  return <FetchedStream sessionId={sessionId} subagentId={subagentId} reloadToken={reloadToken} />;
}

/**
 * 运行中：画视图里那份有界 tail（跟着视图实时刷新）。
 *
 * **明说它是有界的**：视图只保留最近若干步，而这一层挂着「过程」的名义——不写清楚，
 * 用户会以为它只跑了这几步（`docs/ERRORS.md`：截断可以，静默截断不行）。
 */
function LiveStream({ subagent }: { subagent: ViewSubagent }): React.JSX.Element {
  return (
    <div data-subagent-live={subagent.id} className="flex flex-col gap-2 p-3">
      <p className="rounded-[5px] border border-line bg-surface-raised px-2 py-1.5 text-[11px] leading-relaxed text-text-muted">
        还在跑：这一层**跟着实时刷新**，但只画视图里带的**最近几步**——完整过程要等它跑完
        （那时会自动换成整份）。
      </p>
      <SubagentPreview subagent={subagent} />
    </div>
  );
}

/** 已结束：拉一次完整流（那时它不再变，快照即完整） */
function FetchedStream({
  sessionId,
  subagentId,
  reloadToken,
}: {
  sessionId: string;
  subagentId: string;
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
