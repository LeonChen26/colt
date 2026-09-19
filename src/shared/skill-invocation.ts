// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能调用的**展示写法**。
 *
 * 为什么单独一份：同一个技能调用要在两处显示成一行字——② 会话目录的标签、③ 分支树的摘要。
 * 两处各自写一遍格式串，迟早会漂移成「目录写『技能 pdf』、树里写别的」；这类不一致没有
 * 人会报 bug，只会让人以为看到的是两件事。所以**格式只有一份**，调用方只负责截断。
 *
 * 判据在 `ViewMessage.skill`（worker 投影时用 `parseSkillInvocation` 认出来的），
 * 不是在这里现认字符串。
 */
import type { ViewSkillInvocation } from "./worker-protocol";

/**
 * 一行里怎么称呼这次技能调用。
 *
 * 带上额外指示：用户敲 `/skill <名字> 只改这一处` 时，「只改这一处」才是这一轮的意图，
 * 光有技能名会让人分不清「我那次到底让它干什么」。
 */
export function skillInvocationLabel(invocation: ViewSkillInvocation): string {
  return invocation.instructions === undefined
    ? `技能 ${invocation.name}`
    : `技能 ${invocation.name} · ${invocation.instructions}`;
}
