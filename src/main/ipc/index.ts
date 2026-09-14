/**
 * IPC 路由：所有渲染进程调用的落点
 */
import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { existsSync, readdirSync, rmSync, type Dirent } from "node:fs";
import type { IpcChannel, IpcInvokeMap } from "@shared/protocol";
import { resolveSessionModel } from "@shared/model-ref";
import { runEnvCheck } from "../env-check";
import { readGitStatus } from "../git";
import { applyFirstRunChoice, inspectUserData } from "../first-run";
import type { FirstRunReport } from "@shared/protocol";
import {
  createSession,
  deleteSession,
  getProject,
  getSession,
  listProjectChanges,
  listProjects,
  listSessionToolCalls,
  listSessionUsage,
  listSessions,
  upsertProject,
} from "../db/repo";
import { sessionManager } from "../session-manager";
import { getAnalyzeCommandAllowlist, setAnalyzeCommandAllowlist } from "../approval/config";
import { hostBridge } from "../host";
import { readFileWithin } from "../file-read";
import { closeDatabase, openDatabase } from "../db";
import { deleteSecret, hasSecret, maskSecret, setSecret } from "../secrets";
import {
  BUILTIN_DEEPSEEK,
  getProvider,
  listProviders,
  removeProvider,
  saveProvider,
} from "../providers";

/** app.whenReady 阶段采集的首启报告，供渲染层首屏查询（需早于 openDatabase） */
let firstRunReport: FirstRunReport | null = null;

/** 主进程启动时写入首启报告 */
export function setFirstRunReport(report: FirstRunReport): void {
  firstRunReport = report;
}

type Handler<C extends IpcChannel> = (
  request: IpcInvokeMap[C]["request"],
) => Promise<IpcInvokeMap[C]["response"]> | IpcInvokeMap[C]["response"];

/**
 * 解析会话应使用的 provider/model（带失效回退）并启动（或复用）worker。
 * session.open 与 session.prompt 的自动重连共用，保证两处模型选择一致。
 * 模型选择规则收敛在 shared/model-ref，渲染层用同一函数判断「能否自动打开」。
 */
async function openSessionWorker(input: {
  sessionId: string;
  cwd: string;
  model?: string;
}): Promise<void> {
  const providers = listProviders();
  const { providerId, modelId } = resolveSessionModel(
    input.model ?? getSession(input.sessionId)?.modelRef,
    providers,
  );
  const provider = providers.find((item) => item.id === providerId) ?? BUILTIN_DEEPSEEK;

  await sessionManager.ensureWorker({
    sessionId: input.sessionId,
    cwd: input.cwd,
    model: modelId,
    provider,
  });
}

/**
 * 删除会话对应的 JSONL 历史文件。
 * 内核按 cwd 转义目录 + `时间戳_kernelId.jsonl` 命名，DB 里的 jsonl_path 不可靠，
 * 因此在 sessions 根目录下递归搜文件名包含 kernelSessionId 的文件。
 * 找不到（无历史的新会话）或删除失败均不报错——DB 记录已删，孤文件无害。
 */
function removeSessionJsonl(kernelSessionId: string | null): void {
  if (!kernelSessionId) return;
  const root = join(app.getPath("userData"), "sessions");
  if (!existsSync(root)) return;

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
      if (entry.name.includes(kernelSessionId) && entry.name.endsWith(".jsonl")) {
        try {
          rmSync(full, { force: true });
        } catch {
          // 忽略：文件被占用等情况下不阻断删除流程
        }
      }
    }
  }
}

/** 以类型安全的方式注册单个通道 */
function handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, async (_event, request) => handler(request));
}

export function registerIpcHandlers(): void {
  handle("env.check", () => runEnvCheck());

  handle("app.info", () => ({
    version: app.getVersion(),
    userDataPath: app.getPath("userData"),
  }));

  // 首启报告在 app.whenReady 时就已采集（需早于 openDatabase）
  handle("firstRun.check", () => firstRunReport ?? inspectUserData(app.getPath("userData")));

  /**
   * 处理用户对历史数据的选择。
   * fresh 需要先关闭数据库连接再删文件，删完重新建库；import 直接沿用现有库。
   */
  handle("firstRun.resolve", (request) => {
    const userDataPath = app.getPath("userData");
    // import：直接沿用现有库，无需动连接
    if (request.choice !== "fresh") return applyFirstRunChoice(userDataPath, request.choice);

    // 先关连接再删文件，否则 Windows 下文件被占用删不掉
    closeDatabase();
    try {
      return applyFirstRunChoice(userDataPath, request.choice);
    } finally {
      // 无论清空是否成功，都必须把库恢复到可用状态：清空半途失败时，
      // 「沿用（可能已不完整的）旧数据」也远好过「整场会话没有库」——后者会让此后
      // 每个依赖库的 IPC 都持续报「数据库尚未初始化」。
      // 此处若再失败也不掩盖上面真正的失败原因，getDatabase 会在下次访问时自愈重试。
      try {
        openDatabase(userDataPath);
      } catch (error) {
        console.error("[firstRun] 清空后重建数据库失败，将在下次访问时重试", error);
      }
    }
  });

  handle("project.pick", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择项目目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return upsertProject(result.filePaths[0]!);
  });

  handle("project.list", () => listProjects());

  handle("session.create", (request) => {
    const jsonlPath = join(app.getPath("userData"), "sessions", request.projectId);
    return createSession(request.projectId, jsonlPath, request.presetId);
  });

  handle("session.list", (request) => listSessions(request?.projectId));

  handle("session.open", async (request) => {
    await openSessionWorker({
      sessionId: request.sessionId,
      cwd: request.cwd,
      model: request.model,
    });
    return { ok: true } as const;
  });

  handle("session.prompt", async (request) => {
    // 会话可能已被空闲回收（长时间不用）；带 cwd 时自动重建后再投递，避免
    // 旧行为下直接抛「会话未运行」导致界面静默无响应。
    if (request.cwd) {
      await sessionManager.promptOrReconnect(request.sessionId, request.text, request.images, () =>
        openSessionWorker({ sessionId: request.sessionId, cwd: request.cwd! }),
      );
    } else {
      sessionManager.prompt(request.sessionId, request.text, request.images);
    }
    return { ok: true } as const;
  });

  handle("session.abort", (request) => {
    sessionManager.abort(request.sessionId);
    return { ok: true } as const;
  });

  handle("session.close", (request) => ({
    ok: true,
    closed: sessionManager.close(request.sessionId),
  }));

  handle("session.delete", (request) => {
    const session = getSession(request.sessionId);
    if (!session) throw new Error("会话不存在或已被删除");
    // 运行中的会话拒绝删除：避免删除正在写入的 JSONL 与后台进程错配
    if (sessionManager.isRunning(request.sessionId)) {
      throw new Error("会话正在运行，请先中止后再删除");
    }
    // 先关 worker（若已加载），释放文件句柄，再删数据与文件
    sessionManager.close(request.sessionId);
    deleteSession(request.sessionId);
    removeSessionJsonl(session.kernelSessionId);
    // 会话已永久删除：清掉审批状态，否则会话级模式/记忆规则会滞留在内存
    sessionManager.approvals.unregister(request.sessionId);
    return { ok: true } as const;
  });

  handle("session.view", (request) => sessionManager.getView(request.sessionId) ?? null);

  handle("secrets.status", () => ({
    deepseek: hasSecret("deepseek"),
    deepseekMask: maskSecret("deepseek"),
  }));

  handle("secrets.set", (request) => {
    setSecret(request.key, request.value.trim());
    return { ok: true } as const;
  });

  handle("changes.list", (request) => listProjectChanges(request.projectId));

  handle("usage.list", (request) => listSessionUsage(request.sessionId));

  handle("toolCalls.list", (request) => listSessionToolCalls(request.sessionId));

  handle("approval.list", (request) => sessionManager.approvals.listPending(request.sessionId));

  handle("approval.resolve", (request) => {
    sessionManager.resolveApproval({
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      approved: request.approved,
      reason: request.reason,
      remember: request.remember,
      deny: request.deny,
    });
    return { ok: true } as const;
  });

  handle("approval.mode.get", (request) => ({
    mode: sessionManager.approvals.getMode(request.sessionId),
  }));

  handle("approval.mode.set", (request) => {
    // 走 SessionManager 而非直接改 store：除改模式外还要自增 modeEpoch，
    // 让在飞的审批分析按新模式重新裁决
    sessionManager.setApprovalMode(request.sessionId, request.mode);
    return { mode: sessionManager.approvals.getMode(request.sessionId) };
  });

  handle("approval.rules.list", (request) =>
    sessionManager.approvals.listRules(request.sessionId),
  );

  handle("approval.rules.remove", (request) => {
    sessionManager.approvals.removeRule(request.sessionId, request.ruleId);
    return { ok: true } as const;
  });

  handle("approval.rules.clear", (request) => {
    sessionManager.approvals.clearRules(request.sessionId, request.kind);
    return { ok: true } as const;
  });

  handle("approval.analyzeConfig.get", () => ({
    commands: getAnalyzeCommandAllowlist(),
  }));

  handle("approval.analyzeConfig.set", (request) => {
    const commands = setAnalyzeCommandAllowlist(request.commands);
    // 立即生效：把新白名单推给审批中枢，无需重启
    sessionManager.reloadAnalyzeCommandAllowlist();
    return { commands };
  });

  handle("providers.list", () => listProviders());

  handle("providers.save", (request) => {
    saveProvider({
      id: request.id,
      name: request.name,
      baseUrl: request.baseUrl,
      models: request.models,
    });
    // 密钥单独走加密存储，不进数据库
    if (request.apiKey) setSecret(request.id, request.apiKey.trim());
    return { ok: true } as const;
  });

  handle("providers.remove", (request) => {
    removeProvider(request.id);
    deleteSecret(request.id);
    return { ok: true } as const;
  });

  handle("session.setModel", (request) => {
    const provider = getProvider(request.providerId);
    if (!provider) throw new Error(`Provider 不存在：${request.providerId}`);
    sessionManager.setModel(request.sessionId, provider, request.modelId);
    return { ok: true } as const;
  });

  handle("session.steer", (request) => {
    sessionManager.steer(request.sessionId, request.text);
    return { ok: true } as const;
  });

  handle("session.compact", async (request) => {
    // 会话可能已被空闲回收；带 cwd 时自动重建后再投递（同 session.prompt），
    // 否则旧行为下会直接抛「会话未运行」——用户看到的只是“点了没反应”。
    if (request.cwd) {
      await sessionManager.compactOrReconnect(request.sessionId, () =>
        openSessionWorker({ sessionId: request.sessionId, cwd: request.cwd! }),
      );
    } else {
      sessionManager.compact(request.sessionId);
    }
    return { ok: true } as const;
  });

  handle("session.branches", (request) => sessionManager.branches(request.sessionId));

  handle("session.navigate", (request) => {
    sessionManager.navigate(request.sessionId, request.targetId);
    return { ok: true } as const;
  });

  handle("git.status", (request) => readGitStatus(request.cwd));

  // 内嵌浏览器：渲染层上报页面区域矩形供主进程摆放 WebContentsView（原生视图不参与 DOM 叠层）
  handle("browser.bounds", (request) => {
    hostBridge.setBrowserBounds(request.sessionId, request.rect);
    return { ok: true } as const;
  });
  handle("browser.state.get", (request) => hostBridge.browserState(request.sessionId));
  // 浏览器观测快照：与 browser_read 读同一份缓冲，只读、不触发任何动作
  handle("browser.observe", (request) => hostBridge.browserObservation(request.sessionId));
  // 用户手动导航（B1）：不走审批——发起方是用户、不是模型，没有可裁决的入参；
  // 但要把「页面已经不是你离开时那页」告知正在跑的 agent（见 sessionManager 上的说明）。
  handle("browser.navigate", (request) => {
    const { state, notice } = hostBridge.browserNavigate(request.sessionId, request.action);
    if (notice.length > 0) sessionManager.notifyUserBrowserNavigation(request.sessionId, notice);
    return state;
  });
  // 撤销 agent 留下的视口联调覆盖（B1 排查中发现的问题）：覆盖是持久状态，
  // 只有显式撤销才结束，用户必须有个出口，否则面板会一直按那个尺寸摆放、看着像渲染坏了。
  handle("browser.viewport.reset", (request) => hostBridge.browserResetViewport(request.sessionId));

  // 根**只由主进程推导**：渲染层给 sessionId 与相对路径，绝不给根
  handle("file.read", (request) => {
    const session = getSession(request.sessionId);
    if (session === undefined) throw new Error("会话不存在");
    const project = getProject(session.projectId);
    if (project === undefined) throw new Error("项目不存在");
    return readFileWithin(project.rootPath, request.path);
  });
}

/** 首启时若环境变量里有 key 且尚未配置，则自动导入一次，方便开发 */
export function importKeyFromEnvIfMissing(): void {
  if (hasSecret("deepseek")) return;
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) setSecret("deepseek", fromEnv);
}
