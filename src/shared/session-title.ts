// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 会话标题的**唯一派生规则**。
 *
 * 同一条规则原先写在两个进程里：`main/session-manager.ts` 在 view 到达时算一次落库，
 * `renderer/App.tsx` 在 `session.view` 监听里**再算一遍**更新侧栏缓存。两处都是
 * `firstUser?.text.slice(0, 30)`——改一处忘另一处，就是「界面标题与侧栏标题不一致」，
 * 而且不会报错、不会有测试变红（2026-10-11 架构评审 🟡6）。
 *
 * ## 为什么是「共享纯函数」而不是「挪进投影层」
 *
 * 评审的建议是「收在 worker `project()` 或主进程一处，渲染层只消费」。挪进投影层要动
 * `ConversationView` 契约（加字段），而渲染层本来就已经拿到 messages——为这一处派生
 * 扩大协议面不划算。共享一个纯函数就足够消除「两份实现漂开」这个真问题，两边仍是
 * 各自需要时现算，且**规则只有一份**。
 *
 * ## 语义
 *
 * - 取**首条 user 消息**，**截断**到 `SESSION_TITLE_MAX_CHARS` 个字符；
 * - 没有 user 消息、或结果为空 → `undefined`。这个「空 = 没有标题」的约定让两个调用方
 *   都能照原样处理「不设标题」：主进程的 `touchSession` 对假值 title 本就只更新时间戳
 *   与条数（不动 title 列），渲染层的 `?? item.title` 也保留旧值。
 *
 * ## 技能调用要**用它的展示写法**，不能直接取原文（2026-10-12 修）
 *
 * 「从 `/` 菜单选技能」是会话最常见的起手方式之一，而内核替用户发的技能调用消息，正文是
 * **原始标记**——`<skill name="pdf" location="/...">\nReferences are relative to ...`。
 * 直接 `text` 的话，侧栏与标题就会显示这一串 XML。这**不是标题规则该自己发明**的写法：
 * 会话目录（`renderer/lib/session-outline.ts`）与分支树（`worker/lib/project.ts`）早就
 * 统一用 `skillInvocationLabel` 显示成「技能 pdf · 额外指示」。三处显示同一条消息，
 * 就该是同一行字——与 `shared/skill-invocation.ts` 文件头那条理由完全一致。
 *
 * 顺带说明这是**行为变更**（原先技能调用会得到一串 XML 标题），不是纯提取：它值得单独
 * 记一笔，因为它改变了用户在侧栏看到的东西。
 */
import type { ViewMessage } from "./worker-protocol";
import { skillInvocationLabel } from "./skill-invocation";

/** 标题取多少个字符（改动它等于改变所有存量会话的标题，务必三思） */
export const SESSION_TITLE_MAX_CHARS = 30;

/**
 * 从消息列表派生会话标题；没有可用来源时返回 `undefined`（含义是「不要设标题」）。
 *
 * 入参只要求 `role` / `text` / `skill` 三个字段，故主进程的 `ViewMessage` 与渲染层手上的
 * 同一形状都能直接传进来（`ConversationView.messages`）。
 */
export function deriveSessionTitle(messages: readonly ViewMessage[]): string | undefined {
  const firstUser = messages.find((item) => item.role === "user");
  // 技能调用：用统一展示写法，别把内核的原始标记当标题（见文件头）
  const source =
    firstUser?.skill !== undefined
      ? skillInvocationLabel(firstUser.skill)
      : (firstUser?.text ?? "");
  const title = source.slice(0, SESSION_TITLE_MAX_CHARS);
  return title === "" ? undefined : title;
}
