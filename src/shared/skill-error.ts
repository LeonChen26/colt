// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能相关失败原因的文案（worker 与渲染层**共用**）。
 *
 * 为什么放在 `shared`：同一个「名字打错」有两条到达用户的路径——渲染层拿着本会话的技能清单，
 * 可以**就地拦下**（好处是输入还留着，用户改一个字母就能重敲）；worker 那条是**兜底**
 * （渲染层不知道清单时、或有人直接调 IPC）。两条路径必须说**同一句话**，
 * 否则同一个错误会因为入口不同给用户两种说法。
 *
 * 切到 pi-durable 后，技能的投递由应用直接 `conversation.submit`，不再有内核
 * `Result.err` 那一层；于是这里只剩「自查」用的两句文案。
 */

/** 技能不存在的几种形态 → 给用户看的一句话（**带上可用的名字**，否则用户不知道该敲什么） */
export function unknownSkillMessage(name: string, available: readonly string[]): string {
  const head = `技能「${name}」不存在`;
  if (available.length === 0) {
    return `${head}：本会话没有装载任何技能。技能放在 <项目>/.agents/skills 或 ~/.agents/skills 下（新建会话时装载）。`;
  }
  return `${head}。可用：${available.join("、")}`;
}

/**
 * 技能**被使用者禁用** → 给用户看的一句话。
 *
 * 与「不存在」**必须分开说**：名字打错时用户要改拼写，而这个名字恰恰是他自己刚关掉的——
 * 说成「不存在」会让他去翻拼写、越找越远。两条路径（渲染层就地拦 / worker 兜底）共用它，
 * 理由同 `unknownSkillMessage`。
 */
export function disabledSkillMessage(name: string): string {
  return `技能「${name}」已被你在设置里禁用（设置 → 技能 可重新启用）。`;
}
