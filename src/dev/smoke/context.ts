// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟装置的共享件：各模式（`modes/`）都要用的类型与小工具。
 *
 * 之所以单独成文件而不是留在 `index.ts`：模式跑在**主进程里**，而 `index.ts` 里的
 * `runSmoke` 负责建 `log` / `run` 这两个闭包——模式若从 `index.ts` 反向取用就会成环。
 * 把「双方都要用的东西」下沉到第三处，依赖方向才是单向的。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { app, nativeImage } from "electron";
import { deleteProject, listProjects, listSessions } from "../../main/db/repo";
import { sessionManager } from "../../main/session-manager";

/** 落盘 + 控制台双写的一行日志（由 runSmoke 建立，透传给各模式） */
export type Log = (message: string) => void;

/** 带兜底超时的 executeJavaScript（同上，由 runSmoke 建立） */
export type Run = <T>(expression: string) => Promise<T>;

/**
 * 把「用户级配置家目录」这条环境前提**显式固定**成一个空目录（设 `COLT_MCP_HOME`）。
 *
 * 挂在它下面、且**都**对全部项目生效的有两族配置，两族都得清：
 * - `<home>/.colt/mcp.json`——MCP server 清单（`docs/DESIGN-mcp.md`）；
 * - `<home>/.agents/skills` 与 `<home>/.colt/skills.json`——用户级技能（`docs/SECURITY.md`）。
 *
 * 本机若配过一台 server、或装过一个技能，冒烟里那些「只有 N 台 / 只有这几个技能」的精确断言
 * 就会随机器而变（假红）。真实跑 MCP / 技能的冒烟都先调它，前提才是**自己建立**的，而不是
 * 「碰巧这台机器上没配」（`AGENTS.md` §五⑬）。
 *
 * 做法是**整个 home 先删后建**，不是只清 `.colt`：用户级技能的目录是 `.agents`，只清前者会
 * 漏掉它——那正是「同一类前提写了两遍、漏了一段」的形态（技能冒烟就踩在这一段上）。
 */
export function isolateUserHome(name: string, log?: Log): string {
  const home = join(process.cwd(), "out", `smoke-${name}-home`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  process.env.COLT_MCP_HOME = home;
  log?.(`用户级配置家目录（MCP 配置 + 用户级技能，整体清空重建）：${home}`);
  return home;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 主进程里未捕获的异常。
 *
 * 有些错误是在用例之外异步抛出的（典型如窗口 closed 回调访问了已销毁的 webContents）：
 * 它不打断用例，总要等到用例记完结论之后才冒出来，把「21/21 通过」变成假绿。
 * 所以这里显式收口，由用例正文断言其为空。
 */
export const uncaughtErrors: string[] = [];

/**
 * 本次冒烟**归一化后**的产物路径（由调用方 launcher 算好，恒在 out/ 下）。
 * 用例内部需要派生伴生产物（如「待审截图」）时读它，而不是再读 COLT_SMOKE ——
 * 否则派生文件会绕过归一化，重新落回仓库根目录。
 */
// 导出的是**可变绑定**：`runSmoke` 用 setActiveOutputPath 改写后，各模式 import 进来
// 读到的就是新值（ESM 的 live binding），不需要模式侧再改写法。
export let activeOutputPath = "";

export function setActiveOutputPath(value: string): void {
  activeOutputPath = value;
}

/**
 * 生成纯红色 PNG（base64，不含 data URI 前缀）。
 * 用于验证「用户发图 → 模型看图」：颜色是确定的，模型答对即证明图片真的送达了。
 */
export function makeSolidPng(size: number): string {
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    pixels[i * 4] = 0; // B
    pixels[i * 4 + 1] = 0; // G
    pixels[i * 4 + 2] = 255; // R
    pixels[i * 4 + 3] = 255; // A
  }
  return nativeImage
    .createFromBitmap(pixels, { width: size, height: size })
    .toPNG()
    .toString("base64");
}

/** 打印一次会话视图（消息 / 工具调用 / 文件改动 / 用量），多个模式共用 */
export async function report(
  sessionId: string,
  log: Log,
  run: Run,
): Promise<void> {
  const view = await run<{
    messages: { role: string; text: string; toolCalls: { name: string; args: string }[] }[];
    fileChanges: { path: string; kind: string; addedLines: number; removedLines: number; patch: string | null }[];
    stats: { totalTokens: number; costUsd: number };
    running: boolean;
  } | null>(`window.colt.invoke("session.view", ${JSON.stringify({ sessionId })})`);

  if (!view) {
    log("未取得会话视图");
    return;
  }

  log(`消息数：${view.messages.length}，运行中：${view.running}`);
  for (const message of view.messages) {
    const calls = message.toolCalls.map((call) => `${call.name}(${call.args})`).join(" ");
    log(`  [${message.role}] ${message.text.slice(0, 100)}${calls ? ` → ${calls.slice(0, 120)}` : ""}`);
  }
  log(`文件改动：${view.fileChanges.length} 项`);
  for (const change of view.fileChanges) {
    log(`  ${change.kind} ${change.path} +${change.addedLines} -${change.removedLines} patch=${change.patch ? "有" : "无"}`);
  }
  log(`用量：${view.stats.totalTokens} tokens / $${view.stats.costUsd}`);
}

/**
 * 读一个 `.jsonl` 文件头里的内核会话 id。首行形如
 * `{"v":4,"kind":"header","id":"01a0b539-…"}`，那个 `id` 与文件名 `时间戳_<id>.jsonl` 的后缀一致。
 *
 * 只读前 4KB（头行实测约 1KB）：读不出、不是 JSON、或没有 `id` 一律返回 `null`——
 * 调用方据此**留着不删**，宁可漏清也绝不误删真实会话的历史。
 */
function readHeaderKernelId(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0]?.trim();
    if (!line) return null;
    const parsed = JSON.parse(line) as { kind?: unknown; id?: unknown };
    return parsed.kind === "header" && typeof parsed.id === "string" && parsed.id.length > 0
      ? parsed.id
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉不影响判断
      }
    }
  }
}

/**
 * 扫掉 `userData/sessions` 下**库里已没有对应会话**的 `.jsonl` 历史文件，返回删掉的路径。
 *
 * 为什么需要它：内核按「转义 cwd 目录 + `时间戳_kernelId.jsonl`」落盘，而这些名字**只有内核知道**
 * （`ipc/index.ts#removeSessionJsonl` 也只能靠「文件名含 kernelSessionId」去反查）。于是凡是用例
 * 起了个**没落过库**的会话（`[model/during-init]` 的合成 id），或删了库里的行却没带走文件
 * （`runSessionDraft` 直接调 `deleteSession`），产物就留在盘上、够不到、越跑越多——
 * 2026-09-22 清出的那批孤儿（35 个 / 87KB）正是这么来的。
 *
 * 判据取**文件头里的 id 在不在 `sessions.kernel_session_id` 里**：在 → 留着；不在 → 无主，删。
 * 这样不会误伤任何真实会话，也不靠 mtime 猜（`AGENTS.md` §五⑫：别按层级/时间来猜归属）。
 */
export function removeOrphanSessionJsonl(log?: Log): string[] {
  const removed: string[] = [];
  const root = join(app.getPath("userData"), "sessions");
  if (!existsSync(root)) return removed;
  const known = new Set(
    listSessions()
      .map((session) => session.kernelSessionId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      const kernelId = readHeaderKernelId(full);
      if (kernelId === null || known.has(kernelId)) continue;
      try {
        rmSync(full, { force: true });
        removed.push(full);
      } catch {
        // 句柄未释放（worker 刚关）等情况跳过，不阻断收尾
      }
    }
  }
  if (removed.length > 0) {
    log?.(`清掉无主 JSONL 历史 ${removed.length} 个：${removed.map((file) => basename(file)).join(", ")}`);
  }
  return removed;
}

/**
 * 判一个项目根目录是不是「一次性夹具」。
 *
 * 安全性质是关键：**仓库外的项目一律不碰**（用户的真实项目不可能落在本仓库里）；仓库内也只认
 * 两种——`out/` 下（冒烟产物目录），或目录名以 `.smoke` / `smoke-` 开头。本仓库根自身
 * （`relative` 算出来是空串）不算，那是开发者在用的真实项目。
 *
 * 方向上的取舍：读不准时**当成不是夹具**（不删）。宁可漏清几个，也别误删真实项目。
 */
function isThrowawayFixture(rootPath: string, repoRoot: string): boolean {
  const resolved = resolve(rootPath);
  const relativePath = relative(repoRoot, resolved);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
  const name = basename(resolved);
  return relativePath.startsWith(`out${sep}`) || name.startsWith(".smoke") || name.startsWith("smoke-");
}

/**
 * 收尾：注销这次运行用例建过的**一次性夹具项目**，连同它们的会话与落盘历史。返回注销掉的项目描述。
 *
 * 为什么放在 harness 收尾、而不是各 mode 自己清：各 mode 一律 `upsertProject(夹具目录)` +
 * `createSession(...)`，跑完**谁都不注销**——`out/smoke-*` 这些项目于是在库里越攒越多会话
 * （2026-09-22 实测：`smoke-subagent-e2e-fixture` 23 条、`smoke-skills-fixture` 9 条、
 * `smoke-mcp-e2e-fixture` 6 条、`smoke-mcp-filesystem` 2 条、`smoke-mcp-{reload-fixture,real,pi-lens}`
 * 各 1 条）。逐 mode 去补**一定会漏**（`AGENTS.md` §五⑬ 的教训），所以在收尾按「夹具的定义」
 * 一次清掉，**以后新增的 mode 自动被覆盖**。
 *
 * 删掉不影响任何用例：夹具项目是按 `root_key` upsert 的，下次跑到会重新登记（只是 id 会换一个）。
 * 删之前先把它们的 worker 关掉——否则会话行没了、worker 还在写，反而又造出孤儿。
 */
export async function removeFixtureProjects(log?: Log): Promise<string[]> {
  const repoRoot = resolve(process.cwd());
  const doomed = listProjects().filter((project) => isThrowawayFixture(project.rootPath, repoRoot));
  const removed: string[] = [];
  for (const project of doomed) {
    for (const session of listSessions(project.id)) sessionManager.close(session.id);
    const deleted = deleteProject(project.id);
    if (deleted) removed.push(`${project.rootPath}（${deleted.length} 条会话）`);
  }
  // 等 worker 句柄释放，再扫它们留下的历史文件（同 `removeOrphanSessionJsonl` 的说明）
  await sleep(300);
  removeOrphanSessionJsonl(log);
  removeEmptySessionDirs(log);
  if (removed.length > 0) log?.(`注销一次性夹具项目 ${removed.length} 个：${removed.join("；")}`);
  return removed;
}

/**
 * 扫掉 `userData/sessions` 下的**空目录**——历史被清掉后剩下的空壳。
 *
 * 判据只有一个：目录里**一个条目都没有**。没有内容就没有可丢的东西，内核下次要用会自己重建。
 * 用 `rmdirSync` 而不是 `rmSync`：它对非空目录会直接失败，等于多一道「绝不误删有内容的目录」的保险。
 * 只扫一层（内核按「转义 cwd / 项目 id」建顶层目录，实测不再往里嵌套）。
 */
function removeEmptySessionDirs(log?: Log): string[] {
  const root = join(app.getPath("userData"), "sessions");
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      if (readdirSync(dir).length > 0) continue;
      rmdirSync(dir);
      removed.push(entry.name);
    } catch {
      // 占用 / 权限问题跳过，不阻断收尾
    }
  }
  if (removed.length > 0) log?.(`清掉空会话目录 ${removed.length} 个：${removed.join(", ")}`);
  return removed;
}
