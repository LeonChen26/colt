/**
 * Windows 环境体检：复刻内核 harness/env/nodejs.ts 的 bash 查找顺序
 * 顺序：自定义路径 → %ProgramFiles%\Git\bin\bash.exe → %ProgramFiles(x86)% → PATH
 */
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { EnvReport } from "@shared/protocol";

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 中查找 bash，跳过 WindowsApps 下的 WSL stub */
async function findBashOnPath(): Promise<string | undefined> {
  const rawPath = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? ["bash.exe"] : ["bash"];
  for (const dir of rawPath.split(delimiter)) {
    if (!dir) continue;
    // WindowsApps 下的 bash.exe 是 WSL 跳板，不是真正的 bash
    if (/WindowsApps/i.test(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, ext);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** 解析 bash 路径，返回路径与来源 */
export async function resolveBash(
  customShellPath?: string,
): Promise<{ path: string; source: "git" | "path" | "custom" } | undefined> {
  if (customShellPath && (await pathExists(customShellPath))) {
    return { path: customShellPath, source: "custom" };
  }

  if (process.platform === "win32") {
    const candidates: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) candidates.push(join(programFiles, "Git", "bin", "bash.exe"));
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) candidates.push(join(programFilesX86, "Git", "bin", "bash.exe"));
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return { path: candidate, source: "git" };
    }
  } else if (await pathExists("/bin/bash")) {
    return { path: "/bin/bash", source: "path" };
  }

  const onPath = await findBashOnPath();
  return onPath ? { path: onPath, source: "path" } : undefined;
}

/** 检查 node:sqlite 是否可用 */
function checkSqlite(): boolean {
  try {
    // Electron 44 内置 Node 24，node:sqlite 已转正
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

export async function runEnvCheck(customShellPath?: string): Promise<EnvReport> {
  const problems: string[] = [];

  const sqliteAvailable = checkSqlite();
  if (!sqliteAvailable) {
    problems.push("node:sqlite 不可用，无法创建工作台数据库。");
  }

  const bash = await resolveBash(customShellPath);
  if (!bash) {
    problems.push(
      "未找到 bash。Agent 的 bash 工具将不可用。请安装 Git for Windows（https://git-scm.com/download/win），或在设置中指定 shellPath。",
    );
  }

  return {
    electron: process.versions.electron ?? "",
    node: process.versions.node,
    chrome: process.versions.chrome ?? "",
    platform: process.platform,
    arch: process.arch,
    sqliteAvailable,
    bashPath: bash?.path,
    bashSource: bash?.source,
    ok: problems.length === 0,
    problems,
  };
}
