/**
 * IPC 路由：所有渲染进程调用的落点
 * 作者：陕耀云栈WorkMate
 */
import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
import type { IpcChannel, IpcInvokeMap } from "@shared/protocol";
import { runEnvCheck } from "../env-check";
import {
  createSession,
  getSession,
  listProjectChanges,
  listProjects,
  listSessionToolCalls,
  listSessionUsage,
  listSessions,
  upsertProject,
} from "../db/repo";
import { sessionManager } from "../session-manager";
import { deleteSecret, hasSecret, maskSecret, setSecret } from "../secrets";
import {
  BUILTIN_DEEPSEEK,
  getProvider,
  listProviders,
  removeProvider,
  saveProvider,
} from "../providers";

/** 默认模型 */
const DEFAULT_MODEL = "deepseek-v4-flash";

type Handler<C extends IpcChannel> = (
  request: IpcInvokeMap[C]["request"],
) => Promise<IpcInvokeMap[C]["response"]> | IpcInvokeMap[C]["response"];

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
    // 模型优先级：显式传入 > 会话上次选定 > 内置 DeepSeek 默认
    // 形如 "providerId/modelId"
    const raw =
      request.model ?? getSession(request.sessionId)?.modelRef ?? `${BUILTIN_DEEPSEEK.id}/${DEFAULT_MODEL}`;
    const slash = raw.indexOf("/");
    let providerId = slash === -1 ? BUILTIN_DEEPSEEK.id : raw.slice(0, slash);
    let modelId = slash === -1 ? raw : raw.slice(slash + 1);

    // 持久化的 modelRef 可能已失效（provider 被删、模型下线），退回内置默认，
    // 否则会话将因 provider 找不到而永久打不开
    let provider = getProvider(providerId);
    if (!provider || !provider.models.some((item) => item.id === modelId)) {
      providerId = BUILTIN_DEEPSEEK.id;
      modelId = DEFAULT_MODEL;
      provider = BUILTIN_DEEPSEEK;
    }

    await sessionManager.ensureWorker({
      sessionId: request.sessionId,
      cwd: request.cwd,
      model: modelId,
      provider,
    });
    return { ok: true } as const;
  });

  handle("session.prompt", (request) => {
    sessionManager.prompt(request.sessionId, request.text);
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

  handle("session.compact", (request) => {
    sessionManager.compact(request.sessionId);
    return { ok: true } as const;
  });

  handle("session.branches", (request) => sessionManager.branches(request.sessionId));

  handle("session.navigate", (request) => {
    sessionManager.navigate(request.sessionId, request.targetId);
    return { ok: true } as const;
  });
}

/** 首启时若环境变量里有 key 且尚未配置，则自动导入一次，方便开发 */
export function importKeyFromEnvIfMissing(): void {
  if (hasSecret("deepseek")) return;
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) setSecret("deepseek", fromEnv);
}
