// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 可选安装项的**安装 / 卸载**执行层。
 *
 * 五条约束（都来自 `docs/design-codewiki-integration-2026-10.md` §4 P1 / §5 D7、D9）：
 *
 * 1. **不碰用户已有的东西**。运行时装在 `<userData>/runtimes/<id>`（Colt 自己的目录），
 *    配置只往 `~/.colt/mcp.json` 里加/删**同名那一条**（见 `user-config.ts`）。
 * 2. **装之前先探测**。缺 Python / 版本不对时不启动安装，直接把「缺什么 + 一条命令」摆出来
 *    ——装到一半失败的信息量远低于装之前就拦住。
 * 3. **每个大步骤都推进度**。`pip install` 可能是几分钟，界面不能一直显示「安装中…」，
 *    用户会以为卡死；失败时也要能指出**哪一步**红。
 * 4. **装完要复检**。装完不复检等于相信 pip 的退出码——而「装上了但版本不对」正是这个
 *    条目最容易出的事（`mcp` 被别的包拉高到 2.x）。
 * 5. **卸载分两档**：「只删配置」保留运行时（重装秒回）/「连运行时一起清」。默认前者。
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpInstallResult, McpInstallStep, McpPreset } from "@shared/mcp-catalog";
import { createSpawnRunner, probeCodewiki, type ProbeResult, type Runner } from "./probe";
import { removeUserServer, upsertUserServer } from "./user-config";

/** venv / pip 这类步骤的时限：分钟级（首次装 codewiki 要下几十 MB） */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** 运行时目录：放在 Colt 自己的 userData 下，不混进用户的 Python 环境 */
export function presetRuntimeDir(userDataDir: string, presetId: string): string {
  return join(userDataDir, "runtimes", presetId);
}

/** venv 里的 Python（Windows 在 Scripts/，其余在 bin/） */
export function venvPython(runtimeDir: string): string {
  return process.platform === "win32"
    ? join(runtimeDir, "Scripts", "python.exe")
    : join(runtimeDir, "bin", "python");
}

/** venv 里的 console script（`codewiki mcp` 的入口；装进 MCP 配置的就是它） */
export function venvBinary(runtimeDir: string, name: string): string {
  return process.platform === "win32"
    ? join(runtimeDir, "Scripts", `${name}.exe`)
    : join(runtimeDir, "bin", name);
}

/** 运行时是否还在（配置里有声明、目录却被删了——这时要能说清是「缺运行时」而不是「装好了」） */
export async function runtimeExists(runtimeDir: string): Promise<boolean> {
  try {
    return (await stat(venvPython(runtimeDir))).isFile();
  } catch {
    return false;
  }
}

export interface InstallDeps {
  preset: McpPreset;
  /** 用户家目录（写 `~/.colt/mcp.json`；单测传临时目录） */
  home: string;
  runtimeDir: string;
  /** 进度回调：每步**开始**与**结束**都调一次，界面无需自己拼状态机 */
  onProgress?: (step: McpInstallStep) => void;
  /** 执行器（单测注入假实现；默认真 spawn，时限按安装级放宽） */
  run?: Runner;
  /**
   * 四连检（默认 `probeCodewiki`）。做成可注入的，是因为单测不该依赖**跑测试的这台机器**
   * 上有没有 Python——那样这条用例的结论会随开发者的环境漂移（`AGENTS.md` §五⑬）。
   */
  probe?: () => Promise<ProbeResult>;
}

/** 一步的生命周期：先 running 再 ok/failed，两条都推给界面 */
async function track(
  deps: InstallDeps,
  step: McpInstallStep,
  body: () => Promise<{ state: "ok" | "failed" | "skipped"; detail: string | null }>,
): Promise<McpInstallStep> {
  deps.onProgress?.({ ...step, state: "running", detail: null });
  const result = await body();
  const done: McpInstallStep = { ...step, state: result.state, detail: result.detail };
  deps.onProgress?.(done);
  return done;
}

/** 输出太长时只留尾巴：pip 的真话在最后几行，前面全是下载进度条 */
function tail(text: string, lines = 6): string {
  const all = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return all.slice(-lines).join("\n");
}

/**
 * 安装一个目录项：建 venv → pip 装钉住的版本 → 复检 → 写用户级配置。
 *
 * 注意顺序上的一个取舍：**配置最后写**。理由是前四步任何一步失败，`~/.colt/mcp.json`
 * 里都不该留下一条指向半成品 venv 的声明——那会让用户下次打开设置页看到「已安装」，
 * 一开会话却连不上，还得自己回头找原因。
 */
export async function installPreset(deps: InstallDeps): Promise<McpInstallResult> {
  // **单飞**：同一个运行时目录上同时只能有一次安装。界面已经用「处理中…」挡了一次点击，
  // 但 IPC 没有防重放——两次 `python -m venv` 撞同一个目录会把运行时建坏，
  // 而用户看到的是「装好了」（第二次跑完后建的文件可能是残缺的）。第二次直接复用第一次的
  // Promise，拿到的是同一个结论（同 `mcp-tools` 里热重载互斥的理由）。
  const key = `install:${deps.runtimeDir}`;
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const task = runInstall(deps).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/** 正在进行的安装 / 卸载（键 = 动作 + 运行时目录） */
const inFlight = new Map<string, Promise<McpInstallResult>>();

async function runInstall(deps: InstallDeps): Promise<McpInstallResult> {
  const run = deps.run ?? createSpawnRunner(INSTALL_TIMEOUT_MS);
  const steps: McpInstallStep[] = [];
  const push = async (
    step: McpInstallStep,
    body: () => Promise<{ state: "ok" | "failed" | "skipped"; detail: string | null }>,
  ): Promise<McpInstallStep> => {
    const done = await track(deps, step, body);
    steps.push(done);
    return done;
  };

  // ① 探测：缺什么就停在这，别开始装。**只探一次**，后面建 venv 直接用这里选中的解释器
  //    （再探一次不仅慢，还可能因为 PATH 变动选中另一个 Python，导致「检查的是 A、装的是 B」）。
  const probe = await (deps.probe ?? probeCodewiki)();
  const python = probe.python;
  const gate = await push(
    { id: "probe", label: "检查 Python 与 git", state: "running", detail: null },
    async () => {
      if (python === null) {
        const hint = probe.items.find((item) => item.id === "python")?.hint ?? "先装 Python 3.12+";
        return { state: "failed", detail: hint };
      }
      return { state: "ok", detail: `${python.command} ${python.version}` };
    },
  );
  if (gate.state === "failed" || python === null) {
    return { ok: false, steps, error: "前置条件不满足（见上）" };
  }

  // ② venv
  const venv = await push(
    { id: "venv", label: "建独立运行时（venv）", state: "running", detail: null },
    async () => {
      const result = await run(python.command, [...python.args, "-m", "venv", deps.runtimeDir]);
      if (!result.ok) {
        return {
          state: "failed",
          detail: `${result.error ?? `退出码 ${String(result.code)}`}\n${tail(result.stderr)}`.trim(),
        };
      }
      return { state: "ok", detail: deps.runtimeDir };
    },
  );
  if (venv.state === "failed") {
    return { ok: false, steps, error: "建运行时失败（见上）" };
  }

  // ③ pip install（钉版本，两条一起装：分开装会被依赖解析拉成不兼容的组合）
  const requirements = deps.preset.requirements;
  const pip = await push(
    { id: "pip", label: `安装 ${requirements.join(" ")}`, state: "running", detail: null },
    async () => {
      const result = await run(venvPython(deps.runtimeDir), [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        ...requirements,
      ]);
      if (!result.ok) {
        return {
          state: "failed",
          detail: `${result.error ?? `退出码 ${String(result.code)}`}\n${tail(result.stderr)}`.trim(),
        };
      }
      return { state: "ok", detail: tail(result.stdout, 3) };
    },
  );
  if (pip.state === "failed") {
    return { ok: false, steps, error: "pip 安装失败（见上）" };
  }

  // ④ 复检：以**venv 里那个解释器**读到的版本为准，不看 pip 的脸色
  const verify = await push(
    { id: "verify", label: "复检版本", state: "running", detail: null },
    async () => {
      const result = await run(venvPython(deps.runtimeDir), [
        "-c",
        'import codewiki, mcp; print(codewiki.__version__); print(mcp.__version__)',
      ]);
      if (!result.ok) {
        return {
          state: "failed",
          detail: `复检跑不起来：${tail(result.stderr, 3) || (result.error ?? "")}`.trim(),
        };
      }
      const versions = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");
      const codewikiVersion = versions[0] ?? "";
      const mcpVersion = versions[1] ?? "";
      if (!codewikiVersion.startsWith("2.0.0")) {
        return { state: "failed", detail: `codewiki 装成了 ${codewikiVersion || "未知版本"}，要求 2.0.0` };
      }
      const major = Number(mcpVersion.split(".")[0]);
      if (!(major < 2)) {
        return { state: "failed", detail: `mcp 装成了 ${mcpVersion || "未知版本"}，要求 < 2` };
      }
      return { state: "ok", detail: `codewiki ${codewikiVersion} / mcp ${mcpVersion}` };
    },
  );
  if (verify.state === "failed") {
    return { ok: false, steps, error: "装完版本不对（见上）" };
  }

  // ⑤ 写用户级配置：只加我们这一条
  const config = await push(
    { id: "config", label: "写入用户级 MCP 配置", state: "running", detail: null },
    async () => {
      try {
        const written = await upsertUserServer(deps.home, deps.preset.serverName, {
          command: venvBinary(deps.runtimeDir, deps.preset.id),
          args: deps.preset.serverArgs,
        });
        return { state: "ok", detail: `${written.path}（现有 ${written.servers.length} 条）` };
      } catch (error) {
        return { state: "failed", detail: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  if (config.state === "failed") {
    return { ok: false, steps, error: "写配置失败（见上）" };
  }

  return { ok: true, steps, error: null };
}

export interface UninstallDeps {
  preset: McpPreset;
  home: string;
  runtimeDir: string;
  /** true = 连运行时一起清（默认 false：只删配置，重装秒回） */
  removeRuntime?: boolean;
  onProgress?: (step: McpInstallStep) => void;
}

/**
 * 卸载一个目录项：先删配置，再（可选）删运行时。
 *
 * 顺序反过来会有个坏中间态：运行时删了、配置还在 → 用户一开会话就看到一个连不上的
 * server（而且他还以为自己已经卸掉了）。先删配置，最坏也只是留下一个占空间的目录。
 */
export async function uninstallPreset(deps: UninstallDeps): Promise<McpInstallResult> {
  const key = `uninstall:${deps.runtimeDir}`;
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const task = runUninstall(deps).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function runUninstall(deps: UninstallDeps): Promise<McpInstallResult> {
  const steps: McpInstallStep[] = [];
  const push = async (
    step: McpInstallStep,
    body: () => Promise<{ state: "ok" | "failed" | "skipped"; detail: string | null }>,
  ): Promise<McpInstallStep> => {
    const done = await track({ ...deps, onProgress: deps.onProgress }, step, body);
    steps.push(done);
    return done;
  };

  const config = await push(
    { id: "config", label: "从用户级配置里移除", state: "running", detail: null },
    async () => {
      try {
        const result = await removeUserServer(deps.home, deps.preset.serverName);
        return result.removed
          ? { state: "ok" as const, detail: result.path }
          : { state: "skipped" as const, detail: `${result.path} 里本来就没有 ${deps.preset.serverName}` };
      } catch (error) {
        return { state: "failed" as const, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  if (config.state === "failed") {
    return { ok: false, steps, error: "移除配置失败（见上）" };
  }

  const runtime = await push(
    {
      id: "runtime",
      label: deps.removeRuntime === true ? "清掉运行时" : "保留运行时",
      state: "running",
      detail: null,
    },
    async () => {
      if (deps.removeRuntime !== true) {
        return { state: "skipped" as const, detail: deps.runtimeDir };
      }
      try {
        await rm(deps.runtimeDir, { recursive: true, force: true });
        return { state: "ok" as const, detail: deps.runtimeDir };
      } catch (error) {
        return { state: "failed" as const, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  );
  if (runtime.state === "failed") {
    return { ok: false, steps, error: "配置已移除，但运行时没删掉（见上）" };
  }

  return { ok: true, steps, error: null };
}
