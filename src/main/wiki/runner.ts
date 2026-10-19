// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * CodeWiki 生成任务的执行层（设计见 `docs/design-codewiki-integration-2026-10.md` §4 P3）。
 *
 * 为什么要有这一层，而不是让 agent 用 MCP 逐页写：
 * `write_doc_file` 的目标路径是模型参数，而审批只有「整个工具 / 同参数」两种范围，
 * 没有路径范围。逐页弹卡太吵，整工具放行又等于允许模型往工作区任意位置写 .md。
 * 这里把 `--output docs/wiki` **钉死在代码里**，用户只确认一次，路径由程序决定。
 *
 * 七条约束（与设计文档一一对应）：
 * 1. `spawn` 不经 shell，参数走数组；
 * 2. cwd = 项目根，env 白名单投影；
 * 3. 按行读 stdout/stderr，保留最后 400 行；
 * 4. 同一项目单飞；
 * 5. 取消杀进程树，保留半成品；
 * 6. 退出码 + 产物时间戳双判据；
 * 7. 生成前先做前置检查，缺件不启动。
 *
 * 这一层**不 import electron**，路径与运行时探测由 IPC 层传入，故可被单测直接覆盖。
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WikiGenerateEvent, WikiGenerateSnapshot } from "@shared/protocol";
import { WIKI_DIR, WIKI_LOG_MAX_LINES } from "@shared/wiki";

/** 环形日志上限：失败时展开看最后 400 行，足够定位；再长也不是给人读的 */
export const MAX_LOG_LINES = WIKI_LOG_MAX_LINES;

/** 进度合帧：rich 会一行一行刷，逐行推送会让 IPC 变成噪音 */
export const FLUSH_INTERVAL_MS = 150;

/**
 * 产物时间戳的宽限：Windows 的 mtime 精度、以及「启动后立刻写 metadata」都可能
 * 让写入时刻比 `startedAt` 早几毫秒。5 秒足够宽，又不会把旧产物误判成新产物。
 */
export const ARTIFACT_GRACE_MS = 5_000;

export type WikiGenerateMode = "full" | "update";

/**
 * CodeWiki 的参数。
 *
 * `--update` 只在已有产物时使用：它按组件做 diff，比全量便宜；全量仍然保留，
 * 因为「产物坏了 / 想从头再来」时用户需要一个不依赖旧状态的入口。
 */
export function wikiGenerateArgs(mode: WikiGenerateMode): string[] {
  return mode === "update"
    ? ["generate", "--update", "--output", WIKI_DIR]
    : ["generate", "--output", WIKI_DIR];
}

/**
 * 直接透传的宿主环境变量。
 *
 * 这是**白名单**，不是「把 process.env 删几个」：后者一旦漏掉一个密钥名就是静默泄露。
 * 与 `main/lib/worker-env.ts` 同一口径，只保留跑 Python / git / 网络所需的键。
 */
export const WIKI_ENV_PASSTHROUGH: readonly string[] = [
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * 生成任务的环境。
 *
 * 默认**不复制 Colt 的模型密钥**（设计 D4）：CodeWiki 用 `codewiki config set`
 * 自己保存凭据；这里只透传用户自己已经放在环境里的 `CODEWIKI_*`。
 * `PYTHONUNBUFFERED` / `PYTHONIOENCODING` 不能省：否则 Python 的输出会被缓冲，
 * 界面会长时间停在「生成中…」而看不到任何进度。
 */
export function buildWikiEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of WIKI_ENV_PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith("CODEWIKI_")) continue;
    if (value === undefined || value === "") continue;
    env[key] = value;
  }
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  env.COLUMNS = env.COLUMNS ?? "120";
  return env;
}

/** 去掉 rich / pip 常带的 ANSI 颜色序列（日志是给人读的，不是给终端读的） */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * 流式行缓冲：chunk 边界不保证落在换行上，直接把 chunk 当行会把一条日志劈成两条。
 * `\r` 也要当分隔符——rich 的进度条用 `\r` 回写同一行。
 */
export class WikiLineBuffer {
  #partial = "";

  push(chunk: string): string[] {
    const parts = (this.#partial + chunk).split(/\r\n|\r|\n/);
    this.#partial = parts.pop() ?? "";
    return parts.map((line) => stripAnsi(line).trimEnd()).filter((line) => line !== "");
  }

  flush(): string[] {
    const line = stripAnsi(this.#partial).trimEnd();
    this.#partial = "";
    return line === "" ? [] : [line];
  }
}

/** 环形追加：只留最近 `max` 行；日志是诊断材料，不是审计账本 */
export function appendLogLines(ring: string[], lines: readonly string[], max = MAX_LOG_LINES): void {
  for (const line of lines) {
    ring.push(line);
    if (ring.length > max) ring.splice(0, ring.length - max);
  }
}

/**
 * 成功判据之二：`docs/wiki/metadata.json` 是否在本次任务期间被写过。
 *
 * 只看退出码不够——CodeWiki 可能退出 0 但没写产物（权限、磁盘满、模型调用被跳过）。
 * 那种情况下界面说「生成成功」就是持续撒谎（`docs/ERRORS.md`）。
 */
export function wikiArtifactUpdated(root: string, startedAt: number): boolean {
  try {
    const stat = statSync(join(resolve(root), WIKI_DIR, "metadata.json"));
    return stat.mtimeMs >= startedAt - ARTIFACT_GRACE_MS;
  } catch {
    return false;
  }
}

/** 前置检查失败项（只保留真正挡住生成的那几项） */
export interface WikiProbeFailure {
  label: string;
  detail: string;
  hint: string | null;
}

/** 把缺件摆成「缺什么 + 下一步」，而不是一句笼统的「前置检查失败」 */
export function formatWikiProbeFailure(items: readonly WikiProbeFailure[]): string {
  if (items.length === 0) return "";
  return [
    "CodeWiki 生成前置检查未通过：",
    ...items.map(
      (item) => `· ${item.label}：${item.detail}${item.hint === null ? "" : `\n  ${item.hint}`}`,
    ),
  ].join("\n");
}

/** runner 只需要 child_process 的这几项；抽成接口是为了单测能注入假进程 */
export interface WikiChildProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface WikiSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: boolean;
  stdio: ["ignore", "pipe", "pipe"];
  detached: boolean;
}

export type WikiSpawn = (
  command: string,
  args: string[],
  options: WikiSpawnOptions,
) => WikiChildProcess;

/** 杀进程树：CodeWiki 会再拉 Python 子进程，只杀父进程会留下孤儿 */
export type WikiKillTree = (child: WikiChildProcess) => void;

const defaultSpawn: WikiSpawn = (command, args, options) =>
  spawn(command, args, options) as unknown as WikiChildProcess;

const defaultKillTree: WikiKillTree = (child) => {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    // taskkill 的 /T 才能带走整棵树；/F 是必须的——CodeWiki 的 Python 子进程不响应 Ctrl+C
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill();
    return;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 已经退出
    }
  }, 5_000);
  timer.unref?.();
};

interface ActiveRun {
  sessionId: string;
  root: string;
  startedAt: number;
  lines: string[];
  cancel: () => void;
}

const activeByRoot = new Map<string, ActiveRun>();
const startingRoots = new Set<string>();
const lastByRoot = new Map<string, WikiGenerateSnapshot>();

export interface StartWikiGenerationDeps {
  sessionId: string;
  root: string;
  mode: WikiGenerateMode;
  /** CodeWiki 可执行文件（venv 里的绝对路径，或 PATH 上的 `codewiki`） */
  command: string;
  /** 返回 null = 可以开始；返回字符串 = 缺件说明（直接展示给用户） */
  checkReady: () => Promise<string | null>;
  onEvent: (event: WikiGenerateEvent) => void;
  spawnImpl?: WikiSpawn;
  killTree?: WikiKillTree;
  now?: () => number;
  artifactUpdated?: (root: string, startedAt: number) => boolean;
}

/**
 * 启动一次生成。返回时**进程已经起来了**，真正的完成靠 `onEvent` 推。
 *
 * 同一项目单飞：第二次调用直接返回 `alreadyRunning: true`，不排队。
 * 生成是分钟级甚至小时级的任务，排队只会让用户以为「点了没反应」。
 */
export async function startWikiGeneration(
  deps: StartWikiGenerationDeps,
): Promise<{ started: boolean; alreadyRunning: boolean }> {
  const root = resolve(deps.root);
  if (activeByRoot.has(root) || startingRoots.has(root)) {
    return { started: false, alreadyRunning: true };
  }
  startingRoots.add(root);
  try {
    const readyError = await deps.checkReady();
    if (readyError !== null) throw new Error(readyError);

    const now = deps.now ?? Date.now;
    const spawnImpl = deps.spawnImpl ?? defaultSpawn;
    const killTree = deps.killTree ?? defaultKillTree;
    const artifactUpdated = deps.artifactUpdated ?? wikiArtifactUpdated;
    const startedAt = now();
    const lines: string[] = [];
    let pending: string[] = [];
    let finished = false;
    let cancelled = false;

    const emit = (phase: WikiGenerateEvent["phase"], error: string | null, finishedAt: number | null) => {
      const chunk = pending;
      pending = [];
      deps.onEvent({
        sessionId: deps.sessionId,
        phase,
        lines: chunk,
        error,
        startedAt,
        finishedAt,
      });
    };

    let child: WikiChildProcess;
    try {
      child = spawnImpl(deps.command, wikiGenerateArgs(deps.mode), {
        cwd: root,
        env: buildWikiEnv(process.env),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // POSIX 上开进程组，取消时才能一次带走 Python 子进程；Windows 靠 taskkill /T
        detached: process.platform !== "win32",
      });
    } catch (error) {
      startingRoots.delete(root);
      throw new Error(`无法启动 CodeWiki：${error instanceof Error ? error.message : String(error)}`);
    }

    const buffer = new WikiLineBuffer();
    const take = (chunk: string): void => {
      const next = buffer.push(chunk);
      if (next.length === 0) return;
      appendLogLines(lines, next);
      pending.push(...next);
      // 待推送的那一帧也守同一个上限：否则一次长跑的首帧会把整份日志整段推过去
      if (pending.length > MAX_LOG_LINES) pending.splice(0, pending.length - MAX_LOG_LINES);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => take(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => take(String(chunk)));

    const flushTimer = setInterval(() => {
      if (pending.length > 0) emit("running", null, null);
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();

    const finish = (phase: "done" | "failed" | "cancelled", error: string | null): void => {
      if (finished) return;
      finished = true;
      clearInterval(flushTimer);
      const tail = buffer.flush();
      if (tail.length > 0) {
        appendLogLines(lines, tail);
        pending.push(...tail);
        if (pending.length > MAX_LOG_LINES) pending.splice(0, pending.length - MAX_LOG_LINES);
      }
      const finishedAt = now();
      emit(phase, error, finishedAt);
      lastByRoot.set(root, {
        sessionId: deps.sessionId,
        phase,
        lines: [...lines],
        error,
        startedAt,
        finishedAt,
      });
      activeByRoot.delete(root);
    };

    child.on("error", (error) => {
      finish("failed", `无法启动 CodeWiki：${error.message}`);
    });
    child.on("close", (code, signal) => {
      if (cancelled) {
        finish("cancelled", null);
        return;
      }
      if (code !== 0) {
        finish(
          "failed",
          `CodeWiki 退出码 ${code === null ? "未知" : code}${signal === null ? "" : `（${signal}）`}；见上方日志。`,
        );
        return;
      }
      if (!artifactUpdated(root, startedAt)) {
        finish(
          "failed",
          "CodeWiki 退出码 0，但 docs/wiki/metadata.json 没有更新——不能算生成成功（见上方日志）。",
        );
        return;
      }
      finish("done", null);
    });

    const run: ActiveRun = {
      sessionId: deps.sessionId,
      root,
      startedAt,
      lines,
      cancel: () => {
        if (finished || cancelled) return;
        cancelled = true;
        killTree(child);
      },
    };
    activeByRoot.set(root, run);
    startingRoots.delete(root);

    // 先推一帧「已启动」：CodeWiki 可能要几十秒才有第一行输出，
    // 没有这一帧界面会停在「点了没反应」。
    emit("running", null, null);
    return { started: true, alreadyRunning: false };
  } finally {
    startingRoots.delete(root);
  }
}

/** 取消某会话发起的任务；返回是否真的找到了一个在跑的任务 */
export function cancelWikiGeneration(sessionId: string): boolean {
  for (const run of activeByRoot.values()) {
    if (run.sessionId !== sessionId) continue;
    run.cancel();
    return true;
  }
  return false;
}

/** 面板重挂载时把进度接回来：在跑就给活动快照，跑完给最后一份 */
export function readWikiGeneration(root: string): WikiGenerateSnapshot | null {
  const rootAbs = resolve(root);
  const active = activeByRoot.get(rootAbs);
  if (active !== undefined) {
    return {
      sessionId: active.sessionId,
      phase: "running",
      lines: [...active.lines],
      error: null,
      startedAt: active.startedAt,
      finishedAt: null,
    };
  }
  return lastByRoot.get(rootAbs) ?? null;
}

/** 退出时尽力收掉所有生成进程（Windows 上 taskkill 是异步的，只能尽力而为） */
export function cancelAllWikiGenerations(): void {
  for (const run of activeByRoot.values()) run.cancel();
}
