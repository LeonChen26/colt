/**
 * 首启检测：判断本机是否留有历史安装残留（%APPDATA%\Banyan）。
 *
 * 用途：
 * - 全新环境 → 渲染层走首次运行引导；
 * - 检测到历史数据 → 让用户选择「沿用」或「清空重来」。
 *
 * 设计：核心逻辑为接收路径参数的纯函数（inspectUserData / clearUserData），
 * 便于单测；electron 的 app 依赖只保留在 checkFirstRun / resolveFirstRun 两个薄封装里。
 *
 * 作者：陕耀云栈WorkMate
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FirstRunChoice, FirstRunReport } from "@shared/protocol";

/** 引导完成标志文件，位于 userData 根目录 */
const ONBOARDING_FLAG = ".onboarded";

/** 可随「清空重来」一并删除的业务目录 / 文件 */
const CLEARABLE_ENTRIES = ["data", "sessions"];

function flagPath(userDataPath: string): string {
  return join(userDataPath, ONBOARDING_FLAG);
}

function dbPath(userDataPath: string): string {
  return join(userDataPath, "data", "banyan.db");
}

function secretsPath(userDataPath: string): string {
  return join(userDataPath, "data", "secrets.json");
}

/** 统计历史库中的项目与会话数量；库不可读时返回 0，不阻断启动 */
function countHistory(file: string): { projectCount: number; sessionCount: number } {
  if (!existsSync(file)) return { projectCount: 0, sessionCount: 0 };
  let instance: DatabaseSync | undefined;
  try {
    instance = new DatabaseSync(file, { readOnly: true });
    const projectRow = instance.prepare("SELECT COUNT(*) AS n FROM projects").get() as
      | { n?: number }
      | undefined;
    const sessionRow = instance.prepare("SELECT COUNT(*) AS n FROM sessions").get() as
      | { n?: number }
      | undefined;
    return { projectCount: Number(projectRow?.n ?? 0), sessionCount: Number(sessionRow?.n ?? 0) };
  } catch {
    return { projectCount: 0, sessionCount: 0 };
  } finally {
    instance?.close();
  }
}

/** 采集指定 userData 目录的首启报告（纯函数，便于测试） */
export function inspectUserData(userDataPath: string): FirstRunReport {
  const history = countHistory(dbPath(userDataPath));
  const hasDatabase = existsSync(dbPath(userDataPath));
  const hasSecret = existsSync(secretsPath(userDataPath));
  const hasHistoricalData = hasDatabase || hasSecret || history.projectCount > 0 ||
    history.sessionCount > 0;

  return {
    hasHistoricalData,
    hasDatabase,
    projectCount: history.projectCount,
    sessionCount: history.sessionCount,
    hasSecret,
    userDataPath,
    onboardingDone: existsSync(flagPath(userDataPath)),
  };
}

/**
 * 清空指定 userData 目录下的业务数据，保留目录本身，并写入引导完成标志。
 * 调用前必须已关闭数据库连接，否则 Windows 下文件被占用无法删除。
 */
export function clearUserData(userDataPath: string): void {
  for (const name of CLEARABLE_ENTRIES) {
    const target = join(userDataPath, name);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
  // 清理根目录残留（保留标志文件）
  if (existsSync(userDataPath)) {
    for (const entry of readdirSync(userDataPath)) {
      if (entry === ONBOARDING_FLAG) continue;
      rmSync(join(userDataPath, entry), { recursive: true, force: true });
    }
  }
}

/** 写入引导完成标志 */
export function writeOnboardedFlag(userDataPath: string): void {
  writeFileSync(flagPath(userDataPath), String(Date.now()), "utf8");
}

/**
 * 处理用户对历史数据的选择。
 * - import：沿用历史数据，仅打标志；
 * - fresh：删除业务数据后打标志。
 *
 * 返回 cleared 表示是否执行了清空。
 */
export function applyFirstRunChoice(
  userDataPath: string,
  choice: FirstRunChoice,
): { ok: true; cleared: boolean } {
  const cleared = choice === "fresh";
  if (cleared) clearUserData(userDataPath);
  writeOnboardedFlag(userDataPath);
  return { ok: true, cleared };
}
