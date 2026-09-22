// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 提问卡片的答案拼装（`ask_user` 的作答载荷）。
 *
 * 抽成纯函数是因为它是这条链路里唯一**可单测**的一环：答案的键与形态
 * （`Record<问题原文, 字符串>`）直接决定模型读到什么，错了是**静默的**——
 * 界面看着答上了，模型收到空串或对不上（见 `worker/lib/ask-user-tool.ts` 的 `formatAnswers`）。
 */

/** 多选、以及「选项 + 自填」都用它相连；与 worker 侧给模型看的口径一致（本模块内部使用） */
const MULTI_SEPARATOR = "、";

/**
 * 一道题的答案 = 选中项 + 自填文字，用「、」相连。
 *
 * 三条规则，都有理由：
 * - **自填可以独立作答**（一个选项都没选也算答了）——选项是模型的建议，不是必须接受的封闭集
 * - **选中项在前、自填在后**：模型按顺序读，先看到结构化选择、再看到补充说明
 * - **去重**：既选了「A」又打了「A」时不该回传「A、A」——模型会当成两个东西
 *
 * 空串表示这题没答（不是「答了空」），由 `isAnswered` 判定。
 */
export function composeAnswer(picked: readonly string[], text: string): string {
  const parts: string[] = [];
  for (const item of picked) {
    const label = item.trim();
    if (label !== "" && !parts.includes(label)) parts.push(label);
  }
  const typed = text.trim();
  if (typed !== "" && !parts.includes(typed)) parts.push(typed);
  return parts.join(MULTI_SEPARATOR);
}

/** 这题算不算答过：既没选也没打（或只有空白）就是没答 */
export function isAnswered(answer: string): boolean {
  return answer.trim() !== "";
}
