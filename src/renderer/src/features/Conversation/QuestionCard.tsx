// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 提问卡片（ask_user）：模型在等人给信息时的阻塞态呈现。
 *
 * 与 `ApprovalCard` **共用骨架**（卡片外观、逐秒倒计时、乐观移除），但内容与按钮区不同，
 * 差别都有理由：
 * - 没有风险档位，也没有「始终允许」：提问不是有副作用的动作，是向人要信息；
 *   给它一个「本次会话内不再询问」等于永久静默提问——那是死控件，不是便利
 * - **不展开**：提问没有「完整参数」可看，放一个展开箭头就是点不出东西的死交互
 * - **一次只渲染一题（多题时上/下一题翻页）**：选项是给眼睛扫的，四题平铺会把卡片顶得
 *   很长，而人在阻塞里只想尽快答完。页码写「第 N / M 题」，单题时不出翻页控件
 * - **每题都能自由输入**：选项是模型的建议，不是封闭集。选项下方常驻一个输入框，
 *   两者**合并回传**（选中项在前、自填在后，拼装在 `lib/question-answer.ts`），
 *   于是「选两个再补一句」与「一个都不选、直接写」都成立
 * - **回车 = 非末页翻下一题、末页提交**（单行输入框里回车本来没有别的语义）；但
 *   **输入法合成中的回车必须放行**——中文里那是「确认候选词」，挡不住就会打字途中翻页/提交
 * - 全部作答后一次提交；另有「跳过」这条明确出路
 *
 * 落定后卡片消失，结果由随后的 `ask_user` 工具结果承载（用户与模型看到的是同一句话）。
 */
import { useState } from "react";
import { Bot, Clock, MessageCircleQuestion, Send, SkipForward } from "lucide-react";
import { ICON } from "@/lib/icon";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { composeAnswer, isAnswered } from "@/lib/question-answer";
import type { AskUserQuestion } from "@shared/worker-protocol";
import type { UserQuestionRequest } from "@shared/protocol";
import { cn } from "../../lib/utils";

export function QuestionCards({
  requests,
  onAnswer,
  onSkip,
}: {
  requests: UserQuestionRequest[];
  onAnswer: (toolCallId: string, answers: Record<string, string>) => void;
  onSkip: (toolCallId: string) => void;
}): React.JSX.Element | null {
  if (requests.length === 0) return null;
  return (
    <>
      {requests.map((request) => (
        <QuestionCard
          key={request.toolCallId}
          request={request}
          onAnswer={(answers) => onAnswer(request.toolCallId, answers)}
          onSkip={() => onSkip(request.toolCallId)}
        />
      ))}
    </>
  );
}

export function QuestionCard({
  request,
  onAnswer,
  onSkip,
}: {
  request: UserQuestionRequest;
  onAnswer: (answers: Record<string, string>) => void;
  onSkip: () => void;
}): React.JSX.Element | null {
  /** 每题已选的 label 列表；键是问题原文（答案的键与之一致） */
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  /** 每题自填的文字，同样以问题原文为键；与选中项**合并**回传（见 composeAnswer） */
  const [typed, setTyped] = useState<Record<string, string>>({});
  /** 当前页码：多题时一次只渲染一题（选项是给眼睛扫的，平铺会把卡片顶得太长） */
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // 可见超时：与主进程/worker 同一时间基准，逐秒回退（窗口不可见时暂停，F11）
  useVisibleInterval(() => setNow(Date.now()), 1000);
  const remainSec = Math.max(
    0,
    Math.ceil((request.requestedAt + request.timeoutMs - now) / 1000),
  );
  const expired = remainSec <= 0;
  const total = request.questions.length;
  // 空问卷走不到：worker 的 `validateQuestionnaire` 强制 1~4 题，`notifyQuestion` 也是这么防的
  // （`if (!first) return`）。但真到了就什么都别画——下面按 `index` 取题会拿到 `undefined`，
  // 一读 `current.header` 就是**整棵树的渲染层白屏**（`Math.min(0, -1)` 那一步骗不过类型）。
  if (total === 0) return null;
  // 页码夹在范围内：新一轮提问靠 key 重建组件，这里只是防御换题时页码越界
  const index = Math.min(page, total - 1);
  const current = request.questions[index]!;
  const answerOf = (question: AskUserQuestion): string =>
    composeAnswer(picked[question.question] ?? [], typed[question.question] ?? "");
  const answeredCount = request.questions.filter((q) => isAnswered(answerOf(q))).length;
  const allAnswered = answeredCount === total;

  function toggle(question: AskUserQuestion, label: string): void {
    if (busy || expired) return;
    setPicked((prev) => {
      const pickedNow = prev[question.question] ?? [];
      if (question.multiSelect === true) {
        const next = pickedNow.includes(label)
          ? pickedNow.filter((item) => item !== label)
          : [...pickedNow, label];
        return { ...prev, [question.question]: next };
      }
      return { ...prev, [question.question]: [label] };
    });
  }

  function submit(): void {
    if (busy || expired || !allAnswered) return;
    setBusy(true);
    const answers: Record<string, string> = {};
    for (const question of request.questions) {
      answers[question.question] = answerOf(question);
    }
    onAnswer(answers);
  }

  /**
   * 输入框里的回车：**非末页翻到下一题，末页则提交**（提交自己会挡住「没答完 / 忙 / 超时」，
   * 这里不必重复那套判断）。回车在单行输入框里本来就没有别的语义，接管它不抢走什么。
   *
   * 必须先看 `isComposing`：中文输入法里**回车是「确认候选词」**，不挡就会在打字途中把
   * 页面翻走、甚至提交半份答案——这是中文界面最典型的坑，而且在英文环境里测不出来。
   */
  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (index < total - 1) {
      setPage(index + 1);
      return;
    }
    submit();
  }

  return (
    // data-question-* 供冒烟做稳定查询（同 data-conv-attach-notice 的用法）：断言不依赖 class
    <div data-question-card className="rounded-lg border border-accent/50 bg-accent-soft p-3">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion {...ICON.lg} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] font-medium text-text-primary">需要你的决定</span>
            <span className="text-[11.5px] text-text-muted">
              {total} 个问题
              {allAnswered ? "" : `（已答 ${answeredCount}）`}
            </span>
            {/* 来源：这次提问是某个子代理发起的，不是主对话（决策三 D5 的「来自 X」chip） */}
            {request.subagent !== undefined && (
              <span
                data-question-subagent={request.subagent.name}
                title="这次提问来自一个子代理，不是主对话"
                className="flex items-center gap-1 rounded-xs border border-line px-1.5 py-0.5 text-[11.5px] text-text-secondary"
              >
                <Bot {...ICON.xs} className="shrink-0 text-text-muted" />
                来自 {request.subagent.name}
              </span>
            )}
          </div>
          <p className="mt-1 text-[11.5px] text-text-muted">
            模型卡在这里等你回答，不作答它不会继续。
          </p>
        </div>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 font-mono text-[11.5px]",
            expired ? "text-text-muted" : "text-accent",
          )}
        >
          <Clock {...ICON.xs} />
          {expired ? "已超时" : `${remainSec}s 后超时`}
        </span>
      </div>

      {/* 多题才出翻页控件：单题时它就是一张普通卡，多一行「第 1 / 1 题」纯属噪音 */}
      {total > 1 && (
        <div className="mt-3 flex items-center gap-2">
          <span data-question-page className="font-mono text-[11.5px] text-text-muted">
            第 {index + 1} / {total} 题
          </span>
          <span className="flex-1" />
          <button
            type="button"
            data-question-prev
            disabled={busy || expired || index === 0}
            onClick={() => setPage(index - 1)}
            className="rounded-md border border-line px-2 py-0.5 text-[11.5px] text-text-secondary transition hover:text-text-primary disabled:opacity-40"
          >
            上一题
          </button>
          <button
            type="button"
            data-question-next
            disabled={busy || expired || index === total - 1}
            onClick={() => setPage(index + 1)}
            className="rounded-md border border-line px-2 py-0.5 text-[11.5px] text-text-secondary transition hover:text-text-primary disabled:opacity-40"
          >
            下一题
          </button>
        </div>
      )}

      <div className="mt-3">
        {current.header !== undefined && (
          <span className="text-[11.5px] font-medium uppercase tracking-wide text-text-muted">
            {current.header}
          </span>
        )}
        <p className="text-[11.5px] text-text-primary">{current.question}</p>
        {current.multiSelect === true && (
          <p className="mt-0.5 text-[11.5px] text-text-muted">可多选</p>
        )}
        <div className="mt-1.5 flex flex-col gap-1">
          {current.options.map((option) => {
            const selected = (picked[current.question] ?? []).includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                data-question-option={option.label}
                disabled={busy || expired}
                aria-pressed={selected}
                onClick={() => toggle(current, option.label)}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-left transition disabled:opacity-50",
                  selected
                    ? "border-accent bg-accent/10"
                    : "border-line hover:border-line-strong hover:bg-surface-overlay",
                )}
              >
                <span className="text-[11.5px] text-text-primary">{option.label}</span>
                {option.description !== "" && (
                  <span className="mt-0.5 block text-[11.5px] text-text-muted">
                    {option.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {/*
          自由输入与选项**合并**回传，不是二选一：选项覆盖模型想到的主要分支，输入兜住它
          没想到的答案。所以打字**不清空**已选——拼成「A、B、自填」由 composeAnswer 负责。
        */}
        <input
          data-question-input
          type="text"
          aria-label="自己输入回答"
          value={typed[current.question] ?? ""}
          onChange={(e) => setTyped((prev) => ({ ...prev, [current.question]: e.target.value }))}
          onKeyDown={onInputKeyDown}
          disabled={busy || expired}
          placeholder="或自己输入…"
          className="mt-1.5 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11.5px] text-text-primary outline-none transition placeholder:text-text-muted focus:border-accent disabled:opacity-50"
        />
      </div>

      {expired ? (
        <p className="mt-3 text-[11.5px] text-text-muted">
          已超时：模型已收到「未作答」，会按自己的假设继续并在回复里说明。
        </p>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            data-question-submit
            disabled={busy || !allAnswered}
            onClick={submit}
            title={allAnswered ? undefined : "每道题都要选一项或自己输入才能提交"}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-50"
          >
            <Send {...ICON.sm} />
            提交
          </button>
          <span className="flex-1" />
          <button
            type="button"
            data-question-skip
            disabled={busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              onSkip();
            }}
            title="不回答：模型会按自己的假设继续，并说明假设"
            className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:text-text-primary disabled:opacity-50"
          >
            <SkipForward {...ICON.sm} />
            跳过
          </button>
        </div>
      )}
    </div>
  );
}
