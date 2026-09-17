/**
 * 端到端冒烟
 * basic：建项目 → 建会话 → 真实对话 → 截图
 * advanced：多会话并行 → 分支查询 → navigateTree 分叉 → 截图
 * fixture：以本地夹具站为靶子，不开模型跑完浏览器能力（观测 + 上传下载 + 弹窗拦截）
 * dock：工作区（右栏）界面行为——折叠/展开、拖拽调宽与上下限、宽度记忆、⑦-F 自动展开、
 *       ⑦-G 的「正在处理」（进行中的动作 + 底部总账）与它的下钻（清单 → diff → 内容）、
 *       点文件路径 → 下钻内容层（工具卡入口）、页签关闭与「+」新增视图、
 *       面板迁入页签（A3-5 / ⑦-H / ⑦-G：「工具」「改动」「文件」三个视图都取消后只剩统计与规则）、
 *       观测抽屉（B2）与它的**条目详情**（N1：点行展开完整字段 + 复制到剪贴板）、
 *       浏览器前进/后退/刷新（B1），以及 ⑥ Live Bar 的运行状态段（C1/C2：已中断 / 已失败 / 空闲）
 * model：未开启会话（无 worker）时也能选模型——落库的选定值照样回显、切换立即生效；
 *        以及**没有可用模型**时主区黄条与对话区共存（输入卡片的下半行不能被裁掉）
 * memory：跨会话记忆检索（L3a）的真实跨进程链路——不开模型：真实 worker 起动即上报
 *        memoryIndex → 主进程落派生库（data/memory.db）→ hostBridge memory 检索；
 *        另验二字词 LIKE 兜底（FTS trigram 3 字下限）、项目隔离、关会话清检索上下文
 * memory-e2e：记忆行为的真实调用验证（**打模型、计费**）——注入可见性（不读文件答密语）、
 *        沉淀落盘+索引同步、/memory-tidy 整理（合并/删过时/归档/通知/改动记录）、
 *        冷层检索（现行文件已删的条目仍能被 memory_search 答出）
 */
import { app, BrowserWindow, clipboard, nativeImage, WebContentsView } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  upsertProject,
  createSession,
  deleteSession,
  getProject,
  getSession,
  listSessionFileChanges,
  listSessions,
  recordFileBaseline,
  setSessionModel,
} from "./db/repo";
import { hostBridge } from "./host";
import { sessionManager } from "./session-manager";
import { normalizeRootKey } from "./db/index";
import {
  indexMemorySnapshot,
  isFts5Available,
  openMemoryDatabase,
  searchMemory,
  type MemoryHit,
} from "./db/memory-index";
import { listProviders, removeProvider, saveProvider } from "./providers";
import { deleteSecret, getSecret, setSecret } from "./secrets";
import { writeOnboardedFlag } from "./first-run";
import { hasUsableProvider, resolveSessionModel } from "@shared/model-ref";
import { join, resolve } from "node:path";
import type { ConversationView, HostResult, ViewFileChange } from "@shared/worker-protocol";
import type { ApprovalRequest } from "@shared/protocol";
import { DEFAULT_THINKING_LEVEL } from "@shared/thinking-level";
// 夹具站与「手动体验」共用同一份页面（scripts/fixture-server.mjs 是唯一数据源），
// 以 port 0 在进程内拉起，跑完即关，用例因此不依赖任何外部站点
import { createFixtureServer } from "../../scripts/fixture-server.mjs";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 主进程里未捕获的异常。
 *
 * 有些错误是在用例之外异步抛出的（典型如窗口 closed 回调访问了已销毁的 webContents）：
 * 它不打断用例，总要等到用例记完结论之后才冒出来，把「21/21 通过」变成假绿。
 * 所以这里显式收口，由用例正文断言其为空。
 */
const uncaughtErrors: string[] = [];

/**
 * 本次冒烟**归一化后**的产物路径（由调用方 launcher 算好，恒在 out/ 下）。
 * 用例内部需要派生伴生产物（如「待审截图」）时读它，而不是再读 COLT_SMOKE ——
 * 否则派生文件会绕过归一化，重新落回仓库根目录。
 */
let activeOutputPath = "";

/**
 * 生成纯红色 PNG（base64，不含 data URI 前缀）。
 * 用于验证「用户发图 → 模型看图」：颜色是确定的，模型答对即证明图片真的送达了。
 */
function makeSolidPng(size: number): string {
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

export async function runSmoke(window: BrowserWindow, outputPath: string): Promise<void> {
  // outputPath 由 launcher 归一化到 out/ 下（见 index.ts 的 smokeArtifactPath）
  activeOutputPath = outputPath;
  // 同时落盘：Windows 上 Electron 主进程 stdout 不接父终端，只看控制台会丢日志。
  // 每行立即追加，保证卡死时也能看到「卡在哪一步」，而不是等 finally 才写出。
  const lines: string[] = [];
  const logFile = `${outputPath}.log`;
  try {
    writeFileSync(logFile, "", "utf8");
  } catch {
    // 清理旧日志失败不影响后续
  }
  const log = (message: string): void => {
    const line = `[SMOKE] ${message}`;
    lines.push(line);
    console.log(line);
    try {
      appendFileSync(logFile, `${line}\n`, "utf8");
    } catch {
      // 增量落盘失败不中断流程
    }
  };
  // Electron 默认把未捕获异常弹成对话框：自动化跑的时候没人能点它，日志里也留不下证据。
  // 这里接管掉，改为记进日志由用例正文断言。
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    uncaughtErrors.push(detail);
    log(`未捕获异常：${detail.split("\n").slice(0, 3).join(" | ")}`);
  });
  // 兜底超时：executeJavaScript 若因渲染层 reload / IPC 未回包而永不 settle，
  // 会让整个冒烟永久挂起（表现为窗口静止、无任何日志）。超时后至少能报出卡点。
  const run = <T>(expression: string, timeoutMs = 60_000): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`executeJavaScript 超时（${timeoutMs}ms）：${expression.slice(0, 80)}`)),
        timeoutMs,
      );
      window.webContents.executeJavaScript(expression).then(
        (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });

  // 转发渲染层控制台：界面空白时只有这里能拿到真实报错
  window.webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") {
      console.log(`[RENDERER:${details.level}] ${details.message}`);
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.log(`[RENDERER] 进程退出：${details.reason}`);
  });

  try {
    const projectRoot = process.env.COLT_SMOKE_CWD ?? process.cwd();
    const project = upsertProject(projectRoot);
    log(`项目：${project.name} (${project.rootPath})`);

    const sessionsDir = join(app.getPath("userData"), "sessions", project.id);
    const mode = process.env.COLT_SMOKE_MODE;

    if (mode === "fixture") {
      await runFixture(projectRoot, log);
      // 刻意不截图：这条探针全程没让主窗口重绘过，此时 capturePage 会把主进程拖住不返回
      // （实测连 setTimeout 都不再触发）。结论以 .log 为准，截图对它没有价值。
      log("DONE");
      return;
    }

    if (mode === "host") {
      await runHost(window, project.id, sessionsDir, log, run);
    } else if (mode === "advanced") {
      await runAdvanced(window, project.id, sessionsDir, log, run);
    } else if (mode === "approval") {
      await runApproval(window, project.id, sessionsDir, log, run);
    } else if (mode === "reenter") {
      await runReenter(window, project.id, sessionsDir, log, run);
    } else if (mode === "crash") {
      await runCrash(window, project.id, sessionsDir, log, run);
    } else if (mode === "memory") {
      await runMemory(log, run);
    } else if (mode === "memory-e2e") {
      await runMemoryE2e(window, log, run);
    } else if (mode === "dock") {
      await runDock(window, project.id, sessionsDir, log, run);
    } else if (mode === "model") {
      await runModelSelect(window, sessionsDir, project.id, log, run);
      await runModelFallback(window, sessionsDir, project.id, log, run);
      await runModelKeyless(window, sessionsDir, project.id, log, run);
      await runModelNoUsable(window, sessionsDir, project.id, log, run);
      await runModelSwitchDuringOpen(window, sessionsDir, project.id, log, run);
      await runSessionDraft(window, sessionsDir, project.id, log, run);
    } else {
      await runBasic(window, sessionsDir, project.id, log, run);
    }

    const image = await window.capturePage();
    await writeFile(outputPath, image.toPNG());
    log(`截图：${outputPath}`);
    log("DONE");
  } catch (error) {
    console.error("[SMOKE] 失败", error);
    lines.push(`[SMOKE] 失败 ${String(error)}`);
  } finally {
    try {
      await writeFile(`${outputPath}.log`, lines.join("\n"), "utf8");
    } catch {
      // 日志落盘失败不影响结论
    }
    app.quit();
  }
}

async function runBasic(
  window: BrowserWindow,
  sessionsDir: string,
  projectId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}`);

  window.reload();
  await sleep(4000);

  const prompt = process.env.COLT_SMOKE_PROMPT ?? "用一句话介绍你自己。";
  log(`发送：${prompt}`);
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text: prompt })})`,
  );

  await sleep(Number(process.env.COLT_SMOKE_WAIT ?? 20000));

  // 展开工具卡片，让验收截图能看到实际输出
  // 注意：不能用「改动」字样匹配，会误中顶部导航标签
  await run(`(() => {
    const buttons = [...document.querySelectorAll("button")];
    buttons.filter((b) => /^\\s*(bash|edit|write|read)\\b/.test(b.textContent.trim()))
      .forEach((b) => b.click());
    return true;
  })()`);
  await sleep(800);

  // 可选：打开右侧某个面板，便于验收截图覆盖该面板。按**会话头按钮文案**匹配（现在是「统计 / 规则」）——
  // 「改动」「工具」的会话头入口已按 ⑦-H 删除，需要时从 ⑦ 的「+」菜单开。
  const panel = process.env.COLT_SMOKE_PANEL;
  if (panel) {
    await run(`(() => {
      const target = ${JSON.stringify(panel)};
      const buttons = [...document.querySelectorAll("button")];
      const hit = buttons.find((b) => b.textContent.trim() === target);
      if (hit) hit.click();
      return hit !== undefined;
    })()`);
    await sleep(1200);
  }

  await report(session.id, log, run);
}

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
async function runModelSelect(
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
function stashUsableProviders(): () => void {
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
async function runModelFallback(
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
async function runModelSwitchDuringOpen(
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
async function runModelKeyless(
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
async function runModelNoUsable(
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
 * 新建会话是**草稿**：只分配 id，不写库、不 fork worker、不建 JSONL，首次发消息才落库。
 *
 * 回归背景：`session.create` 过去立刻 INSERT 一行，于是「点了新建就退出」会在侧栏留下
 * 一串 message_count=0、点开还没反应的空会话（而用户一个字都没发过）。
 *
 * 断言全部落在「可观察的事实」上：主进程的会话表、有没有 worker、侧栏有没有那一行。
 */
async function runSessionDraft(
  window: BrowserWindow,
  _sessionsDir: string,
  projectId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const PROVIDER_ID = "smoke-draft-local";
  const checks: [string, boolean][] = [];
  const cwd = process.env.COLT_SMOKE_CWD ?? process.cwd();
  const savedDeepseekKey = getSecret("deepseek");
  let draftId: string | null = null;

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

  const before = listSessions(projectId).length;
  log(`新建前会话数：${before}`);

  /** 侧栏里「新建会话」按钮（项目行上的 +） */
  const findNewButton = `[...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("title") === "新建会话",
  )`;

  try {
    writeOnboardedFlag(app.getPath("userData"));
    window.reload();
    await sleep(4000);

    // 那个 + 平时是 opacity-0、靠 hover 显形，所以必须做命中测试：只查「在 DOM 里」
    // 发现不了「被顶出可视区 / 上面盖着别的元素」（小目标入口的老坑）。
    const hit = await run<{ found: boolean; top: boolean }>(`(() => {
      const btn = ${findNewButton};
      if (!btn) return { found: false, top: false };
      const r = btn.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { found: true, top: Boolean(at && (at === btn || btn.contains(at))) };
    })()`);
    checks.push(["侧栏「新建会话」按钮真的在可视区且可点", hit.found && hit.top]);

    await run(`(() => { ${findNewButton}?.click(); return null; })()`);
    await sleep(800);

    // 侧栏是「新会话插在最前」，因此第一条就是它；行上有 data-session-row 便于取 id
    const rows = await run<(string | null)[]>(
      `[...document.querySelectorAll("[data-session-row]")].map((el) => el.getAttribute("data-session-row"))`,
    );
    draftId = rows[0] ?? null;
    log(`侧栏首条：${draftId ?? "（无）"}（共 ${rows.length} 行，期望 ${before + 1}）`);
    checks.push(["侧栏出现新建的那条会话", draftId !== null && rows.length === before + 1]);

    // 本用例的核心：此刻它还**没有**落库
    checks.push([
      "草稿尚未写入 sessions 表",
      draftId !== null && getSession(draftId) === undefined,
    ]);
    checks.push(["草稿没有 worker（没 fork 进程）", draftId !== null && sessionManager.getView(draftId) === undefined]);

    const afterCreate = listSessions(projectId).length;
    log(`新建后会话数：${afterCreate}`);
    checks.push(["session.list 里看不到草稿", afterCreate === before]);

    // 首次发消息：到这一步才落库（走的就是生产的 session.prompt 通道）
    const outcome = await run<string>(
      `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: draftId, text: "hi", cwd })})
        .then(() => "OK").catch((e) => String((e && e.message) || e))`,
    );
    log(`首次发消息结果：${outcome}`);
    checks.push(["首次发消息未被挡下", outcome === "OK"]);
    checks.push(["发消息后草稿已落库", draftId !== null && getSession(draftId) !== undefined]);

    let opened = false;
    for (let i = 0; i < 20 && !opened; i += 1) {
      opened = draftId !== null && sessionManager.getView(draftId) !== undefined;
      if (!opened) await sleep(500);
    }
    checks.push(["发消息后会话已打开（worker 就绪）", opened]);
  } finally {
    log("[session/draft] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
    if (draftId) {
      sessionManager.close(draftId);
      deleteSession(draftId);
    }
    removeProvider(PROVIDER_ID);
    deleteSecret(PROVIDER_ID);
    if (savedDeepseekKey) setSecret("deepseek", savedDeepseekKey);
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
async function runFixture(projectRoot: string, log: (message: string) => void): Promise<void> {
  const sessionId = "smoke-fixture";
  const payloadName = "colt-payload.txt";
  const payloadBody = "colt download fixture\n";
  const uploadPath = join(projectRoot, "package.json");

  const server = await createFixtureServer({ port: 0 });
  log(`夹具站：${server.url}`);

  const checks: [string, boolean][] = [];
  try {
    const call = (action: string, params: Record<string, unknown> = {}): Promise<HostResult> =>
      hostBridge.handle({ sessionId, capability: "browser", action, params });

    log(`navigate：${(await call("navigate", { url: server.url })).text}`);

    // snapshot 按可见文案认领各靶元素，避免把 ref 序号写死（页面加元素就会错位）
    const snapshot = await call("snapshot");
    const refOf = (label: string): string | undefined =>
      new RegExp(`\\[(e\\d+)\\] (?:a|button|input) "${label}"`).exec(snapshot.text)?.[1];
    const uploadRef = refOf("选择要上传的文件");
    const downloadRef = refOf("下载测试文件");
    const popupRef = refOf("打开新窗口");
    const logRef = refOf("触发控制台告警");
    const netRef = refOf("触发请求失败");
    const lateRef = refOf("延迟 1.5 秒出现文本");
    log(`refs：input=${uploadRef} 下载=${downloadRef} 弹窗=${popupRef} 控制台=${logRef} 网络=${netRef} 延迟=${lateRef}`);
    checks.push([
      "snapshot 找到全部靶元素",
      [uploadRef, downloadRef, popupRef, logRef, netRef, lateRef].every((ref) => ref !== undefined),
    ]);

    // 观测基线：导航本身会产生一条文档请求，且 dev 期 Electron 会注入一条 CSP 安全告警，
    // 所以这里不要求「完全为空」，而是要求「没有 error、没有失败请求」。
    const initialConsole = (await call("console")).text;
    checks.push(["console 初始无 error", !/\[error\]/.test(initialConsole)]);
    const initialNetwork = (await call("network")).text;
    checks.push(["network 初始无失败请求", initialNetwork.includes("未发现失败")]);
    checks.push(["downloads 初始为空态", (await call("downloads")).text.includes("尚未触发任何下载")]);
    // 打全原文：断言失败时，看得到「到底多了什么」才排得动
    log(`初始 console：\n${initialConsole}`);
    log(`初始 network：\n${initialNetwork}`);

    const idle = await call("wait", { mode: "idle", timeoutMs: 8000 });
    checks.push(["wait(idle) 收敛", idle.text.includes("等待完成")]);
    log(`wait(idle)：${idle.text}`);

    // 控制台：点按钮后应同时拿到 error 与 warning，且 error 不被淹没
    await call("click", { ref: logRef });
    await sleep(400);
    const consoleText = (await call("console")).text;
    checks.push(["console 捕获 error", consoleText.includes("[error] 夹具：这是一条脚本报错")]);
    checks.push(["console 捕获 warning", consoleText.includes("[warning] 夹具：这是一条废弃 API 告警")]);

    // 网络：点按钮后应看到 404 / 500 / 连接失败三类，各自归类
    await call("click", { ref: netRef });
    await sleep(1500);
    const networkText = (await call("network")).text;
    checks.push(["network 捕获 404", /\[404\] GET http:\/\/127\.0\.0\.1:\d+\/api\/missing/.test(networkText)]);
    checks.push(["network 捕获 500", /\[500\] GET http:\/\/127\.0\.0\.1:\d+\/api\/boom/.test(networkText)]);
    checks.push(["network 捕获网络错误", /错误 net::ERR_/.test(networkText)]);
    log(`network：${networkText.split("\n").slice(0, 2).join(" | ")}`);

    // wait(text)：等页面延迟出现的文本
    await call("click", { ref: lateRef });
    const waited = await call("wait", { mode: "text", text: "延迟内容已出现", timeoutMs: 8000 });
    checks.push(["wait(text) 等到目标文本", waited.text.includes("等待完成")]);
    log(`wait(text)：${waited.text}`);

    // viewport：窄屏应触发响应式重排，恢复后回到宽屏
    await call("viewport", { width: 375, height: 700 });
    await sleep(400);
    checks.push(["viewport 窄屏生效", (await call("text")).text.includes("窄屏")]);
    await call("viewport", {});
    await sleep(400);
    checks.push(["viewport 恢复宽屏", (await call("text")).text.includes("宽屏")]);

    // 上传：真实文件交给 input，页面回调再把文件名写回 DOM——两端都能查证
    const upload = await call("upload", { ref: uploadRef, paths: [uploadPath] });
    log(`upload：${upload.text}`);
    checks.push(["upload 回报成功", upload.text.includes("已向") && upload.text.includes("package.json")]);
    checks.push(["页面收到文件名", (await call("text")).text.includes("已选择：package.json")]);

    // 下载：点真实链接，等 will-download 落盘（页面触发到落盘有延迟，轮询到出现为止）
    await call("click", { ref: downloadRef });
    let downloads = "";
    for (let i = 0; i < 40; i += 1) {
      await sleep(200);
      downloads = (await call("downloads")).text;
      if (!downloads.includes("尚未触发")) break;
    }
    checks.push(["downloads 记录到下载", downloads.includes(payloadName)]);
    checks.push(["console 回报下载完成", (await call("console")).text.includes("已下载文件")]);

    // ---- B2：观测抽屉的数据源（`browser.observe` 的结构化快照）----
    // 抽屉读的与 browser_read 是**同一份** CaptureBuffer，所以这里拿结构化字段去对上面那些
    // 文本判据：哪天 observe 换了数据源或漏了某类，这条会先红，而不是等到界面上「看着不太对」。
    // 必须放在弹窗那步**之前**——接管新窗口会 capture.reset()，清掉控制台与网络。
    const observed = hostBridge.browserObservation(sessionId);
    checks.push([
      "browser.observe 结构化控制台含 error 与 warning",
      observed.loaded &&
        observed.console.some((item) => item.level === "error") &&
        observed.console.some((item) => item.level === "warning"),
    ]);
    checks.push([
      "browser.observe 结构化网络含 404 / 500 / 网络错误",
      observed.network.some((item) => item.statusCode === 404) &&
        observed.network.some((item) => item.statusCode === 500) &&
        observed.network.some((item) => item.error !== undefined),
    ]);
    checks.push([
      "browser.observe 结构化下载含已落盘那条",
      observed.downloads.some(
        (item) => item.filename.endsWith(payloadName) && item.state === "completed",
      ),
    ]);
    log(
      `observe：console ${observed.console.length} / network ${observed.network.length} / downloads ${observed.downloads.length}`,
    );

    // 最硬的判据：文件真的躺在磁盘上，且内容与夹具一致
    const savedPath = join(app.getPath("userData"), "browser-downloads", sessionId, `1-${payloadName}`);
    const saved = existsSync(savedPath) ? readFileSync(savedPath, "utf8") : "";
    checks.push(["下载文件已落盘", saved === payloadBody]);
    log(`落盘文件：${savedPath}（${saved.length} 字节）`);

    // 弹窗拦截：target=_blank 不另开窗口，在当前窗口接管
    const windowsBefore = BrowserWindow.getAllWindows().length;
    await call("click", { ref: popupRef });
    await sleep(1000);
    checks.push(["弹窗在当前窗口接管", (await call("url")).text.includes("/popup.html")]);
    checks.push(["弹窗拦截有提示", (await call("console")).text.includes("拦截新窗口请求，已在当前窗口打开")]);
    checks.push(["未新开窗口", BrowserWindow.getAllWindows().length === windowsBefore]);

    // 关闭会话：destroy 会触发窗口的 closed 回调，而该回调是异步执行的——若它访问了已销毁的
    // 对象，异常会落在用例之后才抛，把结论变成假绿。所以这里等一拍并显式断言。
    hostBridge.disposeSession(sessionId);
    await sleep(300);
    checks.push(["关闭会话未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    // 先出结论再清理：清理若出岔子，也不该把已经拿到的证据一起吞掉
    log("[fixture] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);

    // 不 await：进程由 app.quit() 收尾，避免关停环节把已得出的结论拖住
    void server.close();
  }
}

/**
 * 工作区（右栏）端到端冒烟：把 A1/A2/A3 的界面行为放到**真实渲染层**上验证。
 *
 * 为什么必须有这一条：拖拽、折叠、以及「折叠时原生视图必须同步收起」都横跨
 * 「渲染层 DOM ↔ 主进程 WebContentsView」两层，纯逻辑单测覆盖不到；而肉眼截图又
 * 看不见浮在渲染层之上的原生视图。这里两条腿一起走：
 *   1) 在主进程里用 executeJavaScript 驱动渲染层 DOM，并**真派发鼠标事件**模拟拖拽；
 *   2) 读主进程侧 WebContentsView 的 `getVisible()`——折叠是否真的收起视图，只有它说了算。
 *
 * ⑦-G 的「正在处理」（进行中的动作 + 底部总账）同样用**真实的事件通道**（`session.view`）推一个
 * **受控视图**来驱动：不跑模型，但走的是产品里一模一样的那条链路（事件 → DOM → 点击 → 落点）。
 * ⑦-G 第四步之后「点文件路径 → 预览」落进「正在处理」的下钻**内容层**（工具卡是唯一入口），
 * 而「本次改动」成了同一处的下钻**清单层**——原「改动」「文件」两个页签都已取消，
 * 故这两件事在同一段里连起来验：总账 → 清单 → diff → 内容，再逐层退回去。
 * 越界路径与「工具卡传绝对路径」也顺带钉一下。
 *
 * A3-3 的「页签关闭 + 「+」新增视图」同样在这里验：关闭**激活**页签后激活位是否交还默认视图、
 * 以及**关闭「浏览器」后原生视图是否真的收起 / 重开是否重新可见**
 * （这条又是截图看不见的——原生视图的可见性只有主进程知道）。
 *
 * A3-4 的「清单层」验三件容易出错的：目录分组是否正确（一层目录标签，不是可折叠树）、
 * **越界条目是否被排除并如实计数**（放进去就是死条目）、以及**逐层回退是否真的回得去**
 * （面包屑 / 底部「返回」/ ESC 三条出口）。
 * 原「本次改动树」的窄栏容器查询已随树一起作废（`styles.css` 里的 `.file-view` / `fv-tree` 已删）。
 *
 * A3-5 的「面板迁入页签」验的是**迁移动到位**：② 的入口点下去之后，面板真的渲染在 ⑦ 内
 * （按工作区正文判定，而非断言某个 class）、页签数量随之增加、新页签都能关且能重开；
 * 最硬的一条是 **`aside` 数不变**——迁入前每开一个面板就会多一个中栏浮层 `aside`，
 * 迁入后多开面板 `aside` 数仍与开局一致。
 * ⑦-H / ⑦-G 之后 ② 只剩「统计 / 规则」两个入口，⑦ 的「+」菜单也只剩三项。
 *
 * 不调用模型、不产生计费；浏览器靶子复用夹具站（port 0，跑完即关）。
 *
 * B2 的「观测抽屉」验的是**同一份数据能否从主进程走到界面**：先在真实夹具页上点出
 * 控制台报错 / 请求失败 / 下载，再断言抽屉把三类都显示了（计数徽标 + 行文本）。
 * 其中「收起抽屉后原生视图 bounds 变高」是截图看不出来的那条——抽屉占的是页面区域的高度，
 * 只改 DOM 不上报矩形，页面就会被裁掉一块。
 *
 * B1 的「前进 / 后退 / 刷新」验的是**用户自己那条链路**：先在夹具站里真实加载第二页造出历史，
 * 再点界面上的按钮（渲染层点击 → IPC → 主进程 navigationHistory），判据取主进程读到的真实 URL。
 * 按钮的可用性也必须跟着历史走——「退到最早一页时后退必须变灰」正是最容易漏的那种状态。
 */
async function runDock(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  const server = await createFixtureServer({ port: 0 });
  /** 夹具站那次下载的落盘文件名（B2 用它判「下载页签有没有列出这条」） */
  const payloadName = "colt-payload.txt";
  log(`会话：${session.id}`);
  log(`夹具站：${server.url}`);

  const checks: [string, boolean][] = [];
  /** 与 Conversation/index.tsx 的 MIN_DOCK_WIDTH / MIN_CENTER_WIDTH 保持一致 */
  const MIN_DOCK = 220;
  const MIN_CENTER = 360;
  /** 与 WorkspaceDock.tsx 的 DOCK_DEFAULT_WIDTH 保持一致（未拖拽时的统一宽度，不随页签变） */
  const DEFAULT_DOCK = 544;
  const clamp = (px: number, space: number): number =>
    Math.min(Math.max(MIN_DOCK, px), Math.max(MIN_DOCK, space - MIN_CENTER));

  /** 折叠旋钮所在的那个 aside 就是工作区；顺带量出宽度、根容器可用宽度与折叠态特征 */
  const probeExpr = `(() => {
    const aside = [...document.querySelectorAll("aside")].find((a) =>
      a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
    if (!aside) return { found: false };
    const root = aside.closest("div.grid");
    return {
      found: true,
      width: Math.round(aside.getBoundingClientRect().width),
      space: root ? root.clientWidth : -1,
      collapsed: aside.querySelector('button[aria-label="展开工作区"]') !== null,
      grip: document.querySelector(".dock-grip") !== null,
      railBrowser: aside.querySelector('button[aria-label="浏览器"]') !== null,
      urlShown: document.body.innerText.includes("127.0.0.1"),
      // 页签计数与激活态都按 data-dock-tab 认：容器里还挂着别的可切换控件
      // （B2 观测抽屉的三个页签同样用 aria-pressed 表达选中），只按 aria-pressed 会多算
      tabCount: aside.querySelectorAll("[data-dock-tab]").length,
      activeLabel: (
        aside.querySelector('[data-dock-tab][aria-pressed="true"]')?.textContent ?? ""
      ).trim(),
      tabClose: [...aside.querySelectorAll('button[aria-label^="关闭"]')].map((b) =>
        b.getAttribute("aria-label")),
      addButton: aside.querySelector('button[aria-label="新增视图"]') !== null,
      menuItems: [...aside.querySelectorAll("[data-dock-add]")].map((b) =>
        b.getAttribute("data-dock-add")),
      // A3-5：四个面板迁入 ⑦ 后，多开面板**不该**再新增 aside（左栏导航 + 本工作区 = 2 个）。
      // 若中栏浮层面板还在，panel 一开这里就会变成 3。
      asideCount: document.querySelectorAll("aside").length,
    };
  })()`;
  type Probe = {
    found: boolean;
    width: number;
    space: number;
    collapsed: boolean;
    grip: boolean;
    railBrowser: boolean;
    urlShown: boolean;
    tabCount: number;
    activeLabel: string;
    tabClose: string[];
    addButton: boolean;
    menuItems: string[];
    asideCount: number;
  };
  const probe = (): Promise<Probe> => run<Probe>(probeExpr);

  /** 只在工作区内找按钮并点击：避免误点会话流/侧栏里同名的元素 */
  const clickInDock = (matcher: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      if (!aside) return false;
      const el = [...aside.querySelectorAll("button")].find((b) => ${matcher});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 主进程侧：内嵌浏览器的 WebContentsView（排除主窗口自身的那个） */
  const browserView = (): Electron.View | undefined => {
    try {
      return window.contentView.children.find(
        (child) => child instanceof WebContentsView && child.webContents.id !== window.webContents.id,
      );
    } catch {
      return undefined;
    }
  };
  const waitVisible = async (want: boolean, timeoutMs = 8000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (browserView()?.getVisible() === want) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  /**
   * 模拟一次拖拽。必须拆成「按下」与「移动+抬起」两次 executeJavaScript：
   * 只有按下之后 React 才会在 window 上挂 mousemove/mouseup 监听，
   * 同一个同步块里紧接着派发 move 会丢事件（AGENTS.md 1.2 的时机坑）。
   * deltaX < 0 = 向左拖（右栏变宽）；用固定基准点，避免依赖把手真实坐标。
   */
  const dragGrip = async (deltaX: number): Promise<void> => {
    const base = 1000;
    await run(`(() => {
      const grip = document.querySelector(".dock-grip");
      if (!grip) return false;
      grip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: ${base} }));
      return true;
    })()`);
    await sleep(150);
    await run(`(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: ${base + deltaX} }));
      window.dispatchEvent(new MouseEvent("mouseup", {}));
      return true;
    })()`);
    await sleep(150);
  };

  /**
   * 点「正在处理」里路径为 path 的文件行——⑦-G 之后这个函数只用来**断言该行已经不在了**：
   * 段一不再列已完成文件（硬约束一），文件行的入口改为下钻（清单 → 内容）。
   * 用 title 做**精确匹配**（旧 FollowPanel 的文件行标题是 `点击预览 <path>`），
   * 避免用文本包含匹配时被别的行或路径前缀误中。
   */
  const clickFileRow = (path: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      if (!aside) return false;
      const want = "点击预览 " + ${JSON.stringify(path)};
      const el = [...aside.querySelectorAll("button")].find(
        (b) => (b.getAttribute("title") ?? "") === want);
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 读「正在处理」底部的**总账**（⑦-G：由「本次改动」段二降级而来的一行状态）。
   * `clickable` 按标签判定：有改动时是 `button`（进入清单的出口），没有改动时是 `div`
   * ——「空」时**不给**一个点了没反应的出口（那正是死控件）。
   * `idle` 读段一的空态标记：面板必须能显示「空」（⑦-E 的安全判断），这条得能验。
   */
  const ledgerProbe = (): Promise<{
    present: boolean;
    text: string;
    clickable: boolean;
    idle: boolean;
  }> =>
    run(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      const el = aside ? aside.querySelector("[data-follow-ledger]") : null;
      if (!el) return { present: false, text: "", clickable: false, idle: false };
      return {
        present: true,
        text: (el.textContent ?? "").replace(/\\s+/g, " ").trim(),
        clickable: el.tagName === "BUTTON",
        idle: aside.querySelector("[data-follow-empty]") !== null,
      };
    })()`);

  /** 点「正在处理」底部的总账（⑦-G 进入清单的出口） */
  const clickLedger = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      const el = aside ? aside.querySelector("[data-follow-ledger]") : null;
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 读下钻**内容层**的文件预览状态：被预览的路径、是否渲染文本、正文是否含指定片段、拒绝原因。
   * ⑦-G 之后内容层挂在「正在处理」的下钻里，故 `[data-file-view]` 只在内容层出现。
   */
  const fileProbe = (
    needle: string,
  ): Promise<{ path: string | null; hasText: boolean; hasNeedle: boolean; errorShown: boolean }> =>
    run(`(() => {
      const root = document.querySelector("[data-file-view]");
      const body = document.body.innerText;
      return {
        path: root ? root.getAttribute("data-file-view") : null,
        hasText: document.querySelector("[data-file-text]") !== null,
        hasNeedle: ${JSON.stringify(needle)}.length > 0 && body.includes(${JSON.stringify(needle)}),
        errorShown: body.includes("无法预览该文件"),
      };
    })()`);

  /**
   * 读 ⑥ 的运行状态段（C1 / C2）：判定值（`data-run-state`）、文案、点是不是红的。
   * ⑥ 没有别的冒烟覆盖，故按「真实事件通道推视图 → 读真实 DOM」验，不靠单测代偿。
   */
  const liveProbe = (): Promise<{ state: string; text: string; danger: boolean }> =>
    run(`(() => {
      const node = document.querySelector("[data-run-state]");
      if (!node) return { state: "", text: "", danger: false };
      const dot = node.querySelector(".live-dot");
      return {
        state: node.getAttribute("data-run-state") ?? "",
        text: node.textContent.trim(),
        danger: dot !== null && dot.classList.contains("danger-dot"),
      };
    })()`);

  /** 点「+」菜单里 data-dock-add=<kind> 的那一项（菜单挂在 aside 上，全文档查即可） */
  const clickMenuItem = (kind: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-dock-add="${kind}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 读「正在处理」的**下钻**状态（⑦-G）：当前在哪一层、面包屑上有哪几段、清单里有什么。
   *
   * 层用 `data-drill` 认（`list` / `diff` / `content`），不在下钻时整个容器不存在。
   * 清单的目录与文件分别用 `data-clist-dir` / `data-clist-file` 读——**不靠文本**，
   * 否则文件名恰好出现在别处（如 diff 正文）就会误判。
   * `hidden` 直接读容器上的属性值：越界条目被丢掉这件事必须**如实显示**，
   * 只断言「它不在列表里」是不够的（静默丢数据比不显示更可疑）。
   */
  const drillProbe = (): Promise<{
    layer: string;
    crumbs: string[];
    back: boolean;
    dirs: string[];
    files: string[];
    revisions: string[];
    hidden: number;
    diffRevisions: string[];
    nets: [string, string][];
    netRows: [string, string][];
    netRowValues: [string, string][];
    netUnknown: number;
  }> =>
    run(`(() => {
      const root = document.querySelector("[data-drill]");
      const attrAll = (selector, name) =>
        [...document.querySelectorAll(selector)].map((el) => el.getAttribute(name));
      // 「图形界面说它算出来是多少」与「算出来是多少」是两件事：净值读的是产品自己渲染出来的
      // 那个小格子（含空串＝没显示数字），用例不重算一遍——重算就等于把问题绕开了。
      const attrText = (selector, name) =>
        [...document.querySelectorAll(selector)].map((el) => [
          el.getAttribute(name),
          (el.textContent ?? "").trim(),
        ]);
      return {
        layer: root ? (root.getAttribute("data-drill") ?? "") : "",
        crumbs: attrAll("[data-drill-crumb]", "data-drill-crumb"),
        back: document.querySelector("[data-drill-back]") !== null,
        dirs: attrAll("[data-clist-dir]", "data-clist-dir"),
        files: attrAll("[data-clist-file]", "data-clist-file"),
        revisions: attrAll("[data-clist-rev]", "data-clist-rev"),
        hidden: Number(
          document.querySelector("[data-clist-hidden]")?.getAttribute("data-clist-hidden") ?? "0",
        ),
        diffRevisions: attrAll("[data-drill-rev]", "data-drill-rev"),
        nets: attrText("[data-clist-net-value]", "data-clist-net-value"),
        netRows: attrText("[data-clist-net]", "data-clist-net"),
        netRowValues: attrText("[data-clist-net-row-value]", "data-clist-net-row-value"),
        netUnknown: Number(
          document.querySelector("[data-clist-net-unknown]")?.getAttribute("data-clist-net-unknown") ??
            "0",
        ),
      };
    })()`);

  /** 展开后那一行「全部改动（累计）」→ diff 层的「累计」档 */
  const clickListNet = (path: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-clist-net="${path}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 点清单里 path 对应的文件卡 */
  const clickListFile = (path: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-clist-file="${path}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** diff 层右上「看文件」→ 内容层 */
  const clickDrillContent = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector("[data-drill-content]");
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 各层底部那一行「返回」 */
  const clickDrillBack = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector("[data-drill-back]");
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 面包屑上某一段（`follow` / `list`） */
  const clickCrumb = (marker: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-drill-crumb="${marker}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 点标题为「点击预览 <path>」的入口。工具卡路径在**消息流（④）**里而非工作区 aside 内，
   * 所以这里全文档查找；与 `clickFileRow` 的路径刻意取不同文件，避免命中歧义。
   */
  const clickPreviewByTitle = (path: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const want = "点击预览 " + ${JSON.stringify(path)};
      const el = [...document.querySelectorAll('[role="button"], button')].find(
        (node) => (node.getAttribute("title") ?? "") === want);
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 点 ② 会话头（`.conv-head`）里的按钮。必须**限定在会话头内**——
   * 「统计 / 规则」这些字样在 ⑦ 的页签上也有一份，全文档查会点错。
   */
  const clickInHead = (matcher: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const head = document.querySelector(".conv-head");
      if (!head) return false;
      const el = [...head.querySelectorAll("button")].find((b) => ${matcher});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 工作区（⑦）当前渲染的内容里是否出现某段文字（A3-5：判「面板渲染在 ⑦ 内」） */
  const dockHas = (needle: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      return aside !== null && (aside.innerText ?? "").includes(${JSON.stringify(needle)});
    })()`);

  /**
   * 读观测抽屉（B2）：三个页签、各自的计数徽标、是否收起、当前页签的行文本。
   * 计数读的是 `data-obs-count`（产品自己算的那个数），而不是在用例里重算一遍——
   * 重算就等于把「抽屉的数对不对」这个问题绕开了。
   */
  const obsProbe = (): Promise<{
    present: boolean;
    tabs: string[];
    counts: Record<string, number>;
    collapsed: boolean;
    rows: string[];
  }> =>
    run(`(() => {
      const root = document.querySelector("[data-observe]");
      if (root === null) return { present: false, tabs: [], counts: {}, collapsed: false, rows: [] };
      const tabs = [...root.querySelectorAll("[data-obs-tab]")];
      return {
        present: true,
        tabs: tabs.map((b) => b.getAttribute("data-obs-tab")),
        counts: Object.fromEntries(tabs.map((b) => [
          b.getAttribute("data-obs-tab"),
          Number(b.getAttribute("data-obs-count")),
        ])),
        collapsed: root.querySelector("[data-obs-body]") === null,
        rows: [...root.querySelectorAll("[data-obs-row]")].map((r) => r.innerText || ""),
      };
    })()`);

  /** 点观测抽屉里某个页签（已激活的那个 = 收起/展开） */
  const clickObsTab = (tab: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-obs-tab="${tab}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 点观测抽屉里某页签中文本含 needle 的那一行（整行可点 = 展开 / 收起详情，N1） */
  const clickObsRow = (tab: string, needle: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(`[data-obs-row="${tab}"]`)})];
      const el = rows.find((row) => (row.innerText || "").includes(${JSON.stringify(needle)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 读展开的「条目详情」（N1）：字段值、**哪些字段被截断了**、详情是否真的落在抽屉可视区内。
   *
   * 「没被截断」不靠 class 名判断，而是量 `scrollWidth <= clientWidth + 1`——
   * 被 `truncate` 的元素必然超宽，这是个**可判定**的事实（同 §5 第 ⑤ 条「只验会变、不验相等」的教训）。
   * 另外把详情顶端是否在可视区内一并读出：正文只有 132px 高，展开后若不自动滚进来，
   * 用户点了会**看不出发生了什么**（`AGENTS.md` §3.6 那类「点了没反应」）。
   */
  const obsDetailProbe = (): Promise<{
    present: boolean;
    count: number;
    fields: Record<string, string>;
    truncated: string[];
    copyButton: boolean;
    visibleInBody: boolean;
    rectTop: number;
    rectBottom: number;
    bodyTop: number;
    bodyBottom: number;
    scrollTop: number;
  }> =>
    run(`(() => {
      const empty = {
        present: false, count: 0, fields: {}, truncated: [], copyButton: false,
        visibleInBody: false, rectTop: 0, rectBottom: 0, bodyTop: 0, bodyBottom: 0, scrollTop: 0,
      };
      const details = [...document.querySelectorAll("[data-obs-detail]")];
      const detail = details[0];
      if (detail === undefined) return empty;
      const fields = {};
      const truncated = [];
      for (const el of detail.querySelectorAll("[data-obs-field]")) {
        const label = el.getAttribute("data-obs-field");
        fields[label] = el.textContent || "";
        if (el.scrollWidth > el.clientWidth + 1) truncated.push(label);
      }
      const body = document.querySelector("[data-obs-body]");
      if (body === null) return empty;
      const box = body.getBoundingClientRect();
      const rect = detail.getBoundingClientRect();
      return {
        present: true,
        count: details.length,
        fields,
        truncated,
        copyButton: detail.querySelector("[data-obs-copy]") !== null,
        visibleInBody: rect.top >= box.top - 1 && rect.top < box.bottom - 2,
        rectTop: Math.round(rect.top),
        rectBottom: Math.round(rect.bottom),
        bodyTop: Math.round(box.top),
        bodyBottom: Math.round(box.bottom),
        scrollTop: Math.round(body.scrollTop),
      };
    })()`);

  /**
   * 点详情段里的「复制」：先把它滚进可视区，再做**命中测试**——
   * 「在 DOM 里」不等于「用户点得到」（§5 第 ⑥ 条那个新变种：查得到、`click()` 也"命中"，
   * 但它已经被挤出可视区了）。
   */
  const clickObsCopy = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector("[data-obs-copy]");
      if (!el) return false;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit !== el && !el.contains(hit)) return false;
      el.click();
      return true;
    })()`);

  try {
    window.reload();
    await sleep(4000);

    // 用渲染层同款查询取「当前会话」：App 也是取 session.list 的第一条（updated_at DESC），
    // 由此保证浏览器视图挂在渲染层真正显示的那个会话上，而不是自说自话的新 id。
    const list = await run<{ id: string }[]>(
      `window.colt.invoke("session.list", ${JSON.stringify({ projectId })})`,
    );
    const sessionId = list[0]?.id;
    if (sessionId === undefined) {
      log("会话列表为空，无法进行工作区冒烟");
      checks.push(["渲染层有活动会话", false]);
      return;
    }
    log(`活动会话：${sessionId}`);

    const initial = await probe();
    checks.push(["工作区已挂载（找到折叠旋钮）", initial.found]);
    if (!initial.found) return;
    checks.push(["初始为展开态", initial.collapsed === false]);
    log(`初始：工作区宽度=${initial.width}px，可用宽度=${initial.space}px`);
    // ---- A3-1：页签由「实例列表」驱动 ----
    checks.push(["页签由实例列表驱动（初始 2 个）", initial.tabCount === 2]);
    checks.push(["初始激活默认视图「正在处理」", initial.activeLabel === "正在处理"]);
    log(`初始激活页签：${initial.activeLabel}（共 ${initial.tabCount} 个）`);

    // agent 侧「打开」浏览器（不经模型）：创建 WebContentsView + 推 browser.state
    const nav = await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "navigate",
      params: { url: server.url },
    });
    log(`navigate：${nav.text}`);
    await sleep(1500);
    const afterNav = await probe();
    checks.push(["⑦-F 自动切到浏览器页签", afterNav.urlShown && afterNav.activeLabel === "浏览器"]);
    // ensureInstance 幂等：浏览器页签本就存在，自动切换不该重复建页签
    checks.push(["⑦-F 幂等：未重复建页签", afterNav.tabCount === 2]);
    checks.push(["浏览器原生视图已就绪且可见", await waitVisible(true)]);

    // ---- A2：折叠必须同步收起原生视图 ----
    log("[A2] 折叠工作区，预期原生视图同步收起");
    await clickInDock(`b.getAttribute("aria-label") === "折叠工作区"`);
    await sleep(400);
    const folded = await probe();
    checks.push(["折叠后宽度为 44px", folded.collapsed && Math.abs(folded.width - 44) <= 1]);
    checks.push(["折叠后不再渲染拖拽把手", folded.grip === false]);
    checks.push(["折叠后图标条保留浏览器入口", folded.railBrowser]);
    checks.push(["折叠后原生视图已收起（getVisible=false）", await waitVisible(false)]);
    log(`折叠：宽度=${folded.width}px，视图可见=${browserView()?.getVisible()}`);

    // ---- 展开：点图标条上的「浏览器」----
    log("[展开] 点图标条上的浏览器图标");
    await clickInDock(`b.getAttribute("aria-label") === "浏览器"`);
    await sleep(700);
    checks.push(["展开后恢复展开态", (await probe()).collapsed === false]);
    checks.push(["展开后原生视图重新可见", await waitVisible(true)]);

    // ---- A1：拖拽方向 + 上下限 ----
    log("[A1] 右拖到底，预期命中下限 220");
    await dragGrip(10000);
    const atMin = await probe();
    checks.push(["右拖到底钳制到下限 220", atMin.width === 220]);

    log("[A1] 左拖 40px，预期变宽 40（含钳制）");
    await dragGrip(-40);
    const afterLeft = await probe();
    checks.push(["左拖 40px → 宽度 +40（含钳制）", afterLeft.width === clamp(220 + 40, afterLeft.space)]);
    log(`  220 → ${afterLeft.width}（可用宽度 ${afterLeft.space}）`);

    log("[A1] 左拖到底，预期命中上限（中栏留 360）");
    await dragGrip(-10000);
    const atMax = await probe();
    const expectedMax = Math.max(MIN_DOCK, atMax.space - MIN_CENTER);
    checks.push(["左拖到底钳制到上限（中栏留 360）", atMax.width === expectedMax]);
    log(`  上限实测 ${atMax.width}（期望 ${expectedMax}）`);

    // ---- 宽度记忆：切页签不覆盖用户拖过的宽度 ----
    log("[A1] 宽度记忆：切到「正在处理」再切回，宽度不应被统一默认值覆盖");
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    const afterFollow = await probe();
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(300);
    const backToBrowser = await probe();
    checks.push([
      "切页签后宽度不被统一默认值覆盖",
      afterFollow.width === atMax.width && backToBrowser.width === atMax.width,
    ]);
    // A3-1：激活项由 id 驱动，点击即切（内容随之变化）
    checks.push([
      "按 id 切换生效（点页签即激活）",
      afterFollow.activeLabel === "正在处理" && backToBrowser.activeLabel === "浏览器",
    ]);
    checks.push(["切换页签不改变页签数量", afterFollow.tabCount === 2 && backToBrowser.tabCount === 2]);
    log(`  切页签后：正在处理=${afterFollow.width}px，浏览器=${backToBrowser.width}px（应均为 ${atMax.width}px）`);

    // ---- 双击复位 ----
    log("[A1] 双击把手 → 回到统一默认宽度");
    await run(`(() => {
      const grip = document.querySelector(".dock-grip");
      if (!grip) return false;
      grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const reset = await probe();
    checks.push(["双击复位到统一默认宽度 544（含钳制）", reset.width === clamp(DEFAULT_DOCK, reset.space)]);

    // ---- 统一宽度：未拖拽时切页签**不改变**宽度（宽度与激活页签无关） ----
    log("[A1] 统一宽度：复位后切页签，宽度不应变化");
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    const unifiedFollow = await probe();
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(300);
    const unifiedBrowser = await probe();
    checks.push([
      "切页签不改变宽度（统一 544，与页签无关）",
      unifiedFollow.width === reset.width && unifiedBrowser.width === reset.width,
    ]);
    log(
      `  切页签：正在处理=${unifiedFollow.width}px，浏览器=${unifiedBrowser.width}px（应均为 ${reset.width}px）`,
    );

    // ---- ⑦-F：折叠态下加载浏览器应自动展开 ----
    log("[⑦-F] 折叠后让 agent 重新加载浏览器，预期自动展开");
    await clickInDock(`b.getAttribute("aria-label") === "折叠工作区"`);
    await sleep(400);
    checks.push(["（前置）再次折叠成功", (await probe()).collapsed && (await waitVisible(false))]);
    // 销毁再重建：loaded false→true 会重置渲染层的「已自动切过」标记，才能复现首次加载
    hostBridge.disposeSession(sessionId);
    await sleep(500);
    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "navigate",
      params: { url: server.url },
    });
    await sleep(1500);
    const autoExpanded = await probe();
    checks.push(["折叠态下加载浏览器 → 自动展开", autoExpanded.collapsed === false]);
    checks.push(["自动展开后原生视图可见", await waitVisible(true)]);

    // ---- 受控会话视图：⑦-G 的「正在处理」与 A3-2 的「点文件路径 → 预览」都靠它驱动 ----
    // 走**真实的事件通道**推一个受控视图（不跑模型）：`fileChanges` 三条（其中一条故意越界，
    // 用来钉住「根由主进程推导」这条安全边界）、`messages` 两张工具卡（一张根内、一张根外）。
    log("[受控视图] 推 session.view：3 条改动（含一条越界）+ 两张工具卡（根内 / 根外）");
    const rootPath = getProject(projectId)?.rootPath ?? process.cwd();
    const previewRel = "package.json";
    // 子目录里的真实文件：用来验「清单按目录分组」，也是「清单里点文件 → diff → 内容」的靶子
    const treeRel = "src/main/file-read.ts";
    // 工具卡（消息流 ④）里的路径用**绝对路径**驱动：read 的 path 常是绝对路径，
    // 顺带钉住「主进程收绝对路径、但仍须落在项目根内」这条边界
    const toolAbsPath = join(rootPath, "tsconfig.json");
    const toolMarker = (
      readFileSync(toolAbsPath, "utf8").split("\n").find((line) => line.trim().length >= 8) ?? ""
    ).trim();
    // 根**外**的绝对路径（⑦-G 之后越界条目在界面上已无可点入口：段一不再列文件行、
    // 文件树按 `isProjectRelative` 排除它），故改由**工具卡**驱动——模型确实会给出这种路径，
    // 「主进程拒绝 + 视图给出可读原因」这条不能因为入口搬家而掉出冒烟。
    const outsideAbsPath = resolve(rootPath, "..", "colt-smoke-outside", "escape.txt");
    const stamp = Date.now();
    /**
     * 造一条改动记录。`net` 是**净值**（基线 → 现在，主进程在改动落库时算好）；
     * 不给就是 null = 算不出——界面据此**不下结论**，与「净 0」是两回事。
     */
    const fakeChange = (
      id: string,
      path: string,
      at: number,
      net: { added: number; removed: number } | null = null,
    ): ViewFileChange => ({
      id,
      path,
      kind: "write",
      patch: null,
      addedLines: 0,
      removedLines: 0,
      timestamp: at,
      netAddedLines: net?.added ?? null,
      netRemovedLines: net?.removed ?? null,
    });
    /**
     * 受控会话视图的构造器：基准是一份「什么都没在跑」的视图，
     * 各用例只覆盖自己关心的字段（如 `lastRun` / `running`）。
     *
     * ⚠️ 基准对象的类型**必须是 `ConversationView` 本体**，不能写成 `Record<string, unknown>`。
     * 这个视图会经 `session.view` **整份替换**渲染层手里那份真实视图，所以**少一个字段就等于
     * 把那个字段抹成 `undefined`**。v1.43 正是在这里漏了 `skills`：渲染层于是把「本会话技能清单」
     * 读成 `undefined`（＝**不知道**），`/skill` 的本地拦截整条失效——而冒烟只报「拦不住」，
     * 看不出根因在**夹具缺字段**（`AGENTS.md` §1.2：先怀疑测试接入，别先改被测对象）。
     * 钉上类型之后，契约再加字段时这里会**编译不过**，而不是静默抹空。
     */
    const viewBase: ConversationView = {
      sessionId,
      lane: "main",
      cwd: rootPath,
      model: "smoke/model",
      imageInput: false,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      // 夹具里**一个技能都没装**：这是「知道，且为空」，正是 `/skill` 本地拦截该生效的那种情形
      // （区别于 `undefined` = 拿不到清单，那时必须放行，否则会把有效调用误判成失败）。
      skills: [],
      messages: [
        {
          id: "smoke-msg-1",
          role: "assistant",
          text: "",
          toolCalls: [
            {
              id: "smoke-call-1",
              name: "read",
              args: JSON.stringify({ path: toolAbsPath }),
              durationMs: 8,
            },
            {
              // 项目根**外**的路径：工具卡照旧可点，但主进程必须拒绝（越界）
              id: "smoke-call-2",
              name: "read",
              args: JSON.stringify({ path: outsideAbsPath }),
              durationMs: 6,
            },
          ],
        },
      ],
      toolResults: [],
      fileChanges: [
        fakeChange("smoke-a", previewRel, stamp),
        fakeChange("smoke-b", "../escape.txt", stamp - 1),
        fakeChange("smoke-c", treeRel, stamp - 2),
      ],
      streamingText: null,
      thought: null,
      runningTools: [],
      running: false,
      lastRun: null,
      queuedCount: 0,
      faulted: false,
      stats: {
        messageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        contextUsed: 0,
      },
    };
    const smokeView = (over: Partial<ConversationView>): ConversationView => ({
      ...viewBase,
      ...over,
    });
    window.webContents.send("session.view", smokeView({}));
    await sleep(400);

    // ---- ⑦-G：「正在处理」= 进行中的动作 + 底部总账 ----
    // 受控视图里 runningTools 为空、fileChanges 三条（两条项目内 + 一条越界），
    // 正好钉住两件事：段一**不再**列已完成文件（于是能显示「空」），总账是**一行**双口径。
    log("[⑦-G] 「正在处理」：段一只列进行中的动作，底部常驻一行总账");
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    checks.push([
      "段一不再列已完成文件（旧文件行已移除，⑦-G 硬约束一）",
      (await clickFileRow(previewRel)) === false,
    ]);
    const ledger0 = await ledgerProbe();
    checks.push([
      "底部总账写「N 处 · M 文件」双口径（3 条改动 / 3 个路径）",
      ledger0.present && ledger0.text.includes("3 处 · 3 文件"),
    ]);
    checks.push(["无进行中的动作时能显示「空」（空闲空态仍在）", ledger0.idle]);
    checks.push(["有改动时总账可点（进入清单的出口）", ledger0.clickable]);
    log(`  总账：${ledger0.text}`);

    // 点总账 → 下钻的**清单层**（⑦-G 第四步：不再切到「改动」页签——那个页签已经没有了，
    // 故这里的关键判据是「落到清单层」而不是「多了一个页签」，页签数应当**纹丝不动**）
    checks.push(["点总账命中", await clickLedger()]);
    await sleep(500);
    const listFromLedger = await drillProbe();
    checks.push([
      "点总账 → 进入下钻清单层（面包屑出现「正在处理」，页签数不变）",
      listFromLedger.layer === "list" &&
        listFromLedger.crumbs.includes("follow") &&
        (await probe()).tabCount === 2,
    ]);

    // ---- A3-2：点文件路径 → 预览 ----
    // ⑦-G 把两个入口收进同一处下钻：工具卡（④）的路径直接落**内容层**，
    // 与上一步的清单层是同一条面包屑上的两个位置。「文件」页签已不存在。
    log("[A3-2] 工具卡（消息流 ④）里的文件路径 → 下钻内容层");
    checks.push(["工具卡路径可点（入参是绝对路径）", await clickPreviewByTitle(toolAbsPath)]);
    await sleep(700);
    const fromTool = await fileProbe(toolMarker);
    checks.push([
      "点工具卡路径 → 落在「正在处理」的下钻内容层",
      (await probe()).activeLabel === "正在处理" && (await drillProbe()).layer === "content",
    ]);
    checks.push(["内容层记录了被预览的路径", fromTool.path === toolAbsPath]);
    checks.push(["根内绝对路径渲染出内容", fromTool.hasText && fromTool.hasNeedle]);
    log(`  工具卡预览：path=${fromTool.path}，渲染文本=${fromTool.hasText}，命中片段=${fromTool.hasNeedle}`);

    // 切走再切回：下钻状态由容器持有（不属于某个页签的重挂载），故切回来还在原处
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(500);
    checks.push(["切走后下钻内容不再渲染", (await fileProbe(toolMarker)).hasText === false]);
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(700);
    checks.push(["切回「正在处理」下钻内容仍在", (await fileProbe(toolMarker)).hasNeedle]);
    checks.push(["切页签不改变页签数量（仍 2 个）", (await probe()).tabCount === 2]);

    // 根**外**的路径：工具卡照旧可点，但主进程必须拒绝，且视图要给出可读原因。
    // （⑦-G 之后越界条目在界面上已无可点入口，故这条改由工具卡驱动，见 outsideAbsPath 的说明。）
    checks.push(["根外绝对路径的工具卡可点", await clickPreviewByTitle(outsideAbsPath)]);
    await sleep(700);
    const denied = await fileProbe("");
    checks.push([
      "越界路径被拒并给出原因（主进程拒绝 → 视图可读原因）",
      denied.errorShown && denied.path === outsideAbsPath,
    ]);
    log(`  越界预览：path=${denied.path}，给出原因=${denied.errorShown}`);

    // 退出下钻，把「正在处理」还原成后续用例依赖的基线（段一 + 总账）。
    // 该文件不在改动清单里，故 goUp 会**跳过空的清单层**直接回到「正在处理」（⑦-G 的层设计）。
    checks.push(["点「返回」退出下钻", await clickDrillBack()]);
    await sleep(300);
    checks.push(["退出后不再有下钻容器", (await drillProbe()).layer === ""]);

    // ---- C1 / C2：⑥ 的运行状态段（运行中 / 已中断 / 已失败 / 空闲）----
    // 走与上面同一条**真实事件通道**推终态。判据是渲染层真的把内核终态翻译成了那个状态，
    // 不是「字段有没有传过来」——⑥ 此前只有裸文本「空闲」，这段行为完全没有断言。
    log("[C1] ⑥ 运行状态：推不同终态，断言状态段（判定值 / 文案 / 点色）");
    window.webContents.send("session.view", smokeView({ lastRun: { status: "aborted" } }));
    await sleep(400);
    const liveAborted = await liveProbe();
    checks.push([
      "⑥ 中断后显示「已中断」",
      liveAborted.state === "aborted" && liveAborted.text.includes("已中断"),
    ]);

    window.webContents.send(
      "session.view",
      smokeView({ lastRun: { status: "failed", error: "请求超时" } }),
    );
    await sleep(400);
    const liveFailed = await liveProbe();
    checks.push(["⑥ 异常结束后显示「已失败」", liveFailed.state === "failed"]);
    checks.push([
      "⑥ 失败摘要带出 error.message（就地可读，不必翻消息流）",
      liveFailed.text.includes("请求超时"),
    ]);
    checks.push(["⑥ 失败态用红点（v3：红 = 危险 / 失败）", liveFailed.danger]);
    log(`  失败态：state=${liveFailed.state}，文案=${liveFailed.text}，红点=${liveFailed.danger}`);

    window.webContents.send("session.view", smokeView({ lastRun: { status: "completed" } }));
    await sleep(400);
    const liveDone = await liveProbe();
    checks.push([
      "⑥ 正常跑完回到「空闲」（状态条不为正常结束留痕）",
      liveDone.state === "idle" && liveDone.text.includes("空闲"),
    ]);

    window.webContents.send(
      "session.view",
      smokeView({ running: true, lastRun: { status: "failed", error: "上一轮" } }),
    );
    await sleep(400);
    const liveRunning = await liveProbe();
    checks.push([
      "⑥ 运行中优先于上一轮终态",
      liveRunning.state === "running" && liveRunning.text.includes("运行中"),
    ]);

    // 复位：后续用例都建立在「空闲」这份基准视图上
    window.webContents.send("session.view", smokeView({}));
    await sleep(300);
    checks.push(["⑥ 复位后回到空闲", (await liveProbe()).state === "idle"]);

    // ---- A3-3：页签关闭 + 「+」新增视图 ----
    // 此刻 2 个页签（正在处理 / 浏览器）——⑦-G 取消「改动」「文件」后，
    // 「正在处理」是唯一常驻视图，「浏览器」是唯一默认可关闭的页签。
    log("[A3-3] 页签关闭与「+」新增视图");
    const dock0 = await probe();
    checks.push(["展开态有「+」新增视图入口", dock0.addButton]);
    checks.push([
      "关闭按钮只出现在可关闭页签上（默认视图没有，⑦-E）",
      dock0.tabClose.length === 1 && dock0.tabClose.includes("关闭浏览器"),
    ]);

    // 「+」菜单：只列产品里真有的视图；点菜单外即收
    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    const menu = await probe();
    checks.push([
      "「+」菜单只列真的存在的视图（⑦-H 取消「工具」、⑦-G 取消「改动」「文件」后共 3 项）",
      menu.menuItems.length === 3 &&
        ["browser", "usage", "rules"].every((kind) => menu.menuItems.includes(kind)),
    ]);
    // 三个被取消的 kind 都**不是被藏起来**：只断言「菜单里少一项」不够——
    // 要确认它们连打开都打不开（否则就是一个点了没反应的死菜单项）。
    // `tools` 并入「统计」（⑦-H 第三步）；`changes` / `file` 并入下钻（⑦-G 第四步）。
    checks.push([
      "「工具」「改动」「文件」都已不是可打开的视图（kind 已移除，不是藏起来）",
      ["tools", "changes", "file"].every((kind) => !menu.menuItems.includes(kind)) &&
        (await clickMenuItem("tools")) === false &&
        (await clickMenuItem("changes")) === false &&
        (await clickMenuItem("file")) === false,
    ]);
    await run(`(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    checks.push(["点菜单外即收起「+」菜单", (await probe()).menuItems.length === 0]);

    // 关闭**当前激活**的页签：数量减 1、激活位交还默认视图、原生视图必须收起
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(500);
    checks.push(["激活「浏览器」后原生视图可见", await waitVisible(true)]);
    await clickInDock(`b.getAttribute("aria-label") === "关闭浏览器"`);
    await sleep(400);
    const afterCloseBrowser = await probe();
    checks.push([
      "关闭激活的「浏览器」→ 页签减 1 且激活位交还「正在处理」",
      afterCloseBrowser.tabCount === 1 && afterCloseBrowser.activeLabel === "正在处理",
    ]);
    checks.push(["关闭「浏览器」后原生视图已收起（getVisible=false）", await waitVisible(false)]);

    // 「+」重新打开「浏览器」：关了必须能回来（⑦-E 的出口保证），且原生视图重新可见
    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    await clickMenuItem("browser");
    await sleep(500);
    checks.push([
      "「+」重新打开「浏览器」→ 页签回到 2 且原生视图重新可见",
      (await probe()).tabCount === 2 && (await waitVisible(true)),
    ]);

    // ---- A3-4：下钻的清单层（⑦-G 取代原「本次改动」树）----
    // 受控视图里 3 条改动：package.json（根）、../escape.txt（越界）、src/main/file-read.ts。
    // 故清单应为「根 + src/main」两组、两个文件、隐藏 1 条越界——树没有了，
    // 但「目录分组」与「越界排除」这两条原判据要在新载体上继续钉住。
    log("[A3-4] 清单层：目录分组 / 越界排除 / 逐层下钻与回退");
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    checks.push(["点总账进入清单层", await clickLedger()]);
    await sleep(500);
    const list0 = await drillProbe();
    checks.push([
      "清单按目录分组（根 + src/main），文件用项目内相对路径归组",
      list0.layer === "list" &&
        list0.dirs.includes("") &&
        list0.dirs.includes("src/main") &&
        list0.files.includes(previewRel) &&
        list0.files.includes(treeRel),
    ]);
    checks.push([
      "越界条目不在清单里，且如实说明隐藏了几条（⑦-4：放进去就是死条目）",
      !list0.files.some((path) => path.includes("escape")) && list0.hidden === 1,
    ]);
    checks.push([
      "清单头部只算项目内（2 处 · 2 文件）——与总账同一套双口径，去掉越界后各自收敛",
      await dockHas("2 处 · 2 文件"),
    ]);
    log(
      `  清单：目录 ${JSON.stringify(list0.dirs)}，文件 ${JSON.stringify(list0.files)}，隐藏 ${list0.hidden}`,
    );

    // 清单 → diff：点文件卡（该文件只改过一次，故直接进 diff，不展开历史）
    checks.push(["点清单里的文件卡进入 diff 层", await clickListFile(treeRel)]);
    await sleep(500);
    const diff0 = await drillProbe();
    checks.push([
      "diff 层：面包屑含「正在处理」/ 可点的「本次改动」/ 当前文件三段",
      diff0.layer === "diff" &&
        diff0.crumbs.includes("follow") &&
        diff0.crumbs.includes("list") &&
        diff0.crumbs.includes("current"),
    ]);
    checks.push(["每层底部都有「返回」出口", diff0.back]);

    // diff → 内容：点右上「看文件」
    checks.push(["点 diff 右上「看文件」进入内容层", await clickDrillContent()]);
    await sleep(700);
    const fromList = await fileProbe("");
    checks.push([
      "内容层渲染的就是清单里点的那份文件",
      (await drillProbe()).layer === "content" && fromList.path === treeRel && fromList.hasText,
    ]);
    log(`  清单下钻预览：path=${fromList.path}，渲染文本=${fromList.hasText}`);

    // 逐层回退：ESC（内容 → diff）、底部「返回」（diff → 清单）、面包屑（清单 → 正在处理）。
    // 三条出口分别验一次，避免「只有一条路能回去」这种半吊子实现蒙混过关。
    await run(`(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      return true;
    })()`);
    await sleep(400);
    checks.push(["ESC 从内容层退回 diff 层", (await drillProbe()).layer === "diff"]);
    checks.push(["点底部「返回」命中", await clickDrillBack()]);
    await sleep(400);
    checks.push(["「返回」从 diff 层回到清单层", (await drillProbe()).layer === "list"]);
    checks.push(["点面包屑「正在处理」命中", await clickCrumb("follow")]);
    await sleep(400);
    checks.push(["面包屑退回「正在处理」（退出下钻）", (await drillProbe()).layer === ""]);

    // ---- 净值：多次改动之后，看的是「最终改成了什么」----
    // 逐次 patch 只说「这一次改了什么」。同一个文件改过多次、最后一次又退回原样时，
    // 一串增量相加看着改了很多，文件其实一点没变——故卡片给**净值**（基线 → 现在），
    // diff 层另有一档「累计」。这段用受控视图把三种情形一次钉住，净值不靠文本猜：
    // 判据读的是产品自己渲染的那一小格（`data-clist-net-value`）。
    log("[净值] 三种情形：有净变化 / 已还原 / 没有基线");
    const netRel = "package.json";
    const revertedRel = "src/main/session-manager.ts";
    const noNetRel = "tsconfig.json";
    // 累计档要**真算一次**（主进程读基线 + 读当前盘上的文件），故这里先落一份基线：
    // 故意在真内容后面多一行，净变化因此确定是「删掉 1 行」，patch 里能读到那行标记。
    const netMark = "// smoke-net-baseline";
    recordFileBaseline(sessionId, netRel, {
      existed: true,
      text: `${readFileSync(join(rootPath, netRel), "utf8")}${netMark}\n`,
    });
    window.webContents.send(
      "session.view",
      smokeView({
        fileChanges: [
          // ① 两次改动，最新那条的净值是 −1
          fakeChange("net-1", netRel, stamp + 1, { added: 0, removed: 1 }),
          fakeChange("net-2", netRel, stamp + 2, { added: 0, removed: 1 }),
          // ② 先加后删，最后退回原样 → 净值 0（是**算出来的结论**，不是「算不出」）
          fakeChange("rev-1", revertedRel, stamp + 3, { added: 6, removed: 0 }),
          fakeChange("rev-2", revertedRel, stamp + 4, { added: 0, removed: 0 }),
          // ③ 没有基线（过大 / 二进制 / 读取失败）→ 给不出净值
          fakeChange("none-1", noNetRel, stamp + 5),
        ],
      }),
    );
    await sleep(400);
    checks.push(["推净值受控视图后仍可进清单", await clickLedger()]);
    await sleep(500);
    const netList = await drillProbe();
    const netOf = (path: string): string =>
      netList.nets.find(([item]) => item === path)?.[1] ?? "<未渲染>";
    checks.push(["（前置）清单层已渲染三个文件卡", netList.layer === "list" && netList.files.length === 3]);
    checks.push([`净值：卡片给的是净值（改过两次、净 −1），实为 ${netOf(netRel)}`, netOf(netRel) === "−1"]);
    checks.push([
      `净值：改完又退回原样 → 卡片写「已还原」，实为 ${netOf(revertedRel)}`,
      netOf(revertedRel) === "已还原",
    ]);
    checks.push([`净值：算不出的文件不显示数字，实为「${netOf(noNetRel)}」`, netOf(noNetRel) === ""]);
    checks.push([
      `净值：算不出的文件在清单底部如实计数，实为 ${netList.netUnknown}`,
      netList.netUnknown === 1,
    ]);

    // 展开 → 「全部改动（累计）」→ diff 层的「累计」档。
    // 判据是**正文里出现了基线那一行**：受控改动是 write（没有 patch），
    // 若没落到「累计」档，正文只会是「内核未提供 diff」那句，不可能有这行内容。
    checks.push(["展开改过两次的文件卡", await clickListFile(netRel)]);
    await sleep(300);
    const expanded = await drillProbe();
    checks.push([
      "展开后出现「全部改动（累计）」这一行",
      expanded.netRows.some(([item]) => item === netRel),
    ]);
    // 判据读的是那一格**自己的**元素（`data-clist-net-row-value`），不是整行拼接出来的文字——
    // 拿 label+数字 的整串去等于「−1」，红的是用例而不是产品（AGENTS.md §1.2）
    checks.push([
      `该行给出净值 −1，实为 ${JSON.stringify(expanded.netRowValues)}`,
      expanded.netRowValues.some(([item, text]) => item === netRel && text === "−1"),
    ]);
    checks.push(["点「全部改动（累计）」命中", await clickListNet(netRel)]);
    await sleep(900);
    const netDiff = await drillProbe();
    checks.push([
      "累计档：落在 diff 层，且历史切换里有「累计」这一档",
      netDiff.layer === "diff" && netDiff.diffRevisions.includes("__net__"),
    ]);
    checks.push(["累计档：画的是「基线 → 当前」的真实差异", await dockHas(netMark)]);
    log(`  累计档：档位 ${JSON.stringify(netDiff.diffRevisions)}，命中了基线痕迹=${await dockHas(netMark)}`);

    // 已还原的文件：累计档不必读盘，直接给出结论（再点一次主进程也算不出差异）
    checks.push(["回清单", await clickCrumb("list")]);
    await sleep(400);
    checks.push(["展开已还原的文件卡", await clickListFile(revertedRel)]);
    await sleep(300);
    checks.push(["点它的「全部改动（累计）」", await clickListNet(revertedRel)]);
    await sleep(600);
    checks.push(["已还原的文件，累计档明说「已还原」", await dockHas("本次会话已还原")]);

    // 退出下钻并把受控视图还原成后续用例依赖的那份（3 条改动）
    checks.push(["退出净值场景的下钻", await clickCrumb("follow")]);
    await sleep(300);
    window.webContents.send("session.view", smokeView({}));
    await sleep(400);

    // ---- A3-5：中栏的观测 / 管理面板迁入 ⑦ 页签 ----
    // 迁入前它们在**中栏**另起一个 aside（同一件事两处实现、两套入口）；迁入后
    // 只有「页签」这一个载体，② 的入口与「+」菜单都只是打开同一个页签的快捷方式。
    // ⑦-H 先把 ② 的按钮从 4 个收敛到 2 个：删「改动」（总账接管）、删「工具」（聚合并入「统计」）；
    // ⑦-G 再把「改动」「文件」两个 kind 整个取消（并入下钻）——故 ② 只剩「统计 / 规则」。
    log("[A3-5 / ⑦-H / ⑦-G] 面板迁入页签；② 会话头只剩「统计 / 规则」；「改动」「文件」「工具」都不再是视图");
    const beforeA35 = await probe();
    checks.push(["（前置）此刻共 2 个页签（正在处理 / 浏览器）", beforeA35.tabCount === 2]);

    // 删掉的入口**不能只是画没了**：这里断言它们在会话头里已经点不到
    checks.push([
      "② 会话头不再有「改动」入口（下钻取代，⑦-G）",
      (await clickInHead(`b.textContent.trim().startsWith("改动")`)) === false,
    ]);
    checks.push([
      "② 会话头不再有「工具」入口（聚合并入「统计」）",
      (await clickInHead(`b.textContent.trim() === "工具"`)) === false,
    ]);

    checks.push(["② 会话头有「统计」入口且点击命中", await clickInHead(`b.textContent.trim() === "统计"`)]);
    await sleep(500);
    const usageDock = await probe();
    checks.push([
      "点「统计」→ 新增页签并激活，面板渲染在 ⑦ 内（页签名同为「统计」）",
      usageDock.tabCount === 3 && usageDock.activeLabel === "统计" && (await dockHas("会话统计")),
    ]);
    // 面板**本体**（不只是头部标题）确实画出来了。本场景不跑模型，故 usage / toolCalls 都为空，
    // 它应当是空态——聚合内容在这里喂不了数据，改由 `tests/lib.test.ts` 的纯函数单测覆盖。
    checks.push(["「统计」面板渲染出空态（本场景没有模型 / 工具调用）", await dockHas("还没有统计数据")]);

    checks.push(["② 会话头有「规则」入口且点击命中", await clickInHead(`b.textContent.trim() === "规则"`)]);
    await sleep(500);
    checks.push([
      "点「规则」→ 激活「规则」页签且渲染审批规则面板",
      (await probe()).activeLabel === "规则" && (await dockHas("审批规则")),
    ]);

    // ⑦-H / ⑦-G 起，「工具」「改动」「文件」三个页签都**不存在了**，故这一段不再有
    // 「从『+』菜单打开某个面板」这一步——它们的消失已在上面的「+」菜单断言里钉住。
    const dockA35 = await probe();
    checks.push([
      "两个迁入的页签都可关闭（关闭由页签负责，面板内不再有「收起」）",
      ["关闭统计", "关闭规则"].every((label) => dockA35.tabClose.includes(label)),
    ]);
    // 关键判据：多开面板**不再新增 aside**（中栏浮层已消失）
    checks.push([
      "中栏不再有浮层面板（多开 2 个面板后 aside 数不变）",
      dockA35.asideCount === beforeA35.asideCount,
    ]);
    log(`  迁入后：页签 ${dockA35.tabCount} 个，aside ${dockA35.asideCount} 个`);

    // 关闭「规则」：页签减 1、激活位交还默认视图、面板内容随之卸载
    await clickInDock(`b.getAttribute("aria-label") === "关闭规则"`);
    await sleep(400);
    const closedA35 = await probe();
    checks.push([
      "关闭「规则」→ 页签减 1 且激活位交还「正在处理」",
      closedA35.tabCount === 3 && closedA35.activeLabel === "正在处理",
    ]);
    checks.push(["关闭后规则面板已卸载", (await dockHas("审批规则")) === false]);

    // 「+」重开「规则」：迁入的页签都满足「关了能回来」（⑦-E 的出口保证）
    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    await clickMenuItem("rules");
    await sleep(500);
    const reopenedA35 = await probe();
    checks.push([
      "「+」重开「规则」→ 页签回到 4 且面板重新渲染",
      reopenedA35.tabCount === 4 &&
        reopenedA35.activeLabel === "规则" &&
        (await dockHas("审批规则")),
    ]);

    // ---- B2：浏览器观测抽屉（控制台 / 网络 / 下载）----
    // 抽屉读的是主进程那份 CaptureBuffer（与 browser_read 同源）。这里先在**真实夹具页**上
    // 制造三类事件（控制台报错 / 请求失败 / 触发下载），再断言抽屉把它们显示出来了——
    // 不跑模型，但页面上发生的与用户实际操作时一模一样。
    log("[B2] 浏览器观测抽屉");
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(500);
    const obs0 = await obsProbe();
    checks.push([
      "浏览器页签内出现观测抽屉（控制台 / 网络 / 下载三个页签）",
      obs0.present && obs0.tabs.join(",") === "console,network,downloads",
    ]);

    const obsSnap = await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "snapshot",
      params: {},
    });
    const obsRef = (label: string): string | undefined =>
      new RegExp(`\\[(e\\d+)\\] (?:a|button|input) "${label}"`).exec(obsSnap.text)?.[1];
    const consoleRef = obsRef("触发控制台告警");
    const netRef = obsRef("触发请求失败");
    const downloadRef = obsRef("下载测试文件");
    checks.push([
      "夹具页上找到三个观测靶元素",
      consoleRef !== undefined && netRef !== undefined && downloadRef !== undefined,
    ]);
    for (const ref of [consoleRef, netRef, downloadRef]) {
      if (ref === undefined) continue;
      await hostBridge.handle({
        sessionId,
        capability: "browser",
        action: "click",
        params: { ref },
      });
    }
    // 等页面事件到达 + 抽屉的 1s 轮询取到新快照
    await sleep(2500);

    const obsConsole = await obsProbe();
    checks.push([
      "抽屉·控制台：徽标计数 >= 2（error + warning）且列出那条报错",
      obsConsole.counts.console >= 2 &&
        obsConsole.rows.some((row) => row.includes("夹具：这是一条脚本报错")),
    ]);
    log(`  控制台：count=${obsConsole.counts.console}，行数=${obsConsole.rows.length}`);

    checks.push(["切到「网络」页签", await clickObsTab("network")]);
    await sleep(400);
    const obsNetwork = await obsProbe();
    checks.push([
      "抽屉·网络：徽标计数 >= 3（404 + 500 + 网络错误）且列出 /api/missing",
      obsNetwork.counts.network >= 3 && obsNetwork.rows.some((row) => row.includes("/api/missing")),
    ]);
    log(`  网络：count=${obsNetwork.counts.network}，行数=${obsNetwork.rows.length}`);

    checks.push(["切到「下载」页签", await clickObsTab("downloads")]);
    await sleep(400);
    const obsDownloads = await obsProbe();
    checks.push([
      "抽屉·下载：列出刚触发的 payload 文件",
      obsDownloads.counts.downloads >= 1 &&
        obsDownloads.rows.some((row) => row.includes(payloadName)),
    ]);
    log(`  下载：count=${obsDownloads.counts.downloads}`);

    // 收起 / 展开：抽屉占的是「页面区域」的高度，收起后原生视图必须跟着变高——
    // 只改 DOM 不上报 bounds，页面就会被裁掉一块（这条又是截图看不见的）。
    checks.push(["切回「控制台」页签", await clickObsTab("console")]);
    await sleep(400);
    checks.push(["切页签会把抽屉展开", (await obsProbe()).collapsed === false]);

    const expandedHeight = browserView()?.getBounds().height ?? 0;
    checks.push(["点已激活的页签 → 收起抽屉正文", await clickObsTab("console")]);
    await sleep(700);
    const collapsedProbe = await obsProbe();
    checks.push([
      "收起后正文不再渲染（页签与计数仍在）",
      collapsedProbe.collapsed && collapsedProbe.tabs.length === 3,
    ]);
    const collapsedHeight = browserView()?.getBounds().height ?? 0;
    checks.push([
      "收起抽屉后页面区域变高（原生视图 bounds 同步）",
      collapsedHeight > expandedHeight,
    ]);
    log(`  抽屉收起前后：页面区域 ${expandedHeight} → ${collapsedHeight}`);

    await clickObsTab("console");
    await sleep(600);
    checks.push(["再点一次 → 正文回来", (await obsProbe()).collapsed === false]);

    // ---- N1：观测条目的「详情」----
    // 这一屏最常被问的是「刚才那个请求为什么失败」。概览行里 URL / 路径都是截断的
    // （原先只能靠原生 tooltip 兜底），所以点开一条看**完整字段**——而「完整」的判据不看 class，
    // 而是量 `scrollWidth <= clientWidth + 1`：被 truncate 的元素必然超宽，这是个可判定的事实。
    log("[N1] 观测条目详情：点行展开字段表 + 复制");
    const consoleNeedle = "夹具：这是一条脚本报错";
    checks.push(["点控制台那条报错行（整行可点）", await clickObsRow("console", consoleNeedle)]);
    await sleep(300);
    const consoleDetail = await obsDetailProbe();
    checks.push([
      "控制台详情：给出**完整来源 URL**（概览里只有文件名），且只展开这一条",
      consoleDetail.present &&
        consoleDetail.count === 1 &&
        consoleDetail.fields["消息"] === consoleNeedle &&
        (consoleDetail.fields["来源"] ?? "").startsWith("http://127.0.0.1:"),
    ]);
    checks.push([
      "控制台详情：长值没被截断，且带复制入口",
      consoleDetail.copyButton && consoleDetail.truncated.length === 0,
    ]);
    log(`  控制台详情：${JSON.stringify(consoleDetail.fields)}`);
    checks.push(["再点同一行 → 详情收起", await clickObsRow("console", consoleNeedle)]);
    await sleep(250);
    checks.push(["收起后详情已从 DOM 移除", (await obsDetailProbe()).present === false]);

    // 下载：概览里的路径是截断的（只有 tooltip），展开后要给**绝对路径**
    checks.push(["切到「下载」页签", await clickObsTab("downloads")]);
    await sleep(400);
    checks.push(["点那一条下载", await clickObsRow("downloads", payloadName)]);
    await sleep(300);
    const downloadDetail = await obsDetailProbe();
    checks.push([
      "下载详情：绝对路径完整可读（不被截断），并给出体积 / 状态",
      downloadDetail.present &&
        (downloadDetail.fields["路径"] ?? "").includes("browser-downloads") &&
        (downloadDetail.fields["路径"] ?? "").endsWith(payloadName) &&
        (downloadDetail.fields["大小"] ?? "") !== "" &&
        downloadDetail.fields["状态"] === "completed" &&
        downloadDetail.truncated.length === 0,
    ]);
    log(`  下载详情路径：${downloadDetail.fields["路径"]}`);

    // 网络：三条请求（404 / 500 / 连接被拒）。点**最后一条**——它的详情必定落在 132px 的正文之外，
    // 正好验「展开后自动滚进可视区」：否则用户点了只会看到箭头转了，内容在视野之外。
    checks.push(["切到「网络」页签", await clickObsTab("network")]);
    await sleep(400);
    checks.push(["点被拒的那条请求（列表最后一条）", await clickObsRow("network", "refused")]);
    await sleep(400);
    const refusedDetail = await obsDetailProbe();
    checks.push([
      "网络详情：完整 URL + 失败原因，且**自动滚进了可视区**",
      refusedDetail.present &&
        refusedDetail.visibleInBody &&
        (refusedDetail.fields["URL"] ?? "").includes("/refused") &&
        // 与 fixture 模式同一条纪律：只认 `net::ERR_` 前缀。
        // 具体是 REFUSED 还是 UNSAFE_PORT（9 端口在 Chromium 的受限名单里）由内核决定，
        // 写死具体码就是在断言 Chromium 的实现细节，换个端口就红。
        (refusedDetail.fields["错误"] ?? "").startsWith("net::ERR_") &&
        refusedDetail.fields["状态码"] === undefined &&
        refusedDetail.truncated.length === 0,
    ]);
    log(
      `  网络详情：错误=${refusedDetail.fields["错误"]}，` +
        `截断=${JSON.stringify(refusedDetail.truncated)}，` +
        `详情 ${refusedDetail.rectTop}~${refusedDetail.rectBottom} vs 正文 ` +
        `${refusedDetail.bodyTop}~${refusedDetail.bodyBottom}，scrollTop=${refusedDetail.scrollTop}`,
    );

    // 单开：点了另一条，前一条自动收起（正文只有 132px，展开多条只会互相挤出去）
    checks.push(["再点 404 那条", await clickObsRow("network", "/api/missing")]);
    await sleep(400);
    const missingDetail = await obsDetailProbe();
    checks.push([
      "一次只展开一条（前一条已收起），状态码 404 原样给出、不留空的「错误」行",
      missingDetail.count === 1 &&
        missingDetail.fields["状态码"] === "404" &&
        missingDetail.fields["错误"] === undefined,
    ]);

    // 复制：真的写进系统剪贴板（渲染层调 `navigator.clipboard`，这里从**主进程**读回来核对）。
    // ⚠️ 写剪贴板要求**文档处于聚焦状态**（Chromium 的硬规则）：真实用户点这个按钮时窗口必然聚焦，
    // 而冒烟跑到这里时焦点还在终端上——不先聚焦，`writeText` 的 promise 会直接 reject、静默失败。
    window.focus();
    window.webContents.focus();
    await sleep(200);
    checks.push(["点「复制」（先命中测试，确认它真的在可视区那一层）", await clickObsCopy()]);
    await sleep(300);
    const clipboardText = await clipboard.readText();
    checks.push([
      "复制写出的是完整字段文本（含 URL 与状态码），不是概览里那行的截断版",
      clipboardText.includes("URL：") &&
        clipboardText.includes("/api/missing") &&
        clipboardText.includes("状态码：404"),
    ]);
    log(`  剪贴板首行：${clipboardText.split("\n")[0] ?? ""}`);

    // 换页签即收起上一条的展开：否则切回来会突然弹出一条，像是自己冒出来的
    checks.push(["切回「控制台」页签", await clickObsTab("console")]);
    await sleep(400);
    checks.push(["换页签后没有残留的展开详情", (await obsDetailProbe()).present === false]);

    // ---- 原生视图必须**精确覆盖**「页面区域」----
    // 截图看不见这一条（原生视图浮在渲染层之上，截图里它就是页面本身），但错位的后果很显眼：
    // 高度多出来的部分会盖住下方观测抽屉、宽度多出来的部分会被窗口裁掉。
    // 此前只验过「收起/展开时高度会变」，**没验过「与区域相等」**——而它恰恰是间歇性错的：
    // 抽屉再展开时页面区域变矮，那一次上报若没送到，原生视图就停在收起时的高个子，压住抽屉。
    const readAreaRect = (): Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-area]");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      })()`);
    const alignedNow = async (): Promise<boolean> => {
      const area = await readAreaRect();
      const view = browserView()?.getBounds();
      if (area === null || view === undefined) return false;
      const ok =
        Math.abs(view.x - area.x) <= 1 &&
        Math.abs(view.y - area.y) <= 1 &&
        Math.abs(view.width - area.width) <= 1 &&
        Math.abs(view.height - area.height) <= 1;
      if (!ok) log(`  未对齐：区域 ${JSON.stringify(area)} vs 视图 ${JSON.stringify(view)}`);
      return ok;
    };
    /**
     * 页面自己的 `innerWidth`——**必须从浏览器视图的 webContents 读**。
     * `run()` 打的是应用 UI 的渲染层，量到的是窗口宽度而不是页面（这里真踩过一次：
     * 一度读到「页面 1424」，其实是窗口宽度，差点把结论带偏）。
     *
     * 它是「原生视图尺寸真的落到页面」的独立证据：视图设成多大，页面就按多大重排。
     * 用户报的「页面偏大、右侧被窗口边缘切掉」正是这条被破坏的样子——页面比停靠区宽。
     */
    const pageInnerWidth = async (): Promise<number | null> => {
      const view = browserView();
      if (!(view instanceof WebContentsView)) return null;
      return view.webContents.executeJavaScript("window.innerWidth", true);
    };
    // 反复收起 / 展开五轮：单次是赶上还是错过都带偶然性，循环才逼得出「偶尔漏报」
    for (let round = 0; round < 5; round += 1) {
      await clickObsTab("console");
      await sleep(350);
      await clickObsTab("console");
      await sleep(350);
      checks.push([`第 ${round + 1} 轮收起/展开后原生视图仍与页面区域对齐`, await alignedNow()]);
    }
    checks.push(["原生视图与「页面区域」逐像素对齐（多出即遮挡 / 裁切）", await alignedNow()]);
    log(`  对齐：区域 ${JSON.stringify(await readAreaRect())} 视图 ${JSON.stringify(browserView()?.getBounds())}`);

    // ---- 视口联调覆盖必须「可见 + 可撤销」----
    // 它是持久状态（只在显式「恢复」时撤销），且会让原生视图比停靠区更大：实测 1280×800 的覆盖
    // 在 823×643 的停靠区里，右侧被窗口边缘裁掉、下方压住观测抽屉——而从界面上完全看不出这是
    // 联调尺寸，用户只会以为渲染坏了。所以标记与出口都必须真的在，且「恢复」后要回到逐像素对齐。
    const viewportBadge = (): Promise<{
      size: string | null;
      hasReset: boolean;
      resetHittable: boolean;
    } | null> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-viewport]");
        if (!el) return null;
        const reset = el.querySelector("[data-browser-viewport-reset]");
        // 「在 DOM 里」不等于「用户能点到」：标记是小目标，被挤出可视区或被原生视图压住都看不出来。
        // 用命中测试问一次真实问题：这一点上最顶层的元素是不是它？
        let resetHittable = false;
        if (reset) {
          const r = reset.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          resetHittable = hit !== null && (hit === reset || reset.contains(hit));
        }
        return {
          size: el.getAttribute("data-browser-viewport"),
          hasReset: reset !== null,
          resetHittable,
        };
      })()`);
    checks.push(["未联调时头部没有视口标记", (await viewportBadge()) === null]);

    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "viewport",
      params: { width: 1280, height: 800 },
    });
    await sleep(700);
    const badge = await viewportBadge();
    checks.push(["设了视口覆盖后头部出现标记且尺寸正确", badge?.size === "1280x800"]);
    checks.push(["标记里有「恢复」出口", badge?.hasReset === true]);
    checks.push([
      "「恢复」真的在可视区内且可点（不是只存在于 DOM）",
      badge?.resetHittable === true,
    ]);
    const overArea = await readAreaRect();
    const overView = browserView()?.getBounds();
    log(`  覆盖：区域 ${JSON.stringify(overArea)} 视图 ${JSON.stringify(overView)}`);
    checks.push([
      "覆盖确实比停靠区大（即用户看到的「超出、被窗口裁掉」）",
      overArea !== null &&
        overView !== undefined &&
        overView.width > overArea.width &&
        overView.height > overArea.height,
    ]);
    // 覆盖必须**真的落到页面上**：判据取页面自己的 innerWidth，而不是我们设的视图宽度。
    // 页面按 1280 重排，正是「页面比停靠区宽、右侧被窗口边缘切掉」的来源——用户那张截图就是它。
    // 读数写进断言文案：这一条一旦变红，红在「设了多大 / 量到多少 / 区域多宽」哪一段必须一眼可见。
    const iwOverride = await pageInnerWidth();
    checks.push([
      `覆盖尺寸真的落到页面（页面 innerWidth=${iwOverride}，期望 1280）`,
      iwOverride === 1280,
    ]);

    // 点「恢复」也走命中测试取到的那个元素：跟真人点击同一条路径，
    // 而不是直接对隐藏节点调 `el.click()`（那样即使标记被挤出可视区也会"通过"）。
    const clickedReset = await run<boolean>(`(() => {
      const el = document.querySelector("[data-browser-viewport-reset]");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit === null || !(hit === el || el.contains(hit))) return false;
      hit.click();
      return true;
    })()`);
    checks.push(["点「恢复」命中", clickedReset]);
    await sleep(700);
    checks.push(["「恢复」后标记消失", (await viewportBadge()) === null]);
    checks.push(["「恢复」后原生视图回到与页面区域逐像素对齐", await alignedNow()]);
    const afterReset = await readAreaRect();
    const iwAfterReset = await pageInnerWidth();
    checks.push([
      `「恢复」后页面重新按停靠区宽度重排（页面 innerWidth=${iwAfterReset}，区域宽=${afterReset?.width}）`,
      afterReset !== null && iwAfterReset !== null && Math.abs(iwAfterReset - afterReset.width) <= 1,
    ]);

    // ---- B1：用户自己的前进 / 后退 / 刷新 ----
    // 先在夹具站里再真实加载一页（/popup.html）造出历史，再点**界面上的按钮**——
    // 走的就是用户的链路：渲染层点击 → IPC → 主进程 navigationHistory。
    // 判据取主进程读到的**真实 URL**，而不是界面上的文字：按钮画对了却没真导航，
    // 正是这类「看着没问题」的功能最容易假通过的地方。
    log("[B1] 浏览器前进 / 后退 / 刷新（用户链路）");
    const navButtons = (): Promise<{
      present: boolean;
      back: boolean;
      forward: boolean;
      reload: boolean;
    }> =>
      run(`(() => {
        const at = (name) => document.querySelector('[data-browser-nav="' + name + '"]');
        const back = at("back");
        if (!back) return { present: false, back: true, forward: true, reload: true };
        return {
          present: true,
          back: back.disabled,
          forward: at("forward").disabled,
          reload: at("reload").disabled,
        };
      })()`);
    const clickNav = (name: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const el = document.querySelector('[data-browser-nav="' + ${JSON.stringify(name)} + '"]');
        if (!el) return false;
        el.click();
        return true;
      })()`);
    const navUrl = (): string => hostBridge.browserState(sessionId).url;

    const nav0 = await navButtons();
    checks.push(["浏览器头部有后退 / 前进 / 刷新三个按钮", nav0.present]);
    checks.push(["视图已加载时「刷新」可用", nav0.reload === false]);

    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "navigate",
      params: { url: `${server.url}popup.html` },
    });
    await sleep(900);
    const nav1 = await navButtons();
    checks.push(["导航到第二页后「后退」变可用", nav1.back === false]);
    checks.push(["还没退过时「前进」不可用", nav1.forward === true]);
    checks.push(["真实 URL 已是第二页", navUrl().endsWith("/popup.html")]);

    checks.push(["点「后退」按钮命中", await clickNav("back")]);
    await sleep(900);
    const nav2 = await navButtons();
    checks.push(["后退后真实 URL 回到第一页", !navUrl().endsWith("/popup.html")]);
    checks.push(["退到最早一页：后退不可用、前进可用", nav2.back === true && nav2.forward === false]);

    checks.push(["点「前进」按钮命中", await clickNav("forward")]);
    await sleep(900);
    const nav3 = await navButtons();
    checks.push([
      "前进后回到第二页，后退重新可用",
      navUrl().endsWith("/popup.html") && nav3.back === false && nav3.forward === true,
    ]);

    checks.push(["点「刷新」按钮命中", await clickNav("reload")]);
    await sleep(900);
    checks.push(["刷新后仍停在同一页", navUrl().endsWith("/popup.html")]);
    log(`  B1 结束时真实 URL：${navUrl()}`);

    // ---- 最窄右栏下也必须逐像素相等 ----
    // 用户实测「把右栏拖窄后载入页面，内容超出 / 被窗口边缘切掉」。此前对齐断言只在 823 这种
    // 宽栏下跑过，而窄栏是几个独立变量（上报频率、抽屉占比、原生视图尺寸都不同），必须单独验。
    await dragGrip(10000);
    await sleep(600);
    const narrowArea = await readAreaRect();
    const narrowView = browserView()?.getBounds();
    log(`  [窄栏] 区域 ${JSON.stringify(narrowArea)} 视图 ${JSON.stringify(narrowView)}`);
    checks.push(["右栏拖到最窄后原生视图仍与页面区域逐像素对齐", await alignedNow()]);

    // 窄栏里还要再验一次「恢复」标记可点：它正是最容易被地址栏挤出可视区的地方
    // （分工是「地址栏 min-w-0 flex-1 先截断、标记 shrink-0 保位」，这里验的就是这个分工真的成立）。
    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "viewport",
      params: { width: 375, height: 700 },
    });
    await sleep(700);
    const narrowBadge = await viewportBadge();
    checks.push([
      "最窄右栏下「恢复」标记仍在可视区内且可点",
      narrowBadge?.resetHittable === true,
    ]);
    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "viewport",
      params: {},
    });
    await sleep(700);
    checks.push(["最窄右栏下「恢复」后仍逐像素对齐", await alignedNow()]);

    // ---- ③「页面装不下、够不到」必须说出来（v1.39）----
    // 最小窗口（1024）下右栏最多只有 ~423px，而固定宽度的站点会被原生视图裁掉；若页面又禁了
    // 横向滚动，被裁的部分**既没有滚动条也没有别的入口**，而界面上看不出是页面本身装不下。
    // 判据取提示条给出的数字，不看 class；数字正好能验出「量的是页面内容宽，不是视口宽」
    // （量错成视口宽时它会等于可视区宽，永远不触发）。
    const clippedBadge = (): Promise<{ size: string | null; text: string } | null> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-clipped]");
        return el ? { size: el.getAttribute("data-browser-clipped"), text: el.textContent } : null;
      })()`);
    /**
     * 页面侧的横向量——**必须从浏览器视图的 webContents 读**（`run()` 打的是应用 UI）。
     * 打印它是为了让这条一旦变红时能一眼看清「是页面真的没溢出，还是我们的口径量错了」。
     */
    const pageMetrics = async (): Promise<Record<string, number> | null> => {
      const view = browserView();
      if (!(view instanceof WebContentsView)) return null;
      return view.webContents.executeJavaScript(
        `(() => ({
          innerWidth: window.innerWidth,
          docClientWidth: document.documentElement.clientWidth,
          docScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body ? document.body.scrollWidth : -1,
        }))()`,
        true,
      );
    };
    const gotoPage = async (suffix: string): Promise<void> => {
      await hostBridge.handle({
        sessionId,
        capability: "browser",
        action: "navigate",
        params: { url: `${server.url}${suffix}` },
      });
      await sleep(900);
    };

    // 右栏显式回最窄：不依赖上一段恰好停在最窄这个偶然状态
    await dragGrip(10000);
    await sleep(600);
    await gotoPage("narrow.html");
    const clippedNarrow = await clippedBadge();
    const [needRaw, areaRaw] = (clippedNarrow?.size ?? "").split(">");
    const need = Number(needRaw);
    const area = Number(areaRaw);
    log(`  [装不下] 窄栏提示条：${JSON.stringify(clippedNarrow)}`);
    log(`  [装不下] 页面侧横向量：${JSON.stringify(await pageMetrics())}`);
    log(`  [装不下] 主进程状态：${JSON.stringify(hostBridge.browserState(session.id))}`);
    checks.push([
      `窄栏遇上固定宽度页面 → 提示条如实给出「需要 ${need}px / 可视区 ${area}px」`,
      clippedNarrow !== null && need >= 700 && need <= 720 && area > 0 && area < 500,
    ]);
    // 提示条是横在「页面区域」之上的：它一出现，区域矩形就变矮，原生视图必须跟着收。
    // 这一条正是「电平」那一类——原生视图浮在渲染层之上，错位了肉眼看不出来。
    checks.push(["提示条出现后原生视图仍与页面区域逐像素对齐", await alignedNow()]);

    // 同一个页面、把右栏拉到最宽：装得下了，提示必须**自己消失**。
    // 这一条防的是「栏一窄就挂一条常驻提示」——那种提示永远为真，比没有提示更糟（它会持续撒谎）。
    await dragGrip(-10000);
    await sleep(900);
    log(`  [装得下] 宽栏提示条：${JSON.stringify(await clippedBadge())}`);
    checks.push([
      "右栏拉宽到装得下之后提示条自行消失（不是常驻灰条）",
      (await clippedBadge()) === null,
    ]);

    // 复原成最窄，免得把「最窄」这个上下文留给后面的段落（其余段落只用到输入区）
    await dragGrip(10000);
    await sleep(400);

    // ---- 「适应宽度」：把装不下的页面等比缩小（v1.40）----
    // 上面那条横条原先只解释、不给出口（「拖宽右栏或最大化窗口即可」），而右栏上限本就受窗口
    // 宽度限制（上限 = 窗口内容宽 − 601）——用户读完那句话依然什么也做不了。现在横条上直接给
    // 「适应宽度」：整页等比缩小，右侧被裁掉的部分重新可见。
    //
    // 缩放**不动原生视图的矩形**（只改页面的 CSS 视口），所以「逐像素对齐」这条硬约束在缩放
    // 期间仍必须成立，本节每一步都跟着复核一次。
    // 判据一律取**页面自己的读数**（innerWidth），不看 class、也不看界面上那个百分比文字——
    // 「界面写了个 60% 但页面根本没缩」正是这类功能最容易假通过的地方。
    const zoomBadge = (): Promise<number | null> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-zoom]");
        return el ? Number(el.getAttribute("data-browser-zoom")) : null;
      })()`);
    /**
     * 「适应宽度」按钮的存在与可点。
     * 只说 `present` 会漏掉被挤出可视区的那种「看得见字号、点不到」的假出口（窄栏下真发生过），
     * 故可点性一律用命中测试判——与真人点击同一条路径。
     */
    const fitState = (): Promise<{ present: boolean; hittable: boolean }> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-fit]");
        if (!el) return { present: false, hittable: false };
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          present: true,
          hittable: r.width > 0 && r.height > 0 && hit !== null && (hit === el || el.contains(hit)),
        };
      })()`);
    const clickHittable = (selector: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit === null || !(hit === el || el.contains(hit))) return false;
        hit.click();
        return true;
      })()`);

    await gotoPage("narrow.html");
    await sleep(700);
    const needPx = hostBridge.browserState(session.id).contentWidth;
    const beforeFit = await readAreaRect();
    log(
      `  [适应宽度] 最窄栏：区域 ${JSON.stringify(beforeFit)}，页面需要 ${needPx}px，主进程 ${JSON.stringify(hostBridge.browserState(session.id))}`,
    );
    checks.push([
      "装不下时横条上真的有「适应宽度」出口，且它落在可视区内可点（不是只存在于 DOM）",
      (await fitState()).hittable,
    ]);

    checks.push(["点「适应宽度」命中", await clickHittable("[data-browser-fit]")]);
    await sleep(1000);
    const clampZoom = await zoomBadge();
    const clampArea = await readAreaRect();
    const clampIw = await pageInnerWidth();
    // 最窄栏里要装下 700px 的页面得缩到约 31%，那已经认不出字了，故比例被钳在可读下限 60%：
    // 页面**确实**缩了（CSS 视口从 219 变成 ≈365），但**仍然装不下**——这时界面必须如实说，
    // 不能假装成功，也不能留一个再按也不会变化的按钮。
    const expectClampIw = clampArea === null ? null : Math.round(clampArea.width / 0.6);
    log(
      `  [适应宽度] 顶到下限：缩放 ${clampZoom}%，页面 CSS 视口 ${clampIw}（期望 ${expectClampIw}）`,
    );
    checks.push([
      `点「适应宽度」后页面真的缩了（区域宽 ${clampArea?.width} → 页面 CSS 视口 ${clampIw}）`,
      clampZoom === 60 &&
        clampIw !== null &&
        expectClampIw !== null &&
        Math.abs(clampIw - expectClampIw) <= 2,
    ]);
    const clampedClip = await clippedBadge();
    log(`  [适应宽度] 顶到下限后横条：${JSON.stringify(clampedClip)}`);
    checks.push([
      "顶到最小可读比例仍装不下时，横条改为如实说明「已经缩到 60%」",
      clampedClip !== null && clampedClip.text.includes("60%"),
    ]);
    checks.push([
      "此时不再摆一个再按也不会变化的「适应宽度」（死控件比缺失更伤信任）",
      (await fitState()).present === false,
    ]);
    checks.push(["缩放期间原生视图仍与页面区域逐像素对齐", await alignedNow()]);

    // 把右栏拉到「缩得动」的宽度：装下 needPx 需要缩到 needPx×60% 以上，又要窄于 needPx
    // 才看得到「缩了但不是 100%」这个中间态。取 500。
    const midTarget = 500;
    await dragGrip(Math.round((clampArea?.width ?? 219) - midTarget));
    await sleep(1000);
    const midArea = await readAreaRect();
    const midZoom = await zoomBadge();
    const midIw = await pageInnerWidth();
    log(
      `  [适应宽度] 拉宽到 ${midArea?.width}：缩放 ${midZoom}%，页面 CSS 视口 ${midIw}（页面需要 ${needPx}）`,
    );
    // 「比例跟着宽度重算」是这条的关键：缩放期间**不重量** contentWidth（那是页面在 100% 下的
    // 固有属性，缩放后量会得出「本来就装得下」的假象，进而把缩放退回去来回震荡），但比例必须用
    // 新宽度重算。若它停在 60% 不动，页面 CSS 视口会是区域宽÷0.6 ≈ 833 而不是 needPx。
    checks.push([
      `右栏拉宽后比例自动重算到刚好装满（区域 ${midArea?.width}，缩放 ${midZoom}%，页面 CSS 视口 ${midIw} ≈ 需要宽 ${needPx}）`,
      midArea !== null &&
        needPx > 0 &&
        midArea.width >= Math.ceil(needPx * 0.6) &&
        midArea.width < needPx &&
        midZoom !== null &&
        midZoom > 60 &&
        midZoom < 100 &&
        midIw !== null &&
        Math.abs(midIw - needPx) <= 8,
    ]);
    checks.push(["缩到刚好装满后横条自己消失（不是常驻灰条）", (await clippedBadge()) === null]);
    checks.push(["缩放状态下原生视图仍与页面区域逐像素对齐", await alignedNow()]);

    // 「还原」出口必须**常驻工具条**而不是挂在横条上：一旦缩到装下，横条就自己消失了，
    // 还原入口若跟着横条走，用户按完「适应宽度」就再也回不去（只能刷页面）。
    checks.push(["缩到装下之后，工具条上仍留着「还原」出口", await clickHittable("[data-browser-zoom-reset]")]);
    await sleep(1000);
    const backArea = await readAreaRect();
    const backIw = await pageInnerWidth();
    log(`  [适应宽度] 还原后：缩放 ${await zoomBadge()}%，页面 CSS 视口 ${backIw}，区域 ${backArea?.width}`);
    checks.push([
      `「还原」后回到 100%（工具条缩放指示消失，页面 ${backIw} 重新等于区域宽 ${backArea?.width}）`,
      (await zoomBadge()) === null &&
        backArea !== null &&
        backIw !== null &&
        Math.abs(backIw - backArea.width) <= 20,
    ]);
    checks.push([
      "「还原」后横条回来、并重新给出「适应宽度」出口",
      (await clippedBadge()) !== null && (await fitState()).present,
    ]);

    // 复原成最窄，别把「右栏较宽」这个上下文留给后面的段落
    await dragGrip(10000);
    await sleep(400);

    // ---- `/compact` 斜杠命令（手动上下文压缩）----
    // 压缩链路本身早已存在（`session.compact` → worker 的 compact 分支），本条验的是
    // **输入框能不能把它叫出来**，以及「未知 / 带参数的写法会不会被误吞」。
    //
    // 判据不用界面文字，直接在 `sessionManager` 上打桩计数：命令是否被识别、
    // 以及它是走了压缩还是被当成普通提问发出（后者会打到 `promptOrReconnect`）。
    // 打桩跑完立刻恢复，不残留到其他段落。
    //
    // ⚠️ 打桩**只记账、不转发**（v1.41 订正）。原先三个桩都转给了真实现，代价是：
    //   · 每次跑 `dock` 都会**真打一次模型**——`/compact 帮我看看` 与 `/usr/local/bin/node`
    //     两句是**真 prompt**（实测会话记录里带着 provider / modelId / usageId），而这本是个
    //     「不调用模型、不产生计费」的模式；`dock` 也因此变成**唯一会给用户账单的动作**。
    //   · 这两句测试文本会写进**用户真实项目里的真实会话历史**，混在侧栏的会话列表里。
    // 而这三条断言问的都是「渲染层选了哪条路径」，与真发无关——转发是多余的。
    const compactCalls: string[] = [];
    const promptCalls: string[] = [];
    const realCompact = sessionManager.compact.bind(sessionManager);
    const realCompactOrReconnect = sessionManager.compactOrReconnect.bind(sessionManager);
    const realPromptOrReconnect = sessionManager.promptOrReconnect.bind(sessionManager);
    sessionManager.compact = (id: string) => {
      compactCalls.push(id);
    };
    sessionManager.compactOrReconnect = async (id: string) => {
      compactCalls.push(id);
    };
    sessionManager.promptOrReconnect = async (_id: string, text: string) => {
      promptCalls.push(text);
    };

    /** 把文本敲进输入框并回车——用真实事件驱动，走的是用户那条按键通道 */
    const typeAndEnter = (text: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const ta = document.querySelector("textarea");
        if (!ta) return false;
        // React 受控组件：必须用原生 setter 写值再派发 input，否则 onChange 收不到
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }));
        return true;
      })()`);

    const inputValue = (): Promise<string> =>
      run<string>(`(document.querySelector("textarea") || {}).value ?? ""`);
    const slashButton = (): Promise<boolean> =>
      run<boolean>(
        `!!document.querySelector('[data-slash-command="compact"]')`,
      );

    /** 只把文本写进输入框、**不回车**（`/` 候选浮层要在「还没提交」的状态下观察） */
    const typeText = (text: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const ta = document.querySelector("textarea");
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);

    /** 单独敲一个键（浮层的方向键 / Enter / Esc 都要在不改文本的情况下派发） */
    const pressKey = (key: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const ta = document.querySelector("textarea");
        if (!ta) return false;
        ta.focus();
        ta.dispatchEvent(new KeyboardEvent("keydown", {
          key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
        }));
        return true;
      })()`);

    // 命令的可见入口必须真能点（且它自己也走同一条 compact 路径）
    checks.push(["输入区有 /compact 的可点入口", await slashButton()]);

    // ① 裸 `/compact`：应走压缩，输入框被消费，且不发普通提问
    compactCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/compact");
    await sleep(400);
    checks.push([
      "敲 /compact 回车 → 真的派发了上下文压缩",
      compactCalls.includes(session.id),
    ]);
    checks.push(["/compact 不会被当成普通提问发出去", promptCalls.length === 0]);
    checks.push(["命令输入框被清空（已消费，不会滞留）", (await inputValue()) === ""]);

    // ② 带正文的 `/compact ...`：必须回落成普通提问。
    // 这条是**防误吞**：若只按前缀匹配，用户写「用 /compact 压缩一下」这句话就永远发不出去了。
    compactCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/compact 帮我看看");
    await sleep(400);
    checks.push([
      "带正文的 /compact … 不被当成命令（回落成普通提问）",
      compactCalls.length === 0 && promptCalls.some((t) => t.includes("/compact 帮我看看")),
    ]);

    // ③ 未知命令同样放行：贴路径（/usr/...）是很常见的输入
    compactCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/usr/local/bin/node");
    await sleep(400);
    checks.push([
      "以 / 开头的普通文本（如路径）照常发出",
      compactCalls.length === 0 && promptCalls.some((t) => t === "/usr/local/bin/node"),
    ]);
    log(`  /compact 打桩：compact=${compactCalls.length}，prompt=${promptCalls.length}`);

    // ---- `/memory-tidy` 斜杠命令（显式整理记忆，L3b）----
    // 与 /compact 同一条验证思路：命令识别在渲染层本地，路径选择要在 sessionManager
    // 上打桩才看得见。同样**只记账、不转发**——整理是一次真实模型调用，
    // 转发就破坏了「dock 不打模型、不计费」的约定（v1.41 的教训）。
    const tidyCalls: string[] = [];
    const realMemoryTidy = sessionManager.memoryTidy.bind(sessionManager);
    const realMemoryTidyOrReconnect = sessionManager.memoryTidyOrReconnect.bind(sessionManager);
    sessionManager.memoryTidy = (id: string) => {
      tidyCalls.push(id);
    };
    sessionManager.memoryTidyOrReconnect = async (id: string) => {
      tidyCalls.push(id);
    };

    tidyCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/memory-tidy");
    await sleep(400);
    checks.push(["敲 /memory-tidy 回车 → 派发了记忆整理", tidyCalls.includes(session.id)]);
    checks.push(["/memory-tidy 不会被当成普通提问发出去", promptCalls.length === 0]);
    checks.push(["/memory-tidy 输入框被清空（已消费，不会滞留）", (await inputValue()) === ""]);

    // 带正文不算命令：与 /compact 同一条防误吞规则（零参数命令必须独占整条输入）
    tidyCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/memory-tidy 顺便删掉过时的");
    await sleep(400);
    checks.push([
      "带正文的 /memory-tidy … 不被当成命令（回落成普通提问）",
      tidyCalls.length === 0 && promptCalls.some((t) => t.includes("/memory-tidy 顺便删掉过时的")),
    ]);

    // 本段自己的桩立即恢复；promptOrReconnect 的桩还要服务后面的 /skill 段
    sessionManager.memoryTidy = realMemoryTidy;
    sessionManager.memoryTidyOrReconnect = realMemoryTidyOrReconnect;
    // 与 /compact 段同款：打的是**最终态**——上一条带正文的输入应回落成了普通提问
    log(`  /memory-tidy 打桩：tidy=${tidyCalls.length}，prompt=${promptCalls.length}`);

    // ---- `/skill` 斜杠命令（显式调用技能）----
    // 「技能」在内核里是**两条互不相干的通道**：模型能不能看见清单（靠应用自己把
    // `formatSkillsForSystemPrompt` 拼进系统提示词），与 `resources.skills` 提供的
    // 「按名显式调用」完全是两码事——详见 ARCHITECTURE §四。本条验的是**输入框能不能
    // 把后者叫出来**，以及三个最容易出事的边界：
    //   · 名字打错 → **就地拦下**：不发 IPC、**输入一个字都不丢**（v1.43 修掉的那件事：
    //     原先先清空再发，worker 报错时用户已经白敲了一整句），且错误可见、点出正确写法；
    //   · 只写 `/skill`（没给名字）→ 必须回落成普通提问（防误吞，与 `/compact …` 那条对称）。
    // 「错误文案里带不带可用技能名」由 tests/skill-error.test.ts 断言——纯字符串逻辑，
    // 不必为它真拉一个 worker 进程起来（与上面 `/compact` 同理：打桩**只记账、不转发**）。
    const skillCalls: { name: string; instructions: string | undefined }[] = [];
    const realSkill = sessionManager.skill.bind(sessionManager);
    const realSkillOrReconnect = sessionManager.skillOrReconnect.bind(sessionManager);
    sessionManager.skill = (_id: string, name: string, instructions: string | undefined) => {
      skillCalls.push({ name, instructions });
    };
    sessionManager.skillOrReconnect = async (
      _id: string,
      name: string,
      instructions: string | undefined,
    ) => {
      skillCalls.push({ name, instructions });
    };

    // **前置**：本地拦截的前提是渲染层手里有本会话的技能清单，而清单只在 worker 起来后
    // 才上报。先单独断言这条，否则环境里没有可用模型服务时，下面的红是**假红**——
    // 会被误读成「拦截坏了」（`AGENTS.md` §1.2：先怀疑前置，别先改被测对象）。
    const skillsKnown = Array.isArray(sessionManager.getView(session.id)?.skills);
    checks.push(["前置：本会话视图已带技能清单（本地拦截据此才能成立）", skillsKnown]);

    // ① 名字打错：**就地拦下**——不发 IPC、也不变成普通提问、输入原样留着
    compactCalls.length = 0;
    promptCalls.length = 0;
    skillCalls.length = 0;
    await typeAndEnter("/skill no-such-skill-colt");
    await sleep(400);
    checks.push([
      "敲 /skill <未知名> → 本地拦下（既没走技能 IPC，也没变成普通提问）",
      skillCalls.length === 0 && promptCalls.length === 0,
    ]);
    checks.push([
      "拦下时输入**原样留着**（改一个字母就能重敲，不必整句重打）",
      (await inputValue()) === "/skill no-such-skill-colt",
    ]);
    const skillError = await run<string>(
      `(document.querySelector("[data-conv-error]")?.textContent ?? "")`,
    );
    checks.push([
      "错误可见且**点出正确写法**（报出打错的名字 / 或说清技能该放哪）",
      skillError.includes("技能「no-such-skill-colt」不存在"),
    ]);

    // ② 那半句额外指示也不能跟着丢——这正是用户报的现象（打错一个字母，白敲一整句话）
    await typeAndEnter("/skill no-such-skill-colt 只改这一处");
    await sleep(400);
    checks.push([
      "名字后那半句额外指示也留在输入里（整句没丢）",
      (await inputValue()) === "/skill no-such-skill-colt 只改这一处",
    ]);

    // ③ 只写 `/skill`：不给名字就不算命令 → 回落成普通提问（防误吞）
    skillCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/skill");
    await sleep(400);
    checks.push([
      "裸 /skill（没给名字）回落成普通提问，不被吞掉",
      skillCalls.length === 0 && promptCalls.some((text) => text === "/skill"),
    ]);
    log(
      `  /skill：清单已知=${skillsKnown}，打桩 skill=${skillCalls.length}，prompt=${promptCalls.length}`,
    );

    // ---- `/` 候选浮层：技能**唯一的可发现入口**（v1.44）----
    // 上面验的是「打错名字会不会丢输入」，这里验的是**用户怎么知道有哪些技能**。
    // 它必须走完**整条链**：敲 / → 弹出 → 选中 → 写入输入框 → 回车真的走技能 IPC。
    // 少任何一环这个入口就是死的（`AGENTS.md` §3.6），只断言「浮层出现了」等于没验「选中能不能用」。
    //
    // 夹具里那个真实会话**一个技能都没装**（本仓没有 `.agents/skills`），所以这里推一份
    // **带技能**的受控视图——`smokeView()` 会整份替换渲染层那份视图，`skills` 必须显式给，
    // 否则浮层只会列 `/compact`（见 `AGENTS.md` ⑪）。
    const MENU_SKILLS = ["pdf", "code-review"];
    window.webContents.send("session.view", smokeView({ skills: MENU_SKILLS }));
    await sleep(400);
    const menuItems = (): Promise<string[]> =>
      run<string[]>(
        `[...document.querySelectorAll("[data-slash-menu] [data-slash-item]")]` +
          `.map((el) => el.getAttribute("data-slash-item") ?? "")`,
      );

    await typeText("/");
    await sleep(250);
    checks.push([
      "敲 / 弹出候选：/compact + /memory-tidy + 本会话每个技能各一项",
      JSON.stringify(await menuItems()) ===
        JSON.stringify(["/compact", "/memory-tidy", "/skill pdf", "/skill code-review"]),
    ]);
    // 「在 DOM 里」不等于「用户点得到」——浮层是绝对定位、祖先里还有 overflow-hidden，
    // 所以做命中测试：候选的中心点上最上面那一层必须是它自己（同小目标入口那条老坑）。
    checks.push([
      "候选真的落在可视区且点得到（不是只存在于 DOM）",
      await run<boolean>(`(() => {
        const item = document.querySelector("[data-slash-menu] [data-slash-item]");
        if (!item) return false;
        const r = item.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!at && (at === item || item.contains(at));
      })()`),
    ]);

    // ⚠️ 这条是本段的要害：**浮层开着时 Enter 是「选中」，不是「发送」**。
    // 不拦这一下，用户选中技能的那次回车会把半截命令（`/skill pd`）当正文发出去——
    // 技能没调用、输入也没了，是比「按了没反应」更糟的一种失败。
    promptCalls.length = 0;
    skillCalls.length = 0;
    await typeText("/skill pd");
    await sleep(250);
    await pressKey("Enter");
    await sleep(300);
    checks.push([
      "浮层开着时 Enter 是「选中」：既没当正文发出去，也没提前调用技能",
      promptCalls.length === 0 && skillCalls.length === 0,
    ]);
    checks.push([
      "选中后命令写回输入框，且带尾随空格（好接着写那半句额外指示）",
      (await inputValue()) === "/skill pdf ",
    ]);
    checks.push([
      "光标停在末尾（额外指示是接着打的，不会被插到中间）",
      await run<boolean>(
        `(() => { const ta = document.querySelector("textarea");
                  return !!ta && ta.value.length > 0 && ta.selectionStart === ta.value.length; })()`,
      ),
    ]);
    checks.push(["选中后浮层自己收起（不用再按一次 Esc）", (await menuItems()).length === 0]);

    // 选中之后那段输入必须真的**能用**——这才是「不是死控件」的判据
    promptCalls.length = 0;
    skillCalls.length = 0;
    await pressKey("Enter");
    await sleep(400);
    checks.push([
      "选中后直接回车 → 真的走技能 IPC（浮层已收起，Enter 回到「发送」语义）",
      skillCalls.length === 1 &&
        skillCalls[0]?.name === "pdf" &&
        promptCalls.length === 0,
    ]);

    // 路径不弹浮层：否则每次贴 `/usr/...` 都会跳一个菜单出来（v1.34 的防误吞同理）
    await typeText("/usr/local");
    await sleep(250);
    checks.push([
      "以 / 开头的路径**不弹浮层**（一个候选都匹配不上）",
      (await menuItems()).length === 0,
    ]);

    await typeText("/");
    await sleep(250);
    checks.push(["前置：Esc 用例之前浮层确实开着", (await menuItems()).length > 0]);
    await pressKey("Escape");
    await sleep(250);
    checks.push([
      "Esc 只收起浮层、**不动输入**（清空输入是另一件事，不能顺手替用户决定）",
      (await menuItems()).length === 0 && (await inputValue()) === "/",
    ]);

    // 整条命令已敲全 → 浮层让开。少了这条，用户敲对 `/compact` 之后回车会被「选中」吃掉，
    // **得先按 Esc 才发得出去**——命令没问题，却被浮层拦住，是最难自查的一种。
    compactCalls.length = 0;
    promptCalls.length = 0;
    await typeText("/compact");
    await sleep(250);
    checks.push([
      "整条命令已敲全 → 浮层让开（否则回车会被「选中」吃掉）",
      (await menuItems()).length === 0,
    ]);
    await pressKey("Enter");
    await sleep(400);
    checks.push([
      "/compact 敲全后回车照常压缩（Enter 的默认语义没被浮层改掉）",
      compactCalls.includes(session.id),
    ]);
    log(
      `  / 候选浮层：清单=${MENU_SKILLS.join("、")}，最后 skill=${skillCalls.length}，prompt=${promptCalls.length}`,
    );

    // 复原打桩，避免影响后续断言（dock 到此也接近尾声）
    sessionManager.compact = realCompact;
    sessionManager.compactOrReconnect = realCompactOrReconnect;
    sessionManager.promptOrReconnect = realPromptOrReconnect;
    sessionManager.skill = realSkill;
    sessionManager.skillOrReconnect = realSkillOrReconnect;

    // ---- ①「等待授权」必须被看见（v1.39）----
    // 「等待授权」是本产品唯一需要用户**立刻拍板**的状态，且有 5 分钟超时；
    // 只显示「运行中 · mm:ss」会让人以为它在正常干活。这里走**真实事件通道**
    // （与 session.view 那批同样），断言侧栏确实改口，而不是直接去改 DOM。
    log("[等待授权] 推 approval.pending：侧栏应改口并在清空后自己摘掉");
    const pendingRequest: ApprovalRequest = {
      toolCallId: "smoke-approval-1",
      sessionId: session.id,
      toolName: "write",
      argsJson: '{"path":"src/main/index.ts"}',
      summary: "写入 src/main/index.ts",
      risk: "moderate",
      reason: "冒烟夹具",
      signature: "smoke:approval",
      requestedAt: Date.now(),
      timeoutMs: 300_000,
    };
    window.webContents.send("approval.pending", {
      sessionId: session.id,
      requests: [pendingRequest],
    });
    await sleep(250);
    const waitingText = "等待你的授权";
    checks.push([
      "有待审时侧栏标出「等待你的授权」",
      await run<boolean>(`document.body.innerText.includes(${JSON.stringify(waitingText)})`),
    ]);
    // 清空后必须自己摘掉：一条不会消失的「等待授权」比没有信号更糟（它会一直撒谎）
    window.webContents.send("approval.pending", { sessionId: session.id, requests: [] });
    await sleep(250);
    checks.push([
      "待审清空后「等待你的授权」随之消失",
      !(await run<boolean>(`document.body.innerText.includes(${JSON.stringify(waitingText)})`)),
    ]);

    // ---- ② 附件「没进来」必须说出来（v1.39）----
    // 附件通道只承载图片，非图片过去是**静默 return**：往输入框拖一个 PDF 什么都没发生，
    // 用户只会以为程序坏了。提示还必须落在**输入卡片内**——顶部那条 error 在消息
    // 滚到底时不在视野里，等于没说。
    log("[附件] 拖入非图片 / 混合拖入：提示要落在输入卡片内");
    const dropFiles = (
      specs: { name: string; type: string }[],
    ): Promise<{ notice: string | null; inCard: boolean; alts: string[] }> =>
      run(`(async () => {
        // 按卡片**自己的标记**认（v1.44 起 textarea 外面多了一层 relative 容器，
        // 「输入框的父节点」不再是卡片——见 §5 第 3 条里那处同源的说明）
        const card = document.querySelector("[data-conv-card]");
        const data = new DataTransfer();
        ${specs
          .map(
            (item, index) =>
              `data.items.add(new File([new Uint8Array([137, 80, 78, 71, ${index}])], ${JSON.stringify(item.name)}, { type: ${JSON.stringify(item.type)} }));`,
          )
          .join("\n        ")}
        card.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const notice = card.querySelector("[data-conv-attach-notice]");
        return {
          notice: notice ? notice.textContent : null,
          inCard: notice !== null,
          alts: [...card.querySelectorAll("img[alt]")].map((node) => node.getAttribute("alt")),
        };
      })()`);

    const pdfOnly = await dropFiles([{ name: "需求说明.pdf", type: "application/pdf" }]);
    checks.push([
      "拖入非图片：输入卡片内直接点名被跳过的文件",
      pdfOnly.inCard && (pdfOnly.notice ?? "").includes("需求说明.pdf"),
    ]);
    checks.push(["非图片不会被静默塞成附件", pdfOnly.alts.length === 0]);

    const mixed = await dropFiles([
      { name: "shot.png", type: "image/png" },
      { name: "契约.pdf", type: "application/pdf" },
    ]);
    checks.push([
      "图片照常进附件，同时点名被跳过的非图片",
      mixed.alts.includes("shot.png") && (mixed.notice ?? "").includes("契约.pdf"),
    ]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    // 先出结论再清理：清理出岔子也不该吞掉已拿到的证据
    log("[dock] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
    void server.close();
  }
}

/** 多会话并行 + 分支导航 */
async function runAdvanced(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const first = createSession(projectId, sessionsDir);
  const second = createSession(projectId, sessionsDir);
  log(`会话 A：${first.id}`);
  log(`会话 B：${second.id}`);

  window.reload();
  await sleep(4000);

  // 两个会话同时开工，验证 worker 进程池并行
  log("并行发起两个会话…");
  const started = Date.now();
  await run(`Promise.all([
    window.colt.invoke("session.open", ${JSON.stringify({ sessionId: first.id, cwd: process.env.COLT_SMOKE_CWD })}),
    window.colt.invoke("session.open", ${JSON.stringify({ sessionId: second.id, cwd: process.env.COLT_SMOKE_CWD })})
  ])`);
  log(`两个 worker 就绪，耗时 ${Date.now() - started}ms`);

  await run(`Promise.all([
    window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "说出数字 1，只回一个字" })}),
    window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: second.id, text: "说出数字 2，只回一个字" })})
  ])`);
  await sleep(25000);

  const viewA = await run<{ messages: { role: string; text: string }[] } | null>(
    `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
  );
  const viewB = await run<{ messages: { role: string; text: string }[] } | null>(
    `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: second.id })})`,
  );
  log(`会话 A 消息数：${viewA?.messages.length}，末条：${viewA?.messages.at(-1)?.text.slice(0, 40)}`);
  log(`会话 B 消息数：${viewB?.messages.length}，末条：${viewB?.messages.at(-1)?.text.slice(0, 40)}`);

  // 分支：在会话 A 再问一轮，然后跳回第一个用户节点形成分叉
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "再说出数字 3，只回一个字" })})`,
  );
  await sleep(20000);

  type Node = { id: string; kind: string; summary: string; isTip: boolean; onActivePath: boolean };
  const before = await run<Node[]>(
    `window.colt.invoke("session.branches", ${JSON.stringify({ sessionId: first.id })})`,
  );
  log(`分支节点数（分叉前）：${before.length}`);
  for (const node of before) {
    log(`  ${node.isTip ? "→" : " "} [${node.kind}] ${node.summary.slice(0, 40)}`);
  }

  const target = before.find((node) => node.kind === "user");
  if (target) {
    log(`跳转到首个用户节点：${target.id}`);
    await run(
      `window.colt.invoke("session.navigate", ${JSON.stringify({ sessionId: first.id, targetId: target.id })})`,
    );
    await sleep(4000);

    const mid = await run<{ running: boolean; messages: { role: string; text: string }[] } | null>(
      `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
    );
    log(`跳转后：running=${mid?.running}，消息数=${mid?.messages.length}`);

    // 跳转后再提问，应当形成新分支而不是覆盖原有记录
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "改说字母 X，只回一个字" })})`,
    );
    await sleep(25000);

    const post = await run<{ running: boolean; messages: { role: string; text: string }[] } | null>(
      `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
    );
    log(`新分支提问后：running=${post?.running}，消息数=${post?.messages.length}`);
    for (const message of post?.messages ?? []) {
      log(`    [${message.role}] ${message.text.slice(0, 40)}`);
    }

    const after = await run<Node[]>(
      `window.colt.invoke("session.branches", ${JSON.stringify({ sessionId: first.id })})`,
    );
    log(`分支节点数（分叉后）：${after.length}`);
    log(`活跃路径节点数：${after.filter((node) => node.onActivePath).length}`);
    log(`离线分支节点数：${after.filter((node) => !node.onActivePath).length}`);
  }

  // 切到会话 A 并打开分支面板，让验收截图能看到分叉结构
  await run(`(() => {
    const items = [...document.querySelectorAll("button")];
    items.find((b) => b.textContent.includes("说出数字 1"))?.click();
    return true;
  })()`);
  await sleep(2500);
  await run(`(() => {
    const buttons = [...document.querySelectorAll("button")];
    buttons.find((b) => b.textContent.trim() === "分支")?.click();
    return true;
  })()`);
  await sleep(1500);
}

async function report(
  sessionId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
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
 * 故障注入冒烟：让 worker 在发回就绪事件前就退出，
 * 验证 session.open 会「快速失败」而不是永久挂起（否则界面卡在启动提示）。
 */
async function runCrash(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}`);
  window.reload();
  await sleep(4000);

  const startedAt = Date.now();
  // 包一层超时：修复前这里会永久 pending，超时能把它暴露出来
  const result = await run<string>(`
    (async () => {
      const timeout = new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 15000));
      const attempt = window.colt
        .invoke("session.open", ${JSON.stringify({ sessionId: session.id, cwd: process.env.COLT_SMOKE_CWD })})
        .then(() => "OK")
        .catch((e) => "REJECTED: " + e.message);
      return Promise.race([attempt, timeout]);
    })()
  `);
  log(`session.open 结果：${result}（耗时 ${Date.now() - startedAt}ms）`);
  if (result === "TIMEOUT") {
    log("缺陷未修复：open 永久挂起，界面会卡在启动提示");
  } else if (String(result).startsWith("REJECTED")) {
    log("正确：open 快速失败，界面可提示错误而非无限转圈");
  }
}

/**
 * 跨会话记忆检索（L3a）端到端冒烟：不开模型，验真实跨进程链路。
 *
 * worker 由真实 utilityProcess 拉起（与生产同一条 session.open 通道），启动时读两级
 * 记忆文件并上报 memoryIndex；主进程落派生库（data/memory.db）后，检索走 hostBridge
 * 的 memory 能力——与 worker 里 memory_search 工具是同一条 toolRpc 路由。
 * 这条链路单测够不到：worker 是独立进程，「库开没开」「消息走没走到」只有真实链路能作证。
 *
 * 用户级不注入夹具：真家目录 ~/.colt/memory.md 内容不可控、也不可写（写就是污染用户数据），
 * 它与项目级共用同一条消息与处理路径，行为由单测覆盖；本机有真实用户记忆时它只会
 * 多出「用户级」条目，所有断言都用 some/includes，不受影响。
 * 夹具目录固定在 out/ 下（gitignored）：重复跑同一条目 upsert 幂等，不产生新垃圾。
 */
async function runMemory(
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-memory-fixture");
  const memoryPath = join(fixtureDir, ".colt", "memory.md");
  const fixtureKey = normalizeRootKey(fixtureDir);
  mkdirSync(join(fixtureDir, ".colt"), { recursive: true });
  const fixtureEntries = [
    "部署流程：先 pnpm build，再 pnpm dist",
    "约定：汇报用中文",
    "冒烟夹具说明：本目录仅用于记忆链路验证",
  ];
  writeFileSync(memoryPath, `# 项目记忆（冒烟夹具）\n\n${fixtureEntries.join("\n")}\n`, "utf8");
  log(`夹具记忆：${memoryPath}`);
  log(`FTS5 可用：${isFts5Available()}（false 时全部走 LIKE 兜底，断言两种情况都成立）`);

  // 对照项目：往库里塞一条**别的项目**的记忆，证明「检索不到它」是隔离层强制，
  // 而不是「库里恰好没有」。跑完删掉（派生库，残留一行无害，但能删就删干净）。
  const foreignKey = normalizeRootKey(join(fixtureDir, "对照项目"));
  indexMemorySnapshot({
    scope: "project",
    projectKey: foreignKey,
    sourcePath: join(fixtureDir, "对照项目", ".colt", "memory.md"),
    sessionId: "smoke-memory",
    content: "另一个项目的私有部署密钥：never-match-smoke",
  });

  const checks: [string, boolean][] = [];
  // 会话建在**夹具自己的项目**下，这是绕开两条渲染层竞态的关键：
  // ① App 挂载时会自动选中「当前项目」的 list[0] 并以项目 rootPath 为 cwd 打开——
  //    若会话挂在仓库项目下且恰逢列表响应晚于建会话，渲染层会抢先打开我们的会话，
  //    而 Conversation 卸载即 session.close（StrictMode 下挂载→卸载→重挂载），
  //    worker 会在就绪前被杀，重开的 cwd 还是仓库根（首轮 6/10、二轮全崩的共同根因）。
  // ② worker 复用分支只同步模型、不校验 cwd——先到者定 cwd，后来者被静默忽略。
  // 夹具项目下渲染层要么不来看（当前项目是仓库），要么来看时 cwd 恰好也是夹具目录：
  // 无论哪种时序，所有 fork 的 cwd 都正确。
  const fixtureProject = upsertProject(fixtureDir);
  // 渲染层初始 activeProject = project.list[0]（最近打开优先，App.tsx 挂载时选定）。
  // 夹具项目刚被 upsert 刷新了「最近打开」，会把渲染层引到夹具项目上——它便自动打开
  // 我们刚建的会话，而 Conversation 卸载即 session.close（StrictMode 下挂载→卸载→重挂载），
  // 就绪前的 worker 当场被杀（探针证据：dispose reason=closed）。把仓库项目顶回 list[0]，
  // 渲染层就去忙它自己的旧会话，不再碰这个会话。
  upsertProject(process.env.COLT_SMOKE_CWD ?? process.cwd());
  const session = createSession(
    fixtureProject.id,
    join(app.getPath("userData"), "sessions", fixtureProject.id),
  );
  log(`会话：${session.id}（项目：${fixtureProject.name}）`);

  try {
    await run(
      `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: session.id, cwd: fixtureDir })})`,
    );

    // worker 启动即上报（不等模型发话），落库是异步的：轮询到出现为止
    let firstHit: MemoryHit | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      firstHit = searchMemory({ projectKey: fixtureKey, query: "部署流程" }).find(
        (hit) => hit.content === fixtureEntries[0],
      );
      if (firstHit) break;
      await sleep(500);
    }
    checks.push(["worker 启动即上报项目记忆并落库（真实跨进程链路）", firstHit !== undefined]);
    if (firstHit) {
      checks.push(
        [
          "入库行字段正确（scope/status/sourcePath）",
          firstHit.scope === "project" &&
            firstHit.status === "active" &&
            firstHit.sourcePath === memoryPath,
        ],
      );
    }

    // 查询两条路都要通：≥3 字走 FTS（或降级 LIKE），二字词恒走 LIKE（trigram 3 字下限）
    const twoChar = searchMemory({ projectKey: fixtureKey, query: "约定" });
    checks.push(["二字词走 LIKE 兜底命中", twoChar.some((hit) => hit.content === fixtureEntries[1])]);
    const latin = searchMemory({ projectKey: fixtureKey, query: "pnpm" });
    checks.push(["拉丁词查询命中", latin.some((hit) => hit.content === fixtureEntries[0])]);

    // 能力路由：与 worker 的 memory_search 同一条 hostBridge 通道
    const viaHost = await hostBridge.handle({
      sessionId: session.id,
      capability: "memory",
      action: "search",
      params: { query: "部署流程" },
    });
    log(`memory.search：${viaHost.text.split("\n")[0]}`);
    checks.push([
      "hostBridge memory 检索命中且格式带「项目·现行」",
      viaHost.text.includes("项目·现行") && viaHost.text.includes(fixtureEntries[0]),
    ]);
    const miss = await hostBridge.handle({
      sessionId: session.id,
      capability: "memory",
      action: "search",
      params: { query: "绝不匹配的词组xyz" },
    });
    checks.push(["无匹配时给「没有匹配」文案", miss.text.startsWith("没有匹配")]);

    // 项目隔离：对照条目在库里（换个 projectKey 直查能见到），hostBridge 检索却看不见
    const foreignDirect = searchMemory({ projectKey: foreignKey, query: "私有部署密钥" });
    checks.push(["对照项目条目确实在库里（隔离不是空库巧合）", foreignDirect.length === 1]);
    const foreignViaHost = await hostBridge.handle({
      sessionId: session.id,
      capability: "memory",
      action: "search",
      params: { query: "私有部署密钥" },
    });
    checks.push([
      "项目隔离：hostBridge 检索看不到其它项目条目",
      !foreignViaHost.text.includes("never-match-smoke"),
    ]);

    // 关会话：worker 没了，记忆检索上下文必须一起清（否则残留 cwd 继续放行检索）
    const closed = await run<unknown>(
      `window.colt.invoke("session.close", ${JSON.stringify({ sessionId: session.id })})`,
    );
    checks.push(["session.close 成功", JSON.stringify(closed).includes('"closed":true')]);
    await sleep(500);
    const afterClose = await hostBridge
      .handle({
        sessionId: session.id,
        capability: "memory",
        action: "search",
        params: { query: "部署" },
      })
      .then(
        () => "仍然可检索",
        (error: unknown) => `已拒绝：${error instanceof Error ? error.message : String(error)}`,
      );
    log(`关闭后检索：${afterClose}`);
    checks.push(["关闭后记忆上下文已清（检索被拒）", afterClose.startsWith("已拒绝")]);
    checks.push(["关闭会话未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    // 先出结论再清理：删掉对照条目；夹具条目留给下一轮 upsert（同身份幂等覆盖）
    try {
      openMemoryDatabase(app.getPath("userData"))
        .prepare("DELETE FROM memory_entries WHERE project_key = ?")
        .run(foreignKey);
    } catch (error) {
      log(`清理对照条目失败（派生库，无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[memory] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}

/**
 * 记忆端到端（真实调用）——唯一打模型的记忆验证。
 *
 * 免费的 `memory` 模式只验「跨进程链路」（worker→索引→检索），全是结构性断言；
 * 本模式验的是**行为质量**：注入真的让模型「知道」、沉淀真的写对文件并进索引、
 * /memory-tidy 真的合并重复并删过时、被清理的条目真的能从冷层找回。
 * 共四次真实模型调用，**计费**——模式名带 e2e，跑之前想清楚。
 *
 * 夹具预置 5 条记忆：1 条注入探针（密语）+ 2 条语义重复（pnpm）+ 1 条自相矛盾的
 * 过时条目（往一台「已停用删除」的服务器上做每日部署）+ 1 条有效条目。刻意把
 * 「该合并」「该删除」设计成几乎无歧义的形态，把模型非确定性造成的假红降到最低；
 * 偶发不达标时先看落盘文件与回答日志（全量进 log），再定性是用例歧义还是产品缺陷。
 */
async function runMemoryE2e(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-memory-e2e-fixture");
  const memoryPath = join(fixtureDir, ".colt", "memory.md");
  const fixtureKey = normalizeRootKey(fixtureDir);
  mkdirSync(join(fixtureDir, ".colt"), { recursive: true });
  const secretEntry = "项目密语是「菠萝披萨」（用于验证注入，勿删）";
  const keepEntry = "代码注释用中文";
  const duplicateA = "包管理器用 pnpm，不要用 npm";
  const duplicateB = "包管理器固定用 pnpm（工程约定）";
  const staleEntry =
    "部署方式：每天手工 FTP 上传到 old-server.example（该服务器已于 2025-01 停用删除）";
  writeFileSync(
    memoryPath,
    `# 项目记忆（记忆端到端夹具）\n\n${[secretEntry, duplicateA, duplicateB, staleEntry, keepEntry].join("\n")}\n`,
    "utf8",
  );
  log(`夹具记忆：${memoryPath}`);

  const checks: [string, boolean][] = [];
  const fixtureProject = upsertProject(fixtureDir);
  // ⚠️ 刻意**不**把仓库项目顶回 list[0]（与免费 memory 模式相反）：本模式需要渲染层
  // 把这个会话显示出来——/memory-tidy 从输入框走的是「当前会话」，textarea 属于
  // 渲染层自己的 activeSession。夹具项目刚刷新了「最近打开」+ 会话是项目内最新，
  // App 挂载自动打开的就是它，cwd = 项目 rootPath = 夹具目录，恰好正确。
  // StrictMode 的挂载→卸载→重挂载会杀一次就绪前的 worker，重挂载会重新打开——
  // 没有第二个人跟它抢，让它自己收敛即可（免费模式的教训只在不该有人抢时成立）。
  const session = createSession(
    fixtureProject.id,
    join(app.getPath("userData"), "sessions", fixtureProject.id),
  );
  log(`会话：${session.id}（项目：${fixtureProject.name}）`);

  /** 主进程直读视图：不绕渲染层 invoke（那条路慢，还受界面状态影响） */
  const getView = (): ConversationView | undefined => sessionManager.getView(session.id);

  /** 等一轮运行落定。判据：不在运行中，且（终态异常 或 出现了本轮的新助手消息）——
   *  只看 running=false 会把「上一轮已结束」的瞬时状态误判成本轮完成。 */
  const waitRunSettled = async (before: number, timeoutMs: number): Promise<ConversationView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = getView();
      if (view && !view.running) {
        const failed = view.lastRun !== null && view.lastRun.status !== "completed";
        const answered =
          view.messages.length > before &&
          view.messages.some((m, i) => i >= before && m.role === "assistant");
        if (failed || answered) {
          if (failed) {
            log(
              `运行终态异常：${view.lastRun?.status}${view.lastRun?.error ? `（${view.lastRun.error}）` : ""}`,
            );
          }
          return view;
        }
      }
      if (Date.now() > deadline) throw new Error("等待运行结束超时");
      await sleep(2000);
    }
  };

  /** 从视图取最后一条助手回答 */
  const lastAnswer = (view: ConversationView): string => {
    for (let i = view.messages.length - 1; i >= 0; i -= 1) {
      const m = view.messages[i]!;
      if (m.role === "assistant") return m.text;
    }
    return "";
  };

  /** 发一轮真实 prompt（走 IPC 与用户同一条路）并等它落定，返回视图与回答 */
  const askAndSettle = async (text: string, timeoutMs = 180_000) => {
    const before = getView()?.messages.length ?? 0;
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text })})`,
    );
    const view = await waitRunSettled(before, timeoutMs);
    return { view, before, answer: lastAnswer(view) };
  };

  const readMemory = (): string => readFileSync(memoryPath, "utf8");
  const pollFile = async (
    predicate: (text: string) => boolean,
    timeoutMs: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate(readMemory())) return true;
      if (Date.now() > deadline) return false;
      await sleep(2000);
    }
  };
  const pollIndex = async (
    predicate: () => boolean,
    timeoutMs: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() > deadline) return false;
      await sleep(2000);
    }
  };

  /** 把文本敲进输入框并回车（React 受控组件须用原生 setter；同 dock 段的形态） */
  const typeAndEnter = (text: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", bubbles: true, cancelable: true,
      }));
      return true;
    })()`);

  try {
    // 前置检查：没有可用模型时显式失败——真实调用验证不该静默跑成一场空
    if (!hasUsableProvider(listProviders())) {
      checks.push(["前置：存在已配密钥的模型服务（没有就无法真实调用）", false]);
      log("没有已配密钥的模型服务。请先在设置里配好一个服务再跑本模式。");
      return;
    }
    checks.push(["前置：存在已配密钥的模型服务", true]);

    window.reload();
    await sleep(4000);
    // 等渲染层自动打开夹具会话、worker 就绪（视图出现即就绪）
    const readyDeadline = Date.now() + 60_000;
    let opened = false;
    while (Date.now() < readyDeadline) {
      if (getView()) {
        opened = true;
        break;
      }
      await sleep(1000);
    }
    checks.push(["渲染层自动打开夹具会话（worker 就绪）", opened]);
    if (!opened) return;

    // 整理与沉淀都要写记忆文件：夹具会话切 full-access，写路径不被审批卡住。
    // 审批模式是会话级的，只影响这个夹具会话，不碰用户其它会话。
    await run(
      `window.colt.invoke("approval.mode.set", ${JSON.stringify({ sessionId: session.id, mode: "full-access" })})`,
    );

    // ---- TC-A 注入可见性（1 次调用）----
    // 明令禁止工具：模型若读文件就不是「注入生效」的证据，所以工具动用单独断言。
    const tcA = await askAndSettle(
      "测试开始。不要调用任何工具、不要读取任何文件，直接凭你上下文里已有的信息回答：本项目记忆里记的「项目密语」是什么？只回答密语本身。",
    );
    const usedToolsInA = tcA.view.messages.some(
      (m, i) => i >= tcA.before && m.role === "assistant" && m.toolCalls.length > 0,
    );
    log(`TC-A 回答：${tcA.answer}`);
    checks.push(["TC-A 注入：模型没有动用工具（否则注入未被证明）", !usedToolsInA]);
    checks.push(["TC-A 注入：不读文件也答出了记忆里的密语", tcA.answer.includes("菠萝披萨")]);

    // ---- TC-B 沉淀落盘 + 索引同步（1 次调用）----
    const tcB = await askAndSettle(
      "请把这条事实沉淀进项目记忆（.colt/memory.md）：冒烟夹具站的端口固定是 0（SMOKE_PORT_ZERO）。完成后告诉我写好了。",
    );
    log(`TC-B 回答：${tcB.answer}`);
    const sedimented = await pollFile((text) => text.includes("SMOKE_PORT_ZERO"), 60_000);
    checks.push(["TC-B 沉淀：事实真的写进了记忆文件", sedimented]);
    const indexed = await pollIndex(
      () =>
        searchMemory({ projectKey: fixtureKey, query: "SMOKE_PORT_ZERO" }).some(
          (h) => h.status === "active",
        ),
      30_000,
    );
    checks.push(["TC-B 索引同步：新条目可被 memory_search 检索到", indexed]);

    // ---- TC-C 整理（1 次调用，走渲染层输入框——产品真实入口）----
    // 整理跑在子 lane，主视图 running 恒为 false：以**文件落盘**为完成信号，
    // 同时并行盯两类瞬时 DOM（完成通知 / 可见报错），谁先出现都提前收敛。
    let tidyNotice: string | null = null;
    let tidyError: string | null = null;
    const domWatcher = (async () => {
      const deadline = Date.now() + 280_000;
      while (Date.now() < deadline && tidyNotice === null && tidyError === null) {
        const notice = await run<string | null>(
          `(() => { const el = document.querySelector("[data-conv-compact-notice]"); return el ? el.textContent : null; })()`,
        ).catch(() => null);
        if (notice !== null && notice.includes("记忆整理完成")) {
          tidyNotice = notice;
          break;
        }
        const error = await run<string | null>(
          `(() => { const el = document.querySelector("[data-conv-error]"); return el ? el.textContent : null; })()`,
        ).catch(() => null);
        if (error !== null && error.includes("记忆整理")) {
          tidyError = error;
          break;
        }
        await sleep(500);
      }
    })();
    await typeAndEnter("/memory-tidy");
    const tidyOk = await pollFile((text) => {
      const pnpmLines = text.split("\n").filter((l) => l.includes("pnpm"));
      return (
        pnpmLines.length <= 1 &&
        !text.includes("old-server") &&
        text.includes("菠萝披萨") &&
        text.includes(keepEntry)
      );
    }, 240_000);
    await domWatcher;
    checks.push([
      "TC-C 整理：重复合并（pnpm 2→1）、过时删除（old-server）、有效保留（密语/注释）",
      tidyOk,
    ]);
    log(`整理后的记忆文件：\n${readMemory()}`);
    checks.push([
      "TC-C 完成通知出现在界面（子 lane 不可见，通知是唯一结果出口）",
      tidyNotice !== null,
    ]);
    if (tidyError !== null) log(`整理的可见报错：${tidyError}`);
    // 索引口径：被清理的条目就地归档，冷层仍可检索
    const archived = await pollIndex(
      () =>
        searchMemory({ projectKey: fixtureKey, query: "old-server" }).some(
          (h) => h.status === "archived",
        ),
      30_000,
    );
    checks.push(["TC-C 冷层归档：被删条目 archived 且仍可检索", archived]);
    // 改动记录口径：对记忆文件的改写如实落库（SECURITY.md「整理面」的承诺）
    const tidyChanges = listSessionFileChanges(session.id).filter((c) =>
      c.path.replace(/\\/g, "/").endsWith(".colt/memory.md"),
    );
    checks.push([
      "TC-C 改动记录：记忆文件的改写进了会话的文件改动（诚实报告）",
      tidyChanges.length > 0,
    ]);

    // ---- TC-D 冷层检索（1 次调用）----
    // 现行文件此时已无部署条目（TC-C 验过）：答出 old-server 的唯一来源是冷层。
    const tcD = await askAndSettle(
      "不要读取记忆文件。用 memory_search 工具查一下「部署」，告诉我：这个项目以前的部署方式在记忆原文里是怎么写的？引用原文回答。",
    );
    log(`TC-D 回答：${tcD.answer}`);
    checks.push([
      "TC-D 冷层检索：现行已删的条目仍能被 memory_search 答出",
      tcD.answer.includes("old-server"),
    ]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    // 先出结论再清理：夹具条目按 project_key 整段删除（派生库，可随时重建）；
    // 会话行留在库里，与其它冒烟模式一致
    try {
      openMemoryDatabase(app.getPath("userData"))
        .prepare("DELETE FROM memory_entries WHERE project_key = ?")
        .run(fixtureKey);
    } catch (error) {
      log(`清理夹具条目失败（派生库，无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[memory-e2e] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}

/**
 * 切会话回挂冒烟：复现「运行中的会话切走再切回后卡在『正在启动会话进程…』」。
 * 步骤：建长任务会话 → 让它跑起来 → 切到另一个会话 → 再切回来 →
 * 轮询界面上的启动提示是否在合理时间内消失。
 */
async function runReenter(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const busy = createSession(projectId, sessionsDir);
  const other = createSession(projectId, sessionsDir);
  log(`长任务会话：${busy.id}`);
  log(`对照会话：${other.id}`);

  window.reload();
  await sleep(4000);

  // 让 busy 会话真正跑起来（带工具调用，耗时较长），模拟「分析当前项目」
  log("打开长任务会话…");
  await run(
    `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: busy.id, cwd: process.env.COLT_SMOKE_CWD })})`,
  );
  log("让长任务会话开工…");
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: busy.id, text: "分析当前项目：先 ls 列出顶层目录，再读取 package.json，用一句话总结这是什么项目。" })})`,
  );
  await sleep(3000);

  /** 读取界面上的启动提示文本（Conversation 的 opening 态） */
  const startupText = `(() => {
    const el = [...document.querySelectorAll("div")]
      .find((d) => d.textContent && d.textContent.includes("正在启动会话进程"));
    return el ? el.textContent.trim().slice(0, 40) : null;
  })()`;

  const clickSession = (title: string): string =>
    `(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent && x.textContent.includes(${JSON.stringify(title)}));
      if (b) b.click();
      return b !== undefined;
    })()`;

  // 切走：点对照会话（它没有历史，标题是「新会话」或空）
  log("切到对照会话…");
  const switched = await run<boolean>(
    `(() => {
      const rows = [...document.querySelectorAll("aside button")]
        .filter((b) => b.textContent.includes("新会话") || b.textContent.includes("分析当前项目"));
      // 选一个与当前不同的
      const target = rows[rows.length - 1];
      if (target) target.click();
      return rows.length;
    })()`,
  );
  log(`侧栏候选会话数：${switched}`);
  await sleep(1500);

  // 切回 busy 会话：按首条用户消息标题点击
  log("切回长任务会话…");
  const back = await run<boolean>(clickSession("分析当前项目"));
  log(`点回长任务会话：${back}`);

  // 轮询启动提示是否消失
  const deadline = Date.now() + 60000;
  let clearedAt = -1;
  let lastSeen: string | null = null;
  while (Date.now() < deadline) {
    const text = await run<string | null>(startupText);
    if (text === null) {
      clearedAt = Date.now();
      break;
    }
    lastSeen = text;
    await sleep(1000);
  }

  if (clearedAt > 0) {
    log(`启动提示已清掉（耗时约 ${Math.round((clearedAt - (deadline - 60000)) / 1000)}s）`);
  } else {
    log(`启动提示一直未消失，最后看到：${JSON.stringify(lastSeen)}`);
  }

  const view = await run<{ running: boolean; messages: unknown[] } | null>(
    `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: busy.id })})`,
  );
  log(`长任务会话视图：running=${view?.running}，消息数=${view?.messages.length ?? 0}`);
}

/**
 * 审批模式冒烟：验证三条路径
 *   1. 只读命令自动放行，不弹审批
 *   2. 写入类操作被拦下，出现待审条目
 *   3. 用户批准后工具真的执行，文件真的改动
 */
async function runApproval(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  /**
   * 轮询等待待审条目出现。
   * 不用固定 sleep：模型响应快慢不定，赌时长会造成假阴性，
   * 把测试自身的不稳定误当成产品缺陷。
   */
  const waitForPending = async (sessionId: string, timeoutMs: number): Promise<number> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const list = await run<unknown[]>(
        `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId })})`,
      );
      if (list.length > 0) return list.length;
      if (Date.now() > deadline) return 0;
      await sleep(1000);
    }
  };

  /** 列出当前会话调用过的工具名，用于区分「模型没调工具」与「调用未被拦」 */
  const toolTrail = async (sessionId: string): Promise<string> => {
    const view = await run<{ messages: { role: string; toolCalls?: { name: string }[] }[] } | null>(
      `window.colt.invoke("session.view", ${JSON.stringify({ sessionId })})`,
    );
    const names = (view?.messages ?? []).flatMap((message) =>
      (message.toolCalls ?? []).map((call) => call.name),
    );
    return names.length > 0 ? names.join(",") : "（无）";
  };

  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}`);

  window.reload();
  await sleep(4000);

  // 冒烟自检：确认渲染层真的挂上了，而不是一片空白
  const dom = await run<string>(
    `JSON.stringify({ root: document.getElementById("root")?.children.length ?? -1, text: document.body.innerText.slice(0, 120) })`,
  );
  log(`  DOM 自检：${dom}`);
  await run(
    `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: session.id, cwd: process.env.COLT_SMOKE_CWD })})`,
  );

  // ---- 场景一：只读命令应当自动放行 ----
  log("[场景1] 只读命令 ls，预期自动放行");
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({
      sessionId: session.id,
      text: "用 bash 运行 ls -la，只要列目录，不要做别的",
    })})`,
  );
  await sleep(25000);
  const pendingAfterRead = await run<unknown[]>(
    `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  待审条目：${pendingAfterRead.length}（预期 0）`);

  // ---- 场景二：写入应当被拦下 ----
  log("[场景2] 写入 demo.md，预期出现待审");
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({
      sessionId: session.id,
      text: "把 demo.md 末尾追加一行「审批测试」，用 edit 工具",
    })})`,
  );
  const count = await waitForPending(session.id, 60000);

  const pending = await run<{ toolCallId: string; toolName: string; summary: string; risk: string; reason: string }[]>(
    `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  待审条目：${pending.length}（预期 1）`);
  for (const item of pending) {
    log(`  - ${item.toolName} [${item.risk}] ${item.summary} :: ${item.reason}`);
  }

  if (count === 0) {
    // 区分「模型没调 edit」（测试时序）与「调了但未被拦」（产品缺陷）
    log(`  工具调用轨迹：${await toolTrail(session.id)}`);
    log("  未拦截到写入，审批链路异常");
    return;
  }

  // ---- 场景三：批准后工具应真的执行 ----
  // 先截一张待审状态的图，处置后卡片就消失了
  const pendingShot = activeOutputPath.replace(/\.png$/, "-pending.png");
  if (pendingShot) {
    const image = await window.capturePage();
    await writeFile(pendingShot, image.toPNG());
    log(`  待审截图：${pendingShot}`);
  }

  log("[场景3] 批准该调用，预期文件真的被改");
  await run(
    `window.colt.invoke("approval.resolve", ${JSON.stringify({
      sessionId: session.id,
      toolCallId: pending[0]!.toolCallId,
      approved: true,
    })})`,
  );
  await sleep(20000);

  const view = await run<{ fileChanges: { kind: string; path: string; addedLines: number }[] } | null>(
    `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  文件改动：${view?.fileChanges.length ?? 0} 项（预期 >=1）`);
  for (const change of view?.fileChanges ?? []) {
    log(`  - ${change.kind} ${change.path} +${change.addedLines}`);
  }

  const left = await run<unknown[]>(
    `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  处置后待审：${left.length}（预期 0）`);

  // ---- 场景四：拒绝后模型应知悉并继续对话，不能卡死 ----
  log("[场景4] 再次写入并拒绝，预期文件不变、对话继续");
  const changesBefore = view?.fileChanges.length ?? 0;
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({
      sessionId: session.id,
      text: "再把 demo.md 末尾追加一行「第二次追加」，用 edit 工具",
    })})`,
  );
  const count2 = await waitForPending(session.id, 60000);

  const pending2 = await run<{ toolCallId: string }[]>(
    `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  待审条目：${pending2.length}（预期 1）`);
  if (count2 > 0 && pending2.length > 0) {
    await run(
      `window.colt.invoke("approval.resolve", ${JSON.stringify({
        sessionId: session.id,
        toolCallId: "__PLACEHOLDER__",
        approved: false,
      })})`.replace("__PLACEHOLDER__", pending2[0]!.toolCallId),
    );
    await sleep(20000);

    const after = await run<{
      fileChanges: unknown[];
      messages: { role: string; text: string }[];
      running: boolean;
    } | null>(`window.colt.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`);
    log(`  拒绝后文件改动：${after?.fileChanges.length ?? 0}（预期仍为 ${changesBefore}）`);
    log(`  会话运行中：${after?.running}（预期 false，说明未卡死）`);
    const last = after?.messages.at(-1);
    log(`  末条消息[${last?.role}]：${(last?.text ?? "").slice(0, 80)}`);
  } else {
    log(`  未拦截到写入，工具调用轨迹：${await toolTrail(session.id)}`);
  }
}

/**
 * 宿主能力冒烟：真实验证「审批闸门 → toolRpc → BrowserHost / ComputerHost → 结果投影」全链路。
 *
 * 刻意保持默认的 approval 审批模式，由本流程轮询待审并自动批准，
 * 从而把风险分级、签名、放行/回执这些环节一并覆盖，而不是绕过它们。
 */
async function runHost(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}`);

  window.reload();
  await sleep(4000);

  // 默认用带视觉的模型：截图工具的价值全在「模型能看见画面」，
  // 纯文本模型（如默认的 deepseek-v4-flash）会丢掉工具结果里的图片。
  const model = process.env.COLT_SMOKE_MODEL ?? "deepseek/deepseek-v4-flash-vision-exp";
  log(`模型：${model}`);
  await run(
    `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: session.id, cwd: process.env.COLT_SMOKE_CWD, model })})`,
  );
  const modeInfo = await run<{ mode: string }>(
    `window.colt.invoke("approval.mode.get", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`审批模式：${modeInfo.mode}`);

  /** 批准当前所有待审条目，返回处理条数 */
  const approvePending = async (): Promise<number> => {
    const pending = await run<{ toolCallId: string; toolName: string; risk: string; summary: string }[]>(
      `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
    );
    for (const item of pending) {
      log(`  待审 → 批准：${item.toolName} [${item.risk}] ${item.summary}`);
      await run(
        `window.colt.invoke("approval.resolve", ${JSON.stringify({
          sessionId: session.id,
          toolCallId: item.toolCallId,
          approved: true,
        })})`,
      );
    }
    return pending.length;
  };

  /**
   * 轮询：一边批准待审，一边等本轮跑完。
   *
   * 主判据用 session.view 的 running（= 内核 operation 是否在飞行）：
   * 「先观察到 running=true，再回到 running=false 且无待审」即为收敛。
   * 仅当整轮都没观察到 running（模型秒回、两次轮询之间就结束）时，
   * 才退回「消息数出现增长后连续 10s 不再变化」的兜底判据。
   */
  const drive = async (label: string, timeoutMs: number): Promise<void> => {
    const readState = async (): Promise<{ count: number; running: boolean }> => {
      const view = await run<{ messages: unknown[]; running: boolean } | null>(
        `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`,
      );
      return { count: view?.messages.length ?? 0, running: view?.running ?? false };
    };

    const deadline = Date.now() + timeoutMs;
    const initial = await readState();
    log(`${label}：开始轮询（初始消息数=${initial.count}，running=${initial.running}，上限 ${timeoutMs}ms）`);
    let approved = 0;
    let lastCount = initial.count;
    let sawRunning = initial.running;
    let stableSince = Date.now();
    let lastHeartbeat = Date.now();
    let convergedByRunning = false;

    while (Date.now() < deadline) {
      const pendingCount = await approvePending();
      approved += pendingCount;

      const { count, running } = await readState();
      if (running) sawRunning = true;
      if (count !== lastCount) {
        lastCount = count;
        stableSince = Date.now();
      }

      if (sawRunning && !running && pendingCount === 0) {
        convergedByRunning = true;
        break;
      }
      if (
        !sawRunning &&
        pendingCount === 0 &&
        count > initial.count &&
        Date.now() - stableSince >= 10_000
      ) {
        break;
      }
      if (Date.now() - lastHeartbeat >= 15_000) {
        lastHeartbeat = Date.now();
        log(`  ${label}：消息数=${lastCount}，running=${running}，待审=${pendingCount}，已批准=${approved}`);
      }
      await sleep(1000);
    }
    log(
      `${label}：消息数=${lastCount}，自动批准 ${approved} 条，观察到 running=${sawRunning}` +
        (convergedByRunning ? "（按 running 收敛）" : ""),
    );
  };

  // 聚焦验证：ONLY=image 只跑图片链路，ONLY=browser 只跑浏览器能力（其余任务更慢且无关）。
  const only = process.env.COLT_SMOKE_ONLY;

  if (only !== "image") {
    log("[1] 浏览器任务");
    // 上传夹具用正斜杠：反斜杠在提示词里要转义，模型容易把转义符一起照抄进路径
    const projectRoot = process.env.COLT_SMOKE_CWD ?? process.cwd();
    const uploadFixture = join(projectRoot, "package.json").replaceAll("\\", "/");
    const browserPrompt =
      process.env.COLT_SMOKE_BROWSER_PROMPT ??
      `请依次用浏览器工具完成十件事，每步只做一件：1) browser_act 打开 https://example.com ；2) browser_act 执行 wait（mode 用 idle）等页面就绪；3) browser_read 执行 snapshot；4) browser_read 执行 console 读取控制台；5) browser_read 执行 network 查看网络请求；6) browser_read 执行 downloads 查看下载列表；7) browser_act 执行 viewport 把视口设为 width=375、height=700；8) browser_screenshot 截图，并用一句话描述截图里的标题、正文字样，以及画面是否已变成窄屏（移动端）布局；9) browser_act 执行 viewport 恢复默认尺寸（即不传 width 和 height）；10) browser_act 执行 upload，ref 填第 3 步 snapshot 结果里的第一个 ref、paths 填 [${uploadFixture}]，然后把工具返回的原文照抄出来。`;
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text: browserPrompt })})`,
    );
    await drive("浏览器任务", 180_000);

    // 观测能力断言：这些动作的返回文本有固定前缀，只在它们跑通时才可能出现
    log("[1b] 观测能力断言");
    const view = await run<{ messages: { role: string; text: string }[] } | null>(
      `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`,
    );
    const toolTexts = (view?.messages ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => message.text);
    const joined = toolTexts.join("\n");
    // viewport 内嵌化后不再改窗口尺寸，而是给 WebContentsView 临时覆盖尺寸，
    // 「恢复默认」交还给右栏面板的实测矩形——尺寸随窗口/面板变化，故只断言「形如 WxH」。
    const checks: [string, boolean][] = [
      ["browser_act wait", joined.includes("等待完成") || joined.includes("等待超时")],
      ["browser_read console", joined.includes("控制台：")],
      ["browser_read network", joined.includes("网络：")],
      ["browser_act viewport 设置", /已设置视口：37\d+x700/.test(joined)],
      ["browser_act viewport 恢复", /已恢复默认视口：\d+x\d+/.test(joined)],
      ["browser_read downloads", joined.includes("本会话尚未触发任何下载")],
      // 用非 file 元素走一遍 upload：能拿到这条明确的拒绝，说明 CDP 链路（挂载 → DOM 查询 → 自查）真的通了
      ["browser_act upload 自查", joined.includes("不是 file 类型的 input")],
    ];
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    const samples = toolTexts
      .filter((text) => /^(等待|控制台|网络|下载|已设置视口|已恢复默认视口)/.test(text))
      .map((text) => text.split("\n")[0]);
    log(`  观测样本：${samples.join(" | ") || "无"}`);

    if (only !== "browser") {
      log("[2] 电脑截图任务");
      await run(
        `window.colt.invoke("session.prompt", ${JSON.stringify({
          sessionId: session.id,
          text: "请调用 computer_screenshot 截取当前屏幕，并用一句话说明你看到了什么。",
        })})`,
      );
      await drive("电脑截图任务", 120_000);
    }
  }

  if (only !== "browser") {
    log("[3] 图片输入任务");
    const imageBase64 = makeSolidPng(128);
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({
        sessionId: session.id,
        text: "这张图片是什么颜色？只回答颜色名称。",
        images: [{ data: imageBase64, mimeType: "image/png" }],
      })})`,
    );
    await drive("图片输入任务", 120_000);
  }

  // 浏览器已内嵌为 WebContentsView，不再是独立窗口——窗口数应始终为 1，
  // 这本身就是「没有偷偷弹窗」的旁证。
  const windows = BrowserWindow.getAllWindows();
  log(`窗口数：${windows.length}；标题：${windows.map((item) => item.getTitle()).join(" | ")}`);
  log(`浏览器视图：${JSON.stringify(hostBridge.browserState(session.id))}`);

  // 展开浏览器/电脑工具卡片，让验收截图能看到工具结果里的图片。
  // 两个坑：
  // 1) 表头由 name 与副标题两个 span 拼成 textContent，中间没有分隔符
  //    （即 "browser_acthttps://example.com…"），所以不能用 \b 词边界匹配；
  // 2) 会话标题取自首条用户消息，而该消息正文里恰好含 "browser_act"，
  //    若不锚定开头就会误点侧栏会话行、把会话切走。故锚定 ^ 并排除 aside。
  const expanded = await run<{ matched: number; total: number }>(`(() => {
    const pattern = /^(browser_read|browser_screenshot|browser_act|computer_screenshot|computer_action)/;
    const buttons = [...document.querySelectorAll("button")];
    const hits = buttons.filter((b) => !b.closest("aside") && pattern.test(b.textContent || ""));
    hits.forEach((b) => b.click());
    return { matched: hits.length, total: buttons.length };
  })()`);
  log(`展开工具卡片：${expanded.matched} 张（页面按钮总数 ${expanded.total}）`);
  await sleep(1500);

  // 比肉眼更硬的判据：断言图片元素真的在 DOM 里并完成解码
  // naturalWidth > 0 表示浏览器已成功加载并解码该图，否则说明渲染失败
  const images = await run<{ count: number; sizes: string[] }>(`(() => {
    const imgs = [...document.querySelectorAll('img[alt="工具截图"]')];
    return {
      count: imgs.length,
      sizes: imgs.map((img) => img.naturalWidth + "x" + img.naturalHeight + "(complete=" + img.complete + ")"),
    };
  })()`);
  log(`页面内工具截图 <img>：${images.count} 张，尺寸：${images.sizes.join(", ") || "无"}`);

  // 用户消息里的图片也必须真的渲染出来（只带图、不带文字时同样要显示）
  const userImages = await run<{ count: number; sizes: string[] }>(`(() => {
    const imgs = [...document.querySelectorAll('img[alt="随消息发送的图片"]')];
    return {
      count: imgs.length,
      sizes: imgs.map((img) => img.naturalWidth + "x" + img.naturalHeight + "(complete=" + img.complete + ")"),
    };
  })()`);
  log(`用户消息图片 <img>：${userImages.count} 张，尺寸：${userImages.sizes.join(", ") || "无"}`);

  await report(session.id, log, run);
}
