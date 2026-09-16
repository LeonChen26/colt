/**
 * IPC 路由：所有渲染进程调用的落点
 */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, readdirSync, rmSync, type Dirent } from "node:fs";
import type { IpcChannel, IpcInvokeMap, SessionInfo } from "@shared/protocol";
import type { ThinkingLevel } from "@shared/thinking-level";
import { resolveSessionModel } from "@shared/model-ref";
import { runEnvCheck } from "../env-check";
import { readGitStatus } from "../git";
import { applyFirstRunChoice, inspectUserData } from "../first-run";
import type { FirstRunReport } from "@shared/protocol";
import {
  createSession,
  deleteSession,
  getFileBaseline,
  getProject,
  getSession,
  listProjectChanges,
  listProjects,
  listSessionToolCalls,
  listSessionUsage,
  listSessions,
  setSessionModel,
  setSessionThinkingLevel,
  upsertProject,
} from "../db/repo";
import { sessionManager } from "../session-manager";
import { getAnalyzeCommandAllowlist, setAnalyzeCommandAllowlist } from "../approval/config";
import { hostBridge } from "../host";
import { readFileWithin } from "../file-read";
import { computeNetChange } from "../net-change";
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
}): Promise<void> {  const providers = listProviders();
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

/**
 * 需要知道「谁在调用」的通道。
 * 原生对话框必须挂在**发起窗口**上：不挂就会变成无父窗口的自由对话框，
 * 模态关系与关掉后的焦点归还都无从谈起（见 dialog.confirm 的用途）。
 */
function handleWithSender<C extends IpcChannel>(
  channel: C,
  handler: (
    sender: Electron.WebContents,
    request: IpcInvokeMap[C]["request"],
  ) => Promise<IpcInvokeMap[C]["response"]> | IpcInvokeMap[C]["response"],
): void {
  ipcMain.handle(channel, async (event, request) => handler(event.sender, request));
}

/** 会话的历史目录（真实 JSONL 由内核在其中按「转义后的 cwd + kernelId」生成） */
function jsonlPathFor(projectId: string): string {
  return join(app.getPath("userData"), "sessions", projectId);
}

/**
 * 草稿会话：`session.create` 只分配 id 并登记在这里，**不写 sessions 表**。
 *
 * 首次发消息（见 materializeDraft）时才落库——在那之前不 fork worker、不建 JSONL。
 * 否则「点了新建就退出」会在侧栏留下一条 message_count=0、点开还没反应的会话，
 * 而用户从没往里发过一个字。
 *
 * 只存在于内存：重启即消失，这正是「还没用过的会话」应有的语义。
 */
const drafts = new Map<
  string,
  { projectId: string; modelRef: string | null; thinkingLevel: ThinkingLevel | null }
>();

/** 把草稿落库；不是草稿则什么都不做。落库后立刻从草稿表移除，避免二次落库 */
function materializeDraft(sessionId: string): void {
  const draft = drafts.get(sessionId);
  if (!draft) return;
  drafts.delete(sessionId);
  createSession(draft.projectId, jsonlPathFor(draft.projectId), sessionId);
  // 落库前在草稿上选过的模型要跟着走：不然用户「先选模型再发消息」的那一步会被丢掉
  if (draft.modelRef) setSessionModel(sessionId, draft.modelRef);
  if (draft.thinkingLevel) setSessionThinkingLevel(sessionId, draft.thinkingLevel);
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

  /**
   * 原生确认框。
   *
   * 存在的唯一理由：渲染层的 `window.confirm` 是 **JS 对话框**，被关掉之后 Chromium
   * 不让页面继续拿焦点——用户点输入框不出光标、敲不进字，必须让窗口失焦再回来才恢复。
   * 换成主进程的 `dialog.showMessageBox` 后，渲染层全程不被阻塞，焦点也不被 JS 对话框
   * 机制染指；返回前再显式把焦点还给发起窗口，收尾不留悬念。
   *
   * `noLink`：Windows 默认会把按钮渲染成「命令链接」大块样式，对这种二选一是纯噪音。
   * 破坏性动作用 `defaultId = cancelId = 1`：回车/ESC 都落到「取消」，不该靠一次回车把数据删掉。
   */
  handleWithSender("dialog.confirm", async (sender, request) => {
    const owner = BrowserWindow.fromWebContents(sender);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      noLink: true,
      buttons: [request.confirmLabel ?? "确定", "取消"],
      defaultId: 1,
      cancelId: 1,
      title: "Colt",
      message: request.message,
      detail: request.detail,
    };
    const { response } = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (owner && !owner.isDestroyed()) {
      owner.focus();
      owner.webContents.focus();
    }
    return { confirmed: response === 0 };
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
    const now = Date.now();
    const id = randomUUID();
    drafts.set(id, {
      projectId: request.projectId,
      modelRef: null,
      thinkingLevel: null,
    });
    // 与真实会话同形，界面无需特殊分支；jsonlPath 为空串——文件要等首次发消息才存在
    const draft: SessionInfo = {
      id,
      projectId: request.projectId,
      title: "新会话",
      jsonlPath: "",
      kernelSessionId: null,
      modelRef: null,
      thinkingLevel: null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      status: "active",
    };
    return draft;
  });

  handle("session.list", (request) => listSessions(request?.projectId));

  handle("session.open", async (request) => {
    // 草稿没有历史可载入，也不该为一个「还没发过消息」的会话 fork worker / 建 JSONL。
    // 首次发消息时由 session.prompt 落库并打开（见 materializeDraft）。
    if (drafts.has(request.sessionId)) return { ok: true } as const;
    await openSessionWorker({
      sessionId: request.sessionId,
      cwd: request.cwd,
      model: request.model,
    });
    return { ok: true } as const;
  });

  handle("session.prompt", async (request) => {
    // 首次发消息：草稿在此刻落库（此后才是「真实会话」，会出现在 session.list 里）
    materializeDraft(request.sessionId);
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
    // 草稿：既没有落库数据也没有文件，丢掉内存记录即可
    if (drafts.delete(request.sessionId)) return { ok: true } as const;
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
      requiresKey: request.requiresKey,
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

  handle("session.setModel", async (request) => {
    const provider = getProvider(request.providerId);
    if (!provider) throw new Error(`Provider 不存在：${request.providerId}`);
    // 草稿会话：选择只记在草稿上。它还没落库，UPDATE 会打在 0 行上（静默丢失）；
    // 也不该为一个「还没发过消息的会话」拉起 worker——那正是草稿要避免的事。
    // 记在草稿里的选择会在首次发消息落库时一并写出（见 materializeDraft）。
    const draft = drafts.get(request.sessionId);
    if (draft) {
      draft.modelRef = `${provider.id}/${request.modelId}`;
      return provider.requiresKey && !hasSecret(provider.id)
        ? ({ ok: true, needsKey: true } as const)
        : ({ ok: true } as const);
    }
    // 选中的就是没配密钥的服务（下拉里可能列出它，用户也可能是先选模型再填密钥）——
    // 这不是错误，只是还不能跑；先把选择落库，让用户回到设置页去填密钥。
    // 否则界面弹红、选项卡也不变，看上去就是「选不了模型」。
    // 只对**确实需要密钥**的服务这么办：本地 / 自建 endpoint 本来就没有密钥，
    // 按「缺密钥」处理会让它永远打不开。
    if (provider.requiresKey && !hasSecret(provider.id)) {
      setSessionModel(request.sessionId, `${provider.id}/${request.modelId}`);
      return { ok: true, needsKey: true } as const;
    }
    await sessionManager.setModelOrReconnect(
      request.sessionId,
      provider,
      request.modelId,
      // 无 cwd 无法重建（worker 需要工作目录），此时只落库
      request.cwd
        ? () =>
            openSessionWorker({
              sessionId: request.sessionId,
              cwd: request.cwd!,
            })
        : undefined,
    );
    return { ok: true } as const;
  });

  handle("session.steer", (request) => {
    sessionManager.steer(request.sessionId, request.text);
    return { ok: true } as const;
  });

  handle("session.setThinkingLevel", (request) => {
    // 草稿会话：同 session.setModel——它还没落库，UPDATE 会打在 0 行上静默丢失；
    // 也不该为一个还没发过消息的会话拉起 worker。记在草稿里，首次发消息落库时一并写出。
    const draft = drafts.get(request.sessionId);
    if (draft) {
      draft.thinkingLevel = request.level;
      return { ok: true } as const;
    }
    // worker 不在池中时只落库（不重建）：下次打开会话会带着新等级启动
    sessionManager.setThinkingLevel(request.sessionId, request.level);
    return { ok: true } as const;
  });

  handle("session.compact", async (request) => {
    // 与 session.prompt 同理：可能把 worker 拉起来，那就必须先有会话行——
    // 否则 worker 里那个内核会话 ID 无处落库（UPDATE 打在 0 行上），下次打开会另起一份历史。
    materializeDraft(request.sessionId);
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

  handle("session.skill", async (request) => {
    // 与 session.compact 同理：可能把 worker 拉起来，那就必须先有会话行，
    // 否则 worker 里那个内核会话 ID 无处落库（UPDATE 打在 0 行上），下次打开会另起一份历史。
    materializeDraft(request.sessionId);
    if (request.cwd) {
      await sessionManager.skillOrReconnect(
        request.sessionId,
        request.name,
        request.instructions,
        () => openSessionWorker({ sessionId: request.sessionId, cwd: request.cwd! }),
      );
    } else {
      sessionManager.skill(request.sessionId, request.name, request.instructions);
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
  // 「适应宽度」：页面按固定宽度排版、停靠区又装不下时的唯一出路（缩放不动原生视图矩形，
  // 所以那条「视图 == 页面区域」的硬约束不受影响）。比例由主进程算，用户只表达意图。
  handle("browser.zoom", (request) => hostBridge.browserSetZoom(request.sessionId, request.fit));

  // 根**只由主进程推导**：渲染层给 sessionId 与相对路径，绝不给根
  handle("file.read", (request) => {
    const session = getSession(request.sessionId);
    if (session === undefined) throw new Error("会话不存在");
    const project = getProject(session.projectId);
    if (project === undefined) throw new Error("项目不存在");
    return readFileWithin(project.rootPath, request.path);
  });

  /**
   * 净变化（基线 → 当前）：逐次 patch 答不了「这个文件最终被改成了什么」，这条通道答它。
   * 基线与根同样**只由主进程**取（前者来自库、后者由 sessionId → 项目推出）。
   */
  handle("file.netDiff", (request) => {
    const session = getSession(request.sessionId);
    if (session === undefined) throw new Error("会话不存在");
    const project = getProject(session.projectId);
    if (project === undefined) throw new Error("项目不存在");
    return computeNetChange(
      project.rootPath,
      request.path,
      getFileBaseline(request.sessionId, request.path),
    );
  });
}

/** 首启时若环境变量里有 key 且尚未配置，则自动导入一次，方便开发 */
export function importKeyFromEnvIfMissing(): void {
  if (hasSecret("deepseek")) return;
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) setSecret("deepseek", fromEnv);
}
