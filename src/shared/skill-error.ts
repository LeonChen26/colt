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
 * ⚠️ 内核的技能调用失败**走 `Result.err` 而不是抛异常**：`UnknownSkill` / `LaneBusy` /
 * `Closed` / `InvalidMessage`。worker 侧必须显式检查返回值，否则这些失败全部静默——
 * 用户敲了 `/skill xxx` 只会「没反应」。
 *
 * 这些错误类不在本仓类型面里（worker 只拿到运行时对象），故按 `_tag`（TaggedError）判别，
 * 与内核 `agent-harness.d.ts` 里 `RunResult` 的错误联合对齐。
 */

/** 技能不存在的几种形态 → 给用户看的一句话（**带上可用的名字**，否则用户不知道该敲什么） */
export function unknownSkillMessage(name: string, available: readonly string[]): string {
  const head = `技能「${name}」不存在`;
  if (available.length === 0) {
    return `${head}：本会话没有装载任何技能。技能放在 <项目>/.agents/skills 或 ~/.agents/skills 下（新建会话时装载）。`;
  }
  return `${head}。可用：${available.join("、")}`;
}

/** 技能调用的失败 → 给用户看的一句话 */
export function describeSkillError(error: unknown): string {
  const tag = (error as { _tag?: string } | undefined)?._tag;
  switch (tag) {
    // 正常路径下走不到这里——worker 与渲染层都会先拿本会话装到的清单自己查一遍，
    // 好把可用名一起列出来（内核这个错误只带名字、不带候选）。这里**只说不存在**，
    // 不跟着断言「没装载任何技能」：那种情况下技能其实装着，只是名字不对，说错比少说更糟。
    case "UnknownSkill": {
      const name = (error as { name?: unknown }).name;
      return typeof name === "string" && name.length > 0 ? `技能「${name}」不存在。` : "技能不存在。";
    }
    case "LaneBusy":
      return "当前有正在进行的任务，无法调用技能：请等它结束，或先停止当前任务。";
    case "Closed":
      return "会话已关闭，无法调用技能。";
    case "InvalidMessage":
      return "技能的正文无法构成一条有效消息（技能文件内容异常）。";
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | undefined)?.message === "string"
        ? (error as { message: string }).message
        : String(error);
  return `调用技能失败：${message}`;
}
