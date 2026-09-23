// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 起手区：这条会话**还没有任何消息**时，浮在输入区上方的提示块
 * （欢迎语 + 起手建议 + 工作目录）。
 *
 * 为什么单独成组件：它和正常会话是两种排布——正常会话是「消息流占满、输入区贴底」，
 * 起手态是「提示块与输入区一起往上移到相对中间」。`index.tsx` 是体量棘轮盯着的文件
 * （上限 1658），把这块搬出来既让两种排布各自的意图看得清，也不挤那里的余量。
 *
 * ⚠️ 它**不包输入区**（v1.47 起）：早先的写法把输入卡片当 `children` 收进来，
 * 代价是输入区那 330 多行 JSX 必须整段提到 `return` 之前才传得进来——只为换个挂点
 * 搬一次巨块不划算，且容易在搬运中走样。现在两块是**同一列里的上下相邻**：
 * 本组件管「上方提示」，`index.tsx` 的输入列管输入卡片，「一起居中」由外面那层
 * `justify-center` 负责。所以这里**不再有** `children`。
 */
import { Folder, FolderOpen, FolderPlus } from "lucide-react";
import { ICON } from "@/lib/icon";

/** 起手建议：点一下写进输入框（不发出去）——给「不知道从哪说起」的人一个台阶 */
const SUGGESTIONS = ["修复登录超时", "给 utils 补单测", "把日志换成 pino", "解释这段代码"];

export function StartPanel({
  cwd,
  onPickDirectory,
  onNewWorkspace,
  onSuggestion,
}: {
  cwd: string;
  /** 走原生选目录框换一个已有目录（换过去=换项目，见 App 的 pickProject） */
  onPickDirectory: () => void;
  /** 不用挑目录：让主进程在家目录下造一个空的（App 的 createWorkspace） */
  onNewWorkspace: () => void;
  onSuggestion: (text: string) => void;
}): React.JSX.Element {
  return (
    <div data-conv-start className="flex w-full flex-col items-center gap-2">
      <div className="text-2xs uppercase tracking-[1.5px] text-text-muted">
        Colt · 本地编码 Agent
      </div>
      <h2 className="m-0 mt-1.5 text-2xl font-semibold tracking-[-.4px] text-text-primary">
        今天要修哪个 bug？
      </h2>
      <p className="m-0 text-sm text-text-secondary">
        描述你想做的事，Colt 会先给你一份计划。
      </p>
      <div className="mt-4 flex max-w-[560px] flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSuggestion(suggestion)}
            className="rounded-sm border border-line px-3 py-1.5 text-xs text-text-secondary transition hover:border-line-strong hover:bg-surface-overlay hover:text-text-primary"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {/*
        工作目录：**只有还在起手区时才可换**。目录决定这条会话归哪个项目——落库的 project_id、
        JSONL 目录、worker 的 cwd 全按它，发完第一条消息就定死了（换目录等于换会话）。
        所以这个控件不放进 ⑤ 的工具行常驻：那里是「发这条消息的参数」，而它是「这条会话的归属」，
        平时看它就够了，要看的地方是 ② 会话头。
      */}
      <div className="mt-4 flex max-w-[560px] flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5 text-xs text-text-secondary">
        <span className="flex min-w-0 items-center gap-1.5" title="这条会话的工作目录">
          <Folder {...ICON.xs} className="shrink-0 text-text-muted" />
          <span data-conv-workdir className="truncate font-mono">
            {cwd}
          </span>
        </span>
        <button
          type="button"
          onClick={onPickDirectory}
          aria-label="换一个目录"
          title="换一个目录：选一个已存在的目录并切过去"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-line transition hover:border-line-strong hover:text-text-primary"
        >
          <FolderOpen {...ICON.sm} />
        </button>
        <button
          type="button"
          onClick={onNewWorkspace}
          data-conv-newdir
          aria-label="新建工作目录"
          title="不用自己挑：在家目录的 ~/.colt 下按时间建一个空目录并切过去"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-line transition hover:border-line-strong hover:text-text-primary"
        >
          <FolderPlus {...ICON.sm} />
        </button>
      </div>
    </div>
  );
}
