// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「这个路径是不是一个技能的 `SKILL.md`」——即 `<...>/.agents/skills/<名字>/SKILL.md`。
 *
 * 两处用它，理由不同、但都只需要**看形状**：
 * - `main/ipc` 的 `skills.reveal`：只为在文件管理器里揭开一次目录，不值得再走一个 IPC 往返
 *   「问 worker 这个路径对不对」；而它最终只调 `shell.showItemInFolder`（不读内容、不写盘），
 *   把形状钉死，危害上界就定住了；
 * - `main/approval` 的审批摘要：写入技能文件**不是普通写文件**——它的正文会进系统提示词、
 *   改变模型行为（见 `docs/SECURITY.md` §技能），审批卡上要标出这件事。
 *
 * 用 `basename` / `dirname` **逐段比**，而不是拿字符串前缀去碰：后者会被 Windows 的分隔符坑到
 * （ `E:\a\b` 与 `E:/a/b` 是同一个文件，前缀却不等）。逐段比就只剩下比较 `skills` / `.agents` /
 * `SKILL.md` 这三个段，与分隔符无关。刻意**只认** `.agents/skills`——那是 agentskills.io 约定、
 * 也是本产品**磁盘上可写**的两个装载位置（第三层「内置」随包分发、在 app.asar 里，既没有可
 * 定位的位置、也不该被调用方指着走，故这里不认它；见 `worker/lib/skills.ts` 的 `skillDirSources`）。
 */
import { basename, dirname } from "node:path";

export function isSkillFilePath(filePath: string): boolean {
  if (basename(filePath) !== "SKILL.md") return false;
  const skillsDir = dirname(dirname(filePath)); // `<...>/.agents/skills`
  return basename(skillsDir) === "skills" && basename(dirname(skillsDir)) === ".agents";
}
