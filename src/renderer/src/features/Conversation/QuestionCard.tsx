// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 提问卡片（ask_user）：模型在等人给信息时的阻塞态呈现。
 *
 * 与 `ApprovalCard` **共用骨架**（卡片外观、逐秒倒计时、乐观移除），但内容与按钮区不同，
 * 差别都有理由（`docs/DESIGN-ask-user.md` §5、§6）：
 * - 没有风险档位，也没有「始终允许」：提问不是有副作用的动作，是向人要信息；
 *   给它一个「本次会话内不再询问」等于永久静默提问——那是死控件，不是便利
 * - **不展开**：提问没有「完整参数」可看，放一个展开箭头就是点不出东西的死交互
 * - 每题一组选项按钮（单选 / 多选），全部作答后一次提交；另有「跳过」这条明确出路
 *
 * 落定后卡片消失，结果由随后的 `ask_user` 工具结果承载（用户与模型看到的是同一句话）。
 */
import { useEffect, useState } from "react";
import { Clock, MessageCircleQuestion, Send, SkipForward } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { AskUserQuestion } from "@shared/worker-protocol";
import type { UserQuestionRequest } from "@shared/protocol";
import { cn } from "../../lib/utils";

/** 多选以顿号相连回传；`formatAnswers` 按问题原文取答案，拼成的就是模型读到的那行 */
const MULTI_SEPARATOR = "、";

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
}): React.JSX.Element {
  /** 每题已选的 label 列表；键是问题原文（答案的键与之一致） */
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // 可见超时：与主进程/worker 同一时间基准，逐秒回退
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remainSec = Math.max(
    0,
    Math.ceil((request.requestedAt + request.timeoutMs - now) / 1000),
  );
  const expired = remainSec <= 0;
  const answeredCount = request.questions.filter((q) => (picked[q.question]?.length ?? 0) > 0).length;
  const allAnswered = answeredCount === request.questions.length;

  function toggle(question: AskUserQuestion, label: string): void {
    if (busy || expired) return;
    setPicked((prev) => {
      const current = prev[question.question] ?? [];
      if (question.multiSelect === true) {
        const next = current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label];
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
      answers[question.question] = (picked[question.question] ?? []).join(MULTI_SEPARATOR);
    }
    onAnswer(answers);
  }

  return (
    // data-question-* 供冒烟做稳定查询（同 data-conv-attach-notice 的用法）：断言不依赖 class
    <div data-question-card className="rounded-lg border border-accent/50 bg-accent-soft p-3">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion {...ICON.lg} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-primary">需要你的决定</span>
            <span className="text-xs text-text-muted">
              {request.questions.length} 个问题
              {allAnswered ? "" : `（已答 ${answeredCount}）`}
            </span>
          </div>
          <p className="mt-1 text-xs text-text-muted">
            模型卡在这里等你回答，不作答它不会继续。
          </p>
        </div>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 font-mono text-[11px]",
            expired ? "text-text-muted" : "text-accent",
          )}
        >
          <Clock {...ICON.xs} />
          {expired ? "已超时" : `${remainSec}s 后超时`}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {request.questions.map((question) => (
          <div key={question.question}>
            {question.header !== undefined && (
              <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                {question.header}
              </span>
            )}
            <p className="text-xs text-text-primary">{question.question}</p>
            {question.multiSelect === true && (
              <p className="mt-0.5 text-[11px] text-text-muted">可多选</p>
            )}
            <div className="mt-1.5 flex flex-col gap-1">
              {question.options.map((option) => {
                const selected = (picked[question.question] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    data-question-option={option.label}
                    disabled={busy || expired}
                    aria-pressed={selected}
                    onClick={() => toggle(question, option.label)}
                    className={cn(
                      "rounded-md border px-2.5 py-1.5 text-left transition disabled:opacity-50",
                      selected
                        ? "border-accent bg-accent/10"
                        : "border-line hover:border-line-strong hover:bg-surface-overlay",
                    )}
                  >
                    <span className="text-xs text-text-primary">{option.label}</span>
                    {option.description !== "" && (
                      <span className="mt-0.5 block text-[11px] text-text-muted">
                        {option.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {expired ? (
        <p className="mt-3 text-xs text-text-muted">
          已超时：模型已收到「未作答」，会按自己的假设继续并在回复里说明。
        </p>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            data-question-submit
            disabled={busy || !allAnswered}
            onClick={submit}
            title={allAnswered ? undefined : "每道题都选一个才能提交"}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-50"
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
            className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-text-secondary transition hover:text-text-primary disabled:opacity-50"
          >
            <SkipForward {...ICON.sm} />
            跳过
          </button>
        </div>
      )}
    </div>
  );
}
