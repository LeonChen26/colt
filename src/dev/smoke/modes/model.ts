// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：model
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { app, BrowserWindow } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createSession,
  deleteSession,
  getSession,
  listProjects,
  listSessions,
  setSessionModel,
  upsertProject,
} from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { listProviders, removeProvider, saveProvider } from "../../../main/providers";
import { deleteSecret, getSecret, setSecret } from "../../../main/secrets";
import { writeOnboardedFlag } from "../../../main/first-run";
import { hasUsableProvider, resolveSessionModel } from "@shared/model-ref";
import { sleep } from "../context";

/**
 * 「未开启会话也能选模型」的端到端用例。
 *
 * 回归背景（用户实测）：「未开启会话就不能选 model」。会话没有 worker 时（未打开、
 * 或已被空闲回收）`session.view` 返回 null，而模型下拉的显示值原先只取自 `view.model`，
 * 于是「已经选好并落库」在界面上毫无反映——用户看到的就是选了没反应。
 *
 * 这里用**新建的、故意不配密钥的 provider** 造出「选中即注定没有 worker」的场景：
 * 主进程只落库并回 needsKey，不 fork worker。全程真实点开下拉，断言：
 *   1. 无 worker 时，落库的选定值照样显示在会话头上；
 *   2. 换一个模型后立刻回显且已落库，而此刻**确实没有 worker**；
 *   3. 缺密钥给的是黄色提示而不是红色错误。
 * 三条合起来即「未开启会话也能选 model」。
 */
export async function runModelSelect(
  window: BrowserWindow,
  sessionsDir: string,
  projectId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const PROVIDER_ID = "smoke-keyless";
  const MODEL_A = "smoke-model-a";
  const MODEL_B = "smoke-model-b";
  const NAME_A = "Smoke 无密钥模型 A";
  const NAME_B = "Smoke 无密钥模型 B";
  const LABEL_A = `${NAME_A}（未配置密钥）`;
  const LABEL_B = `${NAME_B}（未配置密钥）`;
  const checks: [string, boolean][] = [];

  // 故意不配密钥：选中它时主进程只落库、不拉 worker，正是要验的场景
  saveProvider({
    id: PROVIDER_ID,
    name: "Smoke 无密钥服务",
    baseUrl: "https://example.invalid/v1",
    models: [
      { id: MODEL_A, name: NAME_A, contextWindow: 1000 },
      { id: MODEL_B, name: NAME_B, contextWindow: 1000 },
    ],
  });

  const session = createSession(projectId, sessionsDir);
  // 直接落库「已选定 A」，且**不调 session.open** —— 会话因此没有 worker
  setSessionModel(session.id, `${PROVIDER_ID}/${MODEL_A}`);
  log(`会话：${session.id}（已落库选定 ${PROVIDER_ID}/${MODEL_A}，未打开）`);

  /** 会话头上模型下拉的显示文案 */
  const pickerLabel = (): Promise<string | null> =>
    run<string | null>(`(() => {
      const el = document.querySelector("button.model .lbl");
      return el ? el.textContent.trim() : null;
    })()`);

  try {
    // 用例自带环境准备：否则首启引导覆盖层会盖住命中测试，用例变成「看环境脸色」
    writeOnboardedFlag(app.getPath("userData"));
    window.reload();
    await sleep(4000);

    // 与 App 同款取法：session.list 第一条（updated_at DESC）就是渲染层显示的那个会话
    const list = await run<{ id: string }[]>(
      `window.colt.invoke("session.list", ${JSON.stringify({ projectId })})`,
    );
    log(`列表首条：${list[0]?.id ?? "（空）"}（本用例 ${session.id}）`);
    checks.push(["界面活动会话就是用例建的这条", list[0]?.id === session.id]);

    const initial = await pickerLabel();
    log(`初始下拉文案：${initial}`);
    checks.push(["无 worker 时照样显示落库的选定值", initial === LABEL_A]);

    // 点开下拉（必须分两次：setOpen 是 React 状态更新，同一轮 DOM 里还没有选项）
    await run(`document.querySelector("button.model")?.click() ?? null`);
    await sleep(400);
    const clicked = await run<boolean>(`(() => {
      const option = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === ${JSON.stringify(LABEL_B)},
      );
      if (!option) return false;
      option.click();
      return true;
    })()`);
    checks.push(["下拉里能找到并点中目标模型", clicked]);

    await sleep(1000);
    const after = await pickerLabel();
    log(`切换后下拉文案：${after}`);
    checks.push(["切换后立刻回显为所选模型", after === LABEL_B]);
    checks.push([
      "选择已落库（重启后仍生效）",
      getSession(session.id)?.modelRef === `${PROVIDER_ID}/${MODEL_B}`,
    ]);

    // 关键前提：这一路确实没有 worker，否则上面的回显可能只是 worker 汇报的
    const workerView = await run<unknown>(
      `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`,
    );
    checks.push(["全程没有 worker（会话始终未开启）", workerView === null]);

    const noticeCount = await run<number>(`document.querySelectorAll("[data-conv-notice]").length`);
    const errorCount = await run<number>(`document.querySelectorAll("[data-conv-error]").length`);
    checks.push(["缺密钥是黄色提示而非红色错误", noticeCount === 1 && errorCount === 0]);
  } finally {
    // 先出结论再清理：清理出岔子也不该吞掉已拿到的证据
    log("[model] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
    removeProvider(PROVIDER_ID);
    deleteSecret(PROVIDER_ID);
  }
}

/**
 * 把「这台机器上用户自己配的服务」先变成**不可用**，并交还一个**原样还原**的函数。
 *
 * 为什么需要：`[model]` 之后的三段（`fallback` / `keyless` / `no-usable`）都在造一个关于
 * 「现在有哪些服务可用」的环境，而默认解析（`resolveSessionModel`）是从**整份** provider 列表里
 * 挑的——机器上只要还有一个自己配的服务能排在用例造的那个前面，整段断言就**悄悄失去意义**。
 * 2026-09 实测：本机的 `glm`（自己配的、带密钥）抢走了默认解析，`fallback` / `keyless` 各红 2 条，
 * 而红字看上去像产品坏了（那两段的**其余**断言全绿：界面无报错、会话开得起来、消息发得出去）。
 *
 * 做法刻意**取最小的副作用**——这段跑在用户的真实配置上，最坏情况是把配置改坏：
 * - **带密钥的服务：只删密钥、不删条目**。没有密钥它就不算「可用」，而条目（名字 / baseUrl /
 *   models）原样留着；哪怕用例中途硬崩、`finally` 没跑到，用户损失的也只是一个密钥值。
 * - **免密钥的服务**（本地 / 自建 endpoint）：删了密钥照样算可用，只能**整条挪走**。
 * - **内置服务**（DeepSeek）的密钥是**环境资产**，各段按需自己处理、自己还——这里不碰。
 *
 * 还原顺序跟写入依赖一致：**先还全部密钥，再写回被挪走的条目**。
 */
export function stashUsableProviders(): () => void {
  const custom = listProviders().filter((provider) => !provider.builtin);
  const secrets = custom.map((provider) => [provider.id, getSecret(provider.id)] as const);
  const removed = custom.filter((provider) => !provider.requiresKey);
  for (const provider of custom) deleteSecret(provider.id);
  for (const provider of removed) removeProvider(provider.id);
  return () => {
    for (const [id, secret] of secrets) if (secret) setSecret(id, secret);
    for (const provider of removed) {
      saveProvider({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        models: provider.models,
        requiresKey: provider.requiresKey,
      });
    }
  };
}

/**
 * 未配内置 DeepSeek、只配了自定义服务时的**默认模型解析**。
 *
 * 回归背景（用户实测）：没有 DeepSeek 密钥、配好了自定义 provider，会话又从未选过模型时，
 * 默认解析死认内置 DeepSeek → 界面挂着「尚未配置 DeepSeek 的 API Key」，
 * 一发消息更会被同一句话**拒绝**（`#spawnWorker` 的密钥检查直接抛错）。
 * 用户明明配好了能用的服务，却一直被告知 DeepSeek 缺密钥——这就是「会报错」。
 *
 * 判据里同时看两侧：主进程解析出的 provider（确定性）、界面上的红错/黄条、以及发消息是否被挡。
 */
export async function runModelFallback(
  window: BrowserWindow,
  sessionsDir: string,
  projectId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const PROVIDER_ID = "smoke-custom";
  const MODEL_ID = "smoke-custom-model";
  const MODEL_NAME = "Smoke 自定义模型";
  const checks: [string, boolean][] = [];

  // 场景前提：内置 DeepSeek 没有密钥、**且除本用例的临时服务外没有别的服务**。
  // 后半句必须**显式建立**——默认解析是从整份 provider 列表里挑的，机器上只要还有一个自己配的
  // 服务能排在前面，本段就悄悄失去意义（2026-09 实测：本机的 `glm` 就是这样）。
  // DeepSeek 的密钥是**环境资产**（跑冒烟的那份 userData 里可能真配过），用完原样还回去，
  // 免得一次冒烟把环境改坏、后续用例看到的前提就不对了。
  const savedDeepseekKey = getSecret("deepseek");

  // 会话从未选过模型：正是「默认解析」要负责的情形
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}（未选模型，且内置 DeepSeek 无密钥）`);

  // 先给个空实现：`stashUsableProviders` 万一自己抛了，`finally` 里也不至于再炸一次
  let restoreProviders: () => void = () => undefined;
  try {
    restoreProviders = stashUsableProviders();
    deleteSecret("deepseek");
    saveProvider({
      id: PROVIDER_ID,
      name: "Smoke 自定义服务",
      baseUrl: "https://example.invalid/v1",
      models: [{ id: MODEL_ID, name: MODEL_NAME, contextWindow: 1000 }],
    });
    setSecret(PROVIDER_ID, "sk-smoke-fake-key");

    writeOnboardedFlag(app.getPath("userData"));
    window.reload();
    await sleep(4000);

    const list = await run<{ id: string }[]>(
      `window.colt.invoke("session.list", ${JSON.stringify({ projectId })})`,
    );
    checks.push(["界面活动会话就是用例建的这条", list[0]?.id === session.id]);

    // 主进程侧：默认解析必须落到**可用**的自定义服务，而不是没密钥的内置 DeepSeek
    const resolved = resolveSessionModel(getSession(session.id)?.modelRef ?? null, listProviders());
    log(`默认解析：${resolved.providerId}/${resolved.modelId}`);
    checks.push(["默认解析落到已配置密钥的自定义服务", resolved.providerId === PROVIDER_ID]);

    // 界面侧：不该出现任何点名 DeepSeek 的红错或黄条
    const banner = await run<string>(`(() => {
      const err = document.querySelector("[data-conv-error]")?.textContent ?? "";
      const note = document.querySelector("[data-conv-notice]")?.textContent ?? "";
      return err || note;
    })()`);
    log(`界面提示：${banner || "（无）"}`);
    checks.push(["界面没有「尚未配置 DeepSeek」的报错/提示", !banner.includes("DeepSeek")]);

    // 会话确实开了（视图存在 = worker 真的起来了，而非被密钥检查挡在门外）
    const view = await run<{ model?: string } | null>(
      `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`,
    );
    checks.push(["会话已用自定义服务打开（worker 已就绪）", view !== null]);

    const label = await run<string | null>(`(() => {
      const el = document.querySelector("button.model .lbl");
      return el ? el.textContent.trim() : null;
    })()`);
    log(`下拉文案：${label}`);
    checks.push(["下拉显示的是自定义模型", label === MODEL_NAME]);

    // 直接复现用户的报错：发一条消息，看是否被「尚未配置 DeepSeek 的 API Key」挡住
    // （worker 起不来时 promptOrReconnect 会把这句话原样抛给界面）
    const promptOutcome = await run<string>(
      `window.colt.invoke("session.prompt", ${JSON.stringify({
        sessionId: session.id,
        text: "hi",
        cwd: process.env.COLT_SMOKE_CWD ?? process.cwd(),
      })}).then(() => "OK").catch((e) => String(e && e.message ? e.message : e))`,
    );
    log(`发消息结果：${promptOutcome}`);
    checks.push(["发消息不再被 DeepSeek 缺密钥挡住", !promptOutcome.includes("DeepSeek")]);
  } finally {
    log("[model/fallback] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
    removeProvider(PROVIDER_ID);
    deleteSecret(PROVIDER_ID);
    if (savedDeepseekKey) setSecret("deepseek", savedDeepseekKey);
    // 最后再还这台机器真实的服务——放最后，保证用户配置是被最后写回的
    restoreProviders();
  }
}

/**
 * 会话**正在打开**时切模型（worker 进程已登记、但 init 还没跑完）。
 *
 * 回归背景（用户实测）：切模型报错「会话尚未初始化」。根因是 `#workers` 里的条目在
 * fork 之后**立刻**就登记了，而 worker 的 `init`（重放历史）还在跑——`has(sessionId)`
 * 只代表「进程已拉起」，不代表「已就绪」。把命令下发给一个还没 init 完的 worker，
 * 它的 handler 会在 `state` 就绪前收到并从 `case "setModel"` 抛「会话尚未初始化」。
 *
 * 会话越大越容易撞上：init 要重放整份 JSONL（实测 2.4 万行那份要好几秒），
 * 用户在这段时间里点模型下拉就中招。
 *
 * 用例刻意用**合成会话 id**：真实会话会被 App 启动时自动打开，我这边 wait 几秒之后
 * worker 早已就绪，窗口就没了（第一版用例就是这么空跑过去的）。
 * 断言读渲染层收到的 `session.error` 事件，不依赖红条是否渲染、也不依赖当前会话是谁。
 */
export async function runModelSwitchDuringOpen(
  window: BrowserWindow,
  _sessionsDir: string,
  _projectId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const PROVIDER_ID = "smoke-custom";
  const MODEL_ID = "smoke-custom-model";
  const checks: [string, boolean][] = [];
  /** 合成会话 id：库里没有这条，App 不会替我打开它，窗口留给用例自己制造 */
  const sessionId = "smoke-during-init";
  const cwd = process.env.COLT_SMOKE_CWD ?? process.cwd();

  const savedDeepseekKey = getSecret("deepseek");
  deleteSecret("deepseek");
  saveProvider({
    id: PROVIDER_ID,
    name: "Smoke 自定义服务",
    baseUrl: "https://example.invalid/v1",
    models: [{ id: MODEL_ID, name: "Smoke 自定义模型", contextWindow: 1000 }],
  });
  setSecret(PROVIDER_ID, "sk-smoke-fake-key");
  log(`会话：${sessionId}（合成 id，worker 未就绪时下发命令）`);

  try {
    writeOnboardedFlag(app.getPath("userData"));
    window.reload();
    await sleep(4000);

    // 渲染层挂一个收集器：worker 报错会以 session.error 事件回来，这是用户看到的红条源头
    await run<boolean>(`(() => {
      window.__modelErrors = [];
      window.colt.on("session.error", (payload) => window.__modelErrors.push(payload.message));
      return true;
    })()`);

    const provider = listProviders().find((item) => item.id === PROVIDER_ID);
    if (!provider) throw new Error("用例前置失败：自定义 provider 未注册");

    // 只登记、不等就绪：这句返回时进程刚 fork 出来，init（重放历史）还在跑
    const opening = sessionManager.ensureWorker({ sessionId, cwd, model: MODEL_ID, provider });
    // 立刻走一遍生产路径（IPC 的 session.setModel 也是调它），落进「已登记、未就绪」的窗口
    await sessionManager.setModelOrReconnect(sessionId, provider, MODEL_ID, undefined);
    await opening.catch(() => undefined);
    await sleep(1500);

    const errors = await run<string[]>(`window.__modelErrors ?? []`);
    log(`worker 侧错误事件：${errors.length > 0 ? errors.join(" | ") : "（无）"}`);
    checks.push([
      "init 期间下发 setModel 不被 worker 以「会话尚未初始化」拒绝",
      !errors.some((message) => message.includes("初始化")),
    ]);
  } finally {
    log("[model/during-init] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
    sessionManager.close(sessionId);
    removeProvider(PROVIDER_ID);
    deleteSecret(PROVIDER_ID);
    if (savedDeepseekKey) setSecret("deepseek", savedDeepseekKey);
  }
}

/**
 * 只用**无需密钥**的本地 / 自建服务（ollama、vLLM、llama.cpp …）时必须能正常对话。
 *
 * 回归背景（用户实测）：没有 DeepSeek 密钥、只配了自建 endpoint。旧判据把「可用」
 * 等同于「配了密钥」，于是默认解析落到内置 DeepSeek、界面挂「尚未配置 DeepSeek 的
 * API Key」、发消息被启动检查拒绝——服务明明跑着，一个也用不上。
 *
 * 用例刻意**不配任何密钥**、也不预先选定模型，让整条链路自己走默认解析；
 * 断言取主进程的解析结果与渲染层真实渲染出来的文案，不看内部字段。
 */
export async function runModelKeyless(
  window: BrowserWindow,
  sessionsDir: string,
  projectId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const PROVIDER_ID = "smoke-local";
  const MODEL_ID = "smoke-local-model";
  const MODEL_NAME = "Smoke 本地模型";
  const checks: [string, boolean][] = [];

  const savedDeepseekKey = getSecret("deepseek");

  // 前两个用例创建的会话可能还在跑：它们每推一次 view 就会 touch updated_at，
  // 把「列表第一条」的位置占住，于是 App 打开的不是我们这条、断言也就失去意义。
  // 先等它们跑完再收掉 worker，列表顺序才由本用例的会话决定。
  for (const other of listSessions(projectId)) {
    for (let i = 0; i < 40 && sessionManager.isRunning(other.id); i += 1) await sleep(500);
    sessionManager.close(other.id);
  }

  // 内置 DeepSeek 空着：唯一「能用」的服务就是这个不需要密钥的本地 endpoint
  // ——但这句话只有在**别的服务都不在**时才成立，见下面 `stashUsableProviders()`。

  // 不设 model_ref：走的就是「会话从未选过模型」的默认解析
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}（未选模型，且内置 DeepSeek 无密钥）`);

  // 先给个空实现：`stashUsableProviders` 万一自己抛了，`finally` 里也不至于再炸一次
  let restoreProviders: () => void = () => undefined;
  try {
    // 前提同上段：**只剩**「内置 DeepSeek（无密钥）」与本用例这个不需要密钥的本地 endpoint。
    // 不把机器上真实的服务挪开，默认解析可能落到别处，本段就从「验降级」变成「验运气」
    // （2026-09 实测：本机的 `glm` 就是这样抢走了默认解析）。
    restoreProviders = stashUsableProviders();
    deleteSecret("deepseek");
    saveProvider({
      id: PROVIDER_ID,
      name: "Smoke 本地服务",
      baseUrl: "https://example.invalid/v1",
      models: [{ id: MODEL_ID, name: MODEL_NAME, contextWindow: 1000 }],
      requiresKey: false,
    });

    writeOnboardedFlag(app.getPath("userData"));
    window.reload();
    await sleep(4000);

    const providers = listProviders();
    const resolved = resolveSessionModel(null, providers);
    log(`默认解析：${resolved.providerId}/${resolved.modelId}`);
    checks.push(["默认解析落到无需密钥的本地服务", resolved.providerId === PROVIDER_ID]);
    checks.push(["无需密钥的服务被判定为可用", hasUsableProvider(providers)]);

    const list = await run<{ id: string }[]>(
      `window.colt.invoke("session.list", ${JSON.stringify({ projectId })})`,
    );
    log(`列表首条：${list[0]?.id ?? "（空）"}（本用例 ${session.id}）`);
    checks.push(["界面活动会话就是用例建的这条", list[0]?.id === session.id]);

    // App 的模型黄条与 Conversation 的提示都以「尚未配置」开头，一并排除
    const text = await run<string>(`document.body.innerText`);
    const complained = text.includes("尚未配置");
    log(`界面提示：${complained ? "含「尚未配置」" : "（无）"}`);
    checks.push(["界面没有「尚未配置 API Key」的黄条/红错", !complained]);

    const label = await run<string | null>(`(() => {
      const el = document.querySelector("button.model .lbl");
      return el ? el.textContent.trim() : null;
    })()`);
    log(`下拉文案：${label}`);
    checks.push(["模型下拉不带「（未配置密钥）」后缀", label === MODEL_NAME]);

    // 渲染层挂载时会走真实 IPC 打开会话；无密钥被拦下的话这里永远等不到 view
    let opened = false;
    for (let i = 0; i < 20 && !opened; i += 1) {
      opened = sessionManager.getView(session.id) !== null;
      if (!opened) await sleep(500);
    }
    checks.push(["会话已用本地服务打开（worker 已就绪）", opened]);
  } finally {
    log("[model/keyless] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
    sessionManager.close(session.id);
    removeProvider(PROVIDER_ID);
    deleteSecret(PROVIDER_ID);
    if (savedDeepseekKey) setSecret("deepseek", savedDeepseekKey);
    // 最后再还这台机器真实的服务——放最后，保证用户配置是被最后写回的
    restoreProviders();
  }
}

/**
 * 主区提示条与对话区**共存**时的布局（回归：没有可用模型 → 输入卡片的下半行被裁掉）。
 *
 * 症状：无可用模型时主区顶部挂着黄条，对话区却仍按「整个主区」的高度算自己的 h-full，
 * 于是整体下移、从**底部**溢出主区，被 main 的 overflow-hidden 裁掉——输入卡片的工具行
 * （访问模式 / `/compact` / 模型选择 / 发送）正好落在被裁的那一截里，用户看到的是
 * 「输入框下半部分不见了」。
 *
 * 「一个能用的模型服务都没有」没有 API 可开，只能由用例自己造环境：走 `stashUsableProviders()`
 * 把这台机器上真实的服务先变成不可用（无论中间出什么事都在 `finally` 里还回去）。
 * 省掉这步，配过密钥的机器上黄条根本不出现，下面的断言就全变成空跑（假绿）。
 */
export async function runModelNoUsable(
  window: BrowserWindow,
  sessionsDir: string,
  projectId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const checks: [string, boolean][] = [];
  const savedDeepseekKey = getSecret("deepseek");
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}（刻意让所有服务都不可用）`);

  // 先给个空实现：`stashUsableProviders` 万一自己抛了，`finally` 里也不至于再炸一次
  let restoreProviders: () => void = () => undefined;

  /** 布局只量一次；判据全部落在「可见区内」这件事上，别去看 class */
  const probeExpr = `(() => {
    const rect = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        height: Math.round(box.height),
      };
    };
    const area = document.querySelector("textarea");
    const send = document.querySelector('button[title="发送"]');
    const box = send ? send.getBoundingClientRect() : null;
    const hit = box
      ? document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2)
      : null;
    return {
      // 用文案认这条黄条，别用 data-* 标记：这是「环境造对了没」的前提检查，
      // 不能依赖被测的修复本身（否则修好前必然假红，红在哪也看不出来）。同 keyless 的判法。
      notice: document.body.innerText.includes("尚未配置任何模型服务的 API Key"),
      viewport: window.innerHeight,
      // 输入卡片按**它自己的标记**认，**不要**写「输入框的父节点」：
      // v1.44 给 textarea 套了一层 relative 容器（候选浮层要靠它定位），那个猜测当场失效——
      // 量到的会变成那层容器（更小、且恒在卡片内），断言于是**静默变松**，还看不出错在哪。
      // 与下面找 conv 那条（用 closest 找 grid-rows-*）是同一条纪律：别靠层级猜结构。
      card: rect(document.querySelector("[data-conv-card]")),
      tools: rect(document.querySelector(".comp-tools")),
      main: rect(document.querySelector("main")),
      // 对话区根节点：唯一带 grid-rows-* 的祖先，从输入框往上找，不靠层级硬猜
      conv: rect(area ? area.closest('[class*="grid-rows-"]') : null),
      sendHit: Boolean(hit && send && (hit === send || send.contains(hit))),
    };
  })()`;
  interface Probe {
    notice: boolean;
    viewport: number;
    card: { top: number; bottom: number; height: number } | null;
    tools: { top: number; bottom: number; height: number } | null;
    main: { top: number; bottom: number; height: number } | null;
    conv: { top: number; bottom: number; height: number } | null;
    sendHit: boolean;
  }

  try {
    restoreProviders = stashUsableProviders();
    deleteSecret("deepseek");

    writeOnboardedFlag(app.getPath("userData"));
    window.reload();
    await sleep(4000);

    const probe = await run<Probe>(probeExpr);
    log(
      `可视区高 ${probe.viewport}｜黄条 ${probe.notice}｜输入卡片 ${JSON.stringify(probe.card)}｜` +
        `工具行 ${JSON.stringify(probe.tools)}｜对话区 ${JSON.stringify(probe.conv)}｜主区 ${JSON.stringify(probe.main)}`,
    );

    // 前提先立住：黄条没出现的话，后面几条都是空跑
    checks.push(["无可用模型时主区顶部挂出黄条", probe.notice]);
    // 电平式不变量：对话区的底边要**等于**主区底边（相等才说明它正好填满剩余高度；
    // 只判「没变大」会把溢出也算通过——溢出时差值是负的）
    checks.push([
      "对话区没有溢出主区（底边与主区相等）",
      probe.conv !== null && probe.main !== null && Math.abs(probe.main.bottom - probe.conv.bottom) <= 2,
    ]);
    checks.push([
      "对话区仍填满主区剩余高度（flex-1 + h-full 没被弄塌）",
      probe.conv !== null && probe.conv.height > 200,
    ]);
    checks.push([
      "输入卡片完整落在窗口内（下半行不再被裁）",
      probe.card !== null && probe.card.top >= 0 && probe.card.bottom <= probe.viewport,
    ]);
    checks.push([
      "输入卡片的工具行完整可见（模型选择 / 发送都在这行）",
      probe.tools !== null && probe.tools.top >= 0 && probe.tools.bottom <= probe.viewport,
    ]);
    checks.push(["发送按钮落在可视区且命中它自己（没被别的层压住）", probe.sendHit]);
  } finally {
    log("[model/no-usable] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
    sessionManager.close(session.id);
    if (savedDeepseekKey) setSecret("deepseek", savedDeepseekKey);
    // 最后再还这台机器真实的服务——放最后，保证用户配置是被最后写回的
    restoreProviders();
  }
}

/**
 * 「还没用起来的会话」在界面上的行为——一条链，三件事：
 *
 * ① **空项目直接给输入框**：一个会话都没有的项目，中间区不再只显示一句「新建一个会话开始
 *    对话」，而是自动建一条**草稿**（只分配 id：不落库、不 fork worker、不建 JSONL），
 *    于是「打开就见输入框」，不必先跑到侧栏去点「+」。
 * ② **草稿不进侧栏**：`session.create` 过去立刻 INSERT 一行、渲染层又把它插进侧栏，于是
 *    「点了新建就退出」会在侧栏留下一串 `message_count=0`、点开还没反应的空会话（而用户
 *    一个字都没发过）。现在侧栏以库为准，草稿要等**首次发消息落库**后才出现。
 * ③ **转正靠落库时机**：首次发消息时主进程先落库、再拉起 worker，所以「草稿有了进程」
 *    就等价于「它已经落库」——渲染层据此把它拉进侧栏（判据是进程状态，不依赖模型回话）。
 * ④ **起手态的排布与出口**：输入卡片不再贴着会话区底部，而是与提示块一起上移到相对中间
 *    （判据是**几何**：卡片底边到会话区底边的留白远大于贴底时的固定量，不看 class）；
 *    并能一键「新建工作目录」——主进程真的在磁盘上建出目录、登记成项目、界面切过去。
 *
 * 断言全部落在「可观察的事实」上：主进程的会话表、有没有 worker、DOM 里有没有输入框与哪一行。
 * 全程不打模型：provider 指到 example.invalid，只用来让会话「有个模型可用」。
 */
export async function runSessionDraft(
  window: BrowserWindow,
  _sessionsDir: string,
  projectId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const PROVIDER_ID = "smoke-draft-local";
  const checks: [string, boolean][] = [];
  const cwd = process.env.COLT_SMOKE_CWD ?? process.cwd();
  // 起手区「新建工作目录」的落点：由 harness 指到 out/ 下（见 smoke/index.ts 顶部）。
  // 期望值从**同一个环境变量**读出来，不把 out/ 的路径写死在用例里——同源才不会被改漏。
  const scratchRoot = process.env.COLT_WORKSPACE_ROOT ?? "";
  const savedDeepseekKey = getSecret("deepseek");
  // 另起一个**空**项目：只有它一个会话都没有，才谈得上「打开就见输入框」。
  // 路径固定（不随机），免得每跑一次就往库里多塞一行项目记录。
  const emptyDir = join(process.cwd(), "out", "smoke-draft-empty-fixture");
  mkdirSync(emptyDir, { recursive: true });
  const emptyProject = upsertProject(emptyDir);
  // 最后 upsert 的那个项目即 `project.list[0]`（ORDER BY last_opened_at DESC），
  // 也就是渲染层挂载/重载时会自动打开的那个——这正是本用例要的入口。
  let draftId: string | null = null;

  /** 中间区此刻的输入卡片。草稿不进侧栏，它的 id 只能从这里认（见 data-conv-session） */
  const probeCard = `(() => {
    const card = document.querySelector("[data-conv-card]");
    return {
      session: card ? card.getAttribute("data-conv-session") : null,
      hasInput: Boolean(card && card.querySelector("textarea")),
      rows: document.querySelectorAll("[data-session-row]").length,
    };
  })()`;

  /**
   * 起手态的排布：提示块、输入卡片，以及它们相对**会话区**（那一格网格）的位置。
   *
   * 会话区按「输入卡片往上最近的那个带 grid-rows-* 的祖先」认，与 model/no-usable 同一条
   * 找法：不靠层级硬猜结构（AGENTS.md §五⑫）。
   */
  const startProbe = `(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const card = document.querySelector("[data-conv-card]");
    const root = card ? card.closest('[class*="grid-rows-"]') : null;
    const dir = document.querySelector("[data-conv-workdir]");
    return {
      start: box(document.querySelector("[data-conv-start]")),
      card: box(card),
      root: box(root),
      workdir: dir ? dir.textContent : null,
    };
  })()`;
  interface StartProbe {
    start: { top: number; bottom: number } | null;
    card: { top: number; bottom: number } | null;
    root: { top: number; bottom: number } | null;
    workdir: string | null;
  }

  /** 该项目行里的「+」。按 data-project-row 认项目，不按 DOM 顺序猜（多项目时顺序会变） */
  const newButton = (projectRowId: string): string =>
    `document.querySelector('[data-project-row="${projectRowId}"]')?.querySelector('button[title="新建会话"]')`;

  // 环境前提显式建立（AGENTS.md §五⑬）：这个项目必须真的空。上一轮跑崩了（没走到 finally）
  // 会留下残余会话，那时前提不成立、用例只会以一条**假红**收场——先清干净。
  for (const stale of listSessions(emptyProject.id)) {
    sessionManager.close(stale.id);
    deleteSession(stale.id);
  }

  // 前置：把还在跑的会话收掉（它们会持续 touch updated_at），并让模型解析落到一个
  // 不存在的 endpoint 上——只为本用例避免真的打外部 API，与草稿本身无关。
  for (const other of listSessions(projectId)) {
    for (let i = 0; i < 40 && sessionManager.isRunning(other.id); i += 1) await sleep(500);
    sessionManager.close(other.id);
  }
  deleteSecret("deepseek");
  saveProvider({
    id: PROVIDER_ID,
    name: "Smoke 草稿用例服务",
    baseUrl: "https://example.invalid/v1",
    models: [{ id: "smoke-draft-model", name: "Smoke 草稿模型", contextWindow: 1000 }],
    requiresKey: false,
  });

  try {
    writeOnboardedFlag(app.getPath("userData"));
    window.reload();
    await sleep(4000);

    const opened = await run<{ session: string | null; hasInput: boolean; rows: number }>(probeCard);
    log(
      `打开空项目后：输入框=${opened.hasInput}，当前会话=${opened.session ?? "（无）"}，侧栏行数=${opened.rows}`,
    );
    checks.push(["一个按钮都没点，输入框就已经在（空项目自动给草稿）", opened.hasInput]);
    checks.push(["侧栏没有会话行（草稿不进侧栏）", opened.rows === 0]);
    checks.push(["自动建的那条草稿没有落库", listSessions(emptyProject.id).length === 0]);
    draftId = opened.session;

    // ---- 起手态：输入框上移到相对中间，并且能换目录 / 建目录 ----
    const start = await run<StartProbe>(startProbe);
    log(
      `起手态：提示块 ${JSON.stringify(start.start)}｜输入卡片 ${JSON.stringify(start.card)}｜` +
        `会话区 ${JSON.stringify(start.root)}｜目录 ${start.workdir ?? "（无）"}`,
    );
    checks.push([
      "空项目的中间区是起手提示块 + 输入卡片（不是空白，也不是干等）",
      start.start !== null && start.card !== null,
    ]);
    checks.push([
      "提示块在输入卡片上方（两块是一个整块）",
      start.start !== null && start.card !== null && start.start.bottom <= start.card.top,
    ]);
    // 「不再贴底」的判据：卡片底边到会话区底边留下的空隙，应**远大于**贴底时的固有高度
    // （Live Bar + 内边距 ≈ 44px，与窗口尺寸无关）。窗口固定 1440×900，起手态这段留白实测
    // 248px（会话区 42→864、卡片底 616），取 150 作阈值：既咬得住「回退成贴底」，
    // 也不会因为提示块多一行就红。
    checks.push([
      "输入卡片不再贴着会话区底部（上移到相对中间）",
      start.root !== null && start.card !== null && start.root.bottom - start.card.bottom > 150,
    ]);
    checks.push([
      "起手区显示的目录就是这条会话的项目目录",
      (start.workdir ?? "").includes("smoke-draft-empty-fixture"),
    ]);
    // 小目标入口照例做命中测试：只查「在 DOM 里」发现不了「被顶出可视区 / 上面盖着别的元素」
    const newdirHit = await run<string>(`(() => {
      const btn = document.querySelector("[data-conv-newdir]");
      if (!btn) return "missing";
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return "zero-size";
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at && (at === btn || btn.contains(at)) ? "ok" : "blocked";
    })()`);
    checks.push([`「新建工作目录」按钮落在可视区且命中它自己（${newdirHit}）`, newdirHit === "ok"]);

    // 什么都不选时的一键出口：点它 → 主进程建目录 + 登记项目 → 界面切过去。
    // 落点由 harness 指到 out/ 下且**固定**，所以这里既不碰真实家目录，也不会攒目录/项目行。
    if (scratchRoot) {
      await run(`(() => { document.querySelector("[data-conv-newdir]")?.click(); return null; })()`);
      let switched: StartProbe | null = null;
      for (let i = 0; i < 20; i += 1) {
        switched = await run<StartProbe>(startProbe);
        if (switched.workdir === scratchRoot) break;
        await sleep(400);
      }
      const registered = listProjects().some((item) => item.rootPath === scratchRoot);
      log(
        `点「新建工作目录」后：界面目录=${switched?.workdir ?? "（无）"}｜已登记项目=${registered}`,
      );
      checks.push(["新工作目录真的建在磁盘上", existsSync(scratchRoot)]);
      checks.push(["它已登记成项目（下次不必重造）", registered]);
      checks.push(["界面上的工作目录换成了新目录", switched?.workdir === scratchRoot]);
      checks.push([
        "换目录后仍是起手态（新项目也没有会话，输入卡片留在中间）",
        Boolean(switched?.start),
      ]);
    } else {
      log("跳过「新建工作目录」：未设 COLT_WORKSPACE_ROOT，环境前提未建立（AGENTS.md §五⑬）");
    }

    // 那个 + 平时是 opacity-0、靠 hover 显形，所以必须做命中测试：只查「在 DOM 里」
    // 发现不了「被顶出可视区 / 上面盖着别的元素」（小目标入口的老坑）。
    const hit = await run<{ found: boolean; top: boolean }>(`(() => {
      const btn = ${newButton(emptyProject.id)};
      if (!btn) return { found: false, top: false };
      const r = btn.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { found: true, top: Boolean(at && (at === btn || btn.contains(at))) };
    })()`);
    checks.push(["侧栏「新建会话」按钮真的在可视区且可点", hit.found && hit.top]);

    await run(`(() => { ${newButton(emptyProject.id)}?.click(); return null; })()`);
    await sleep(800);

    const clicked = await run<{ session: string | null; hasInput: boolean; rows: number }>(probeCard);
    log(
      `点「+」后：输入框=${clicked.hasInput}，当前会话=${clicked.session ?? "（无）"}，侧栏行数=${clicked.rows}`,
    );
    checks.push(["点「+」后侧栏依然没有多出会话", clicked.rows === 0]);
    checks.push([
      "点「+」后当前会话换成了新的一条草稿",
      clicked.session !== null && clicked.session !== draftId,
    ]);
    checks.push(["点「+」后库里仍然没有它", listSessions(emptyProject.id).length === 0]);

    // 首次发消息：到这一步才落库（走的就是生产的 session.prompt 通道）
    draftId = clicked.session;
    const outcome = await run<string>(
      `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: draftId, text: "hi", cwd: emptyDir })})
        .then(() => "OK").catch((e) => String((e && e.message) || e))`,
    );
    log(`首次发消息结果：${outcome}`);
    checks.push(["首次发消息未被挡下", outcome === "OK"]);
    checks.push(["发消息后草稿已落库", draftId !== null && getSession(draftId) !== undefined]);

    let workerReady = false;
    for (let i = 0; i < 20 && !workerReady; i += 1) {
      workerReady = draftId !== null && sessionManager.getView(draftId) !== undefined;
      if (!workerReady) await sleep(500);
    }
    checks.push(["发消息后会话已打开（worker 就绪）", workerReady]);

    // 转正：落库后它就该出现在侧栏里（此前草稿是不显示的）。这是本用例的落点——
    // 「侧栏该显示什么」由**落库时机**决定，不由「点没点过新建」决定。
    let appeared = false;
    for (let i = 0; i < 20 && !appeared; i += 1) {
      appeared = await run<boolean>(
        `Boolean(document.querySelector('[data-session-row="${draftId}"]'))`,
      );
      if (!appeared) await sleep(500);
    }
    checks.push(["落库后侧栏出现了这条会话（转正）", appeared]);
  } finally {
    log("[session/draft] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
    // 把这个项目还给「空」：否则下次跑到这里，「打开就见输入框」的前提就不成立了
    for (const leftover of listSessions(emptyProject.id)) {
      sessionManager.close(leftover.id);
      deleteSession(leftover.id);
    }
    if (draftId) sessionManager.close(draftId);
    removeProvider(PROVIDER_ID);
    deleteSecret(PROVIDER_ID);
    if (savedDeepseekKey) setSecret("deepseek", savedDeepseekKey);
    // 把仓库项目顶回 project.list[0]：渲染层挂在空夹具项目上没有意义，
    // 后面的用例（以及下次运行）该看到的是真实项目。
    upsertProject(cwd);
  }
}

/**
 * 夹具端到端用例：把浏览器能力一次跑完，全程不依赖外部网络。
 *
 * 覆盖 navigate / snapshot / console / network / wait(load|text|idle) / viewport /
 * upload / downloads / 弹窗拦截——这些都必须落在「真实页面 + 真实文件系统」上，
 * 单测覆盖不到；这里直接驱动 hostBridge（不经模型），把模型随机性排除在结论之外。
 *
 * 靶子由 scripts/fixture-server.mjs 提供，与「手动体验」共用同一份页面，因此用例与
 * 人工验证不会出现两套说法；以 port 0 拉起，跑完即关。
 */
