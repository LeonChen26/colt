/**
 * 端到端冒烟
 * basic：建项目 → 建会话 → 真实对话 → 截图
 * advanced：多会话并行 → 分支查询 → navigateTree 分叉 → 截图
 * fixture：以本地夹具站为靶子，不开模型跑完浏览器能力（观测 + 上传下载 + 弹窗拦截）
 * dock：工作区（右栏）界面行为——折叠/展开、拖拽调宽与上下限、宽度记忆、⑦-F 自动展开、点文件路径→预览、
 *       页签关闭与「+」新增视图、本次改动树、面板迁入页签（A3-5）、观测抽屉（B2）、
 *       浏览器前进/后退/刷新（B1），以及 ⑥ Live Bar 的运行状态段（C1/C2：已中断 / 已失败 / 空闲）
 */
import { app, BrowserWindow, nativeImage, WebContentsView } from "electron";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { upsertProject, createSession, getProject } from "./db/repo";
import { hostBridge } from "./host";
import { join } from "node:path";
import type { HostResult } from "@shared/worker-protocol";
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
    const projectRoot = process.env.BANYAN_SMOKE_CWD ?? process.cwd();
    const project = upsertProject(projectRoot);
    log(`项目：${project.name} (${project.rootPath})`);

    const sessionsDir = join(app.getPath("userData"), "sessions", project.id);
    const mode = process.env.BANYAN_SMOKE_MODE;

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
    } else if (mode === "dock") {
      await runDock(window, project.id, sessionsDir, log, run);
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

  const prompt = process.env.BANYAN_SMOKE_PROMPT ?? "用一句话介绍你自己。";
  log(`发送：${prompt}`);
  await run(
    `window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text: prompt })})`,
  );

  await sleep(Number(process.env.BANYAN_SMOKE_WAIT ?? 20000));

  // 展开工具卡片，让验收截图能看到实际输出
  // 注意：不能用「改动」字样匹配，会误中顶部导航标签
  await run(`(() => {
    const buttons = [...document.querySelectorAll("button")];
    buttons.filter((b) => /^\\s*(bash|edit|write|read)\\b/.test(b.textContent.trim()))
      .forEach((b) => b.click());
    return true;
  })()`);
  await sleep(800);

  // 可选：打开右侧某个面板（用量 / 工具），便于验收截图覆盖该面板
  const panel = process.env.BANYAN_SMOKE_PANEL;
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
  const payloadName = "banyan-payload.txt";
  const payloadBody = "banyan download fixture\n";
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
 * A3-2 的「点文件路径 → 预览」用**真实的事件通道**（`session.view`）推一个**受控视图**，
 * 让「正在处理」里出现可点的文件行、消息流里出现可点的工具卡路径：不跑模型，但走的是产品里
 * 一模一样的那条链路（事件 → 行/卡 → 点击 → `file.read` → 预览）。
 * 越界路径与「工具卡传绝对路径」也顺带钉一下。
 *
 * A3-3 的「页签关闭 + 「+」新增视图」同样在这里验：关闭**激活**页签后激活位是否交还默认视图、
 * 关闭「文件」后重开是否回到空态、以及**关闭「浏览器」后原生视图是否真的收起 / 重开是否重新可见**
 * （最后这条又是截图看不见的——原生视图的可见性只有主进程知道）。
 *
 * A3-4 的「本次改动树」验三件容易出错的：树的目录分组是否正确、**越界条目是否被排除**
 * （放进去就是死条目）、以及**窄栏时容器查询是否把树真的隐藏了**（隐藏靠 `display:none`，
 * 元素仍在 DOM 里，所以必须问 `getComputedStyle` 而不是 `querySelector`）。
 *
 * A3-5 的「面板迁入页签」验的是**迁移动到位**：② 的四个入口点下去之后，面板真的渲染在 ⑦ 内
 * （按工作区正文判定，而非断言某个 class）、页签数量随之增加、四个新页签都能关且能重开；
 * 最硬的一条是 **`aside` 数不变**——迁入前每开一个面板就会多一个中栏浮层 `aside`，
 * 迁入后多开 4 个面板 `aside` 数仍与开局一致。
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
  const payloadName = "banyan-payload.txt";
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
   * 点「正在处理」里路径为 path 的文件行。
   * 用 title 做**精确匹配**（FollowPanel 的标题是 `点击预览 <path>`），
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

  /** 读「文件」视图状态：被预览的路径、是否渲染文本、正文是否含指定片段、拒绝原因、空态 */
  const fileProbe = (
    needle: string,
  ): Promise<{
    path: string | null;
    hasText: boolean;
    hasNeedle: boolean;
    errorShown: boolean;
    emptyShown: boolean;
  }> =>
    run(`(() => {
      const root = document.querySelector("[data-file-view]");
      const body = document.body.innerText;
      return {
        path: root ? root.getAttribute("data-file-view") : null,
        hasText: document.querySelector("[data-file-text]") !== null,
        hasNeedle: ${JSON.stringify(needle)}.length > 0 && body.includes(${JSON.stringify(needle)}),
        errorShown: body.includes("无法预览该文件"),
        emptyShown: body.includes("还没有打开文件"),
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
   * 读「本次改动」树：目录路径、文件路径。
   * **按可见性判定**而不是存在性——窄栏时树是被容器查询 `display:none` 掉的，
   * 元素还在 DOM 里，`querySelector` 照样能找到，所以必须问 `getComputedStyle`。
   */
  const treeProbe = (): Promise<{ present: boolean; dirs: string[]; files: string[] }> =>
    run(`(() => {
      const tree = document.querySelector("[data-file-tree]");
      if (tree === null || getComputedStyle(tree).display === "none") {
        return { present: false, dirs: [], files: [] };
      }
      return {
        present: true,
        dirs: [...tree.querySelectorAll("[data-tree-dir]")].map((b) =>
          b.getAttribute("data-tree-dir")),
        files: [...tree.querySelectorAll("[data-tree-file]")].map((b) =>
          b.getAttribute("data-tree-file")),
      };
    })()`);

  /** 点树里 path 对应的文件节点 */
  const clickTreeFile = (path: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-tree-file="${path}"]`)});
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
   * 「用量 / 工具 / 规则 / 改动」这些字样在 ⑦ 的页签上也有一份，全文档查会点错。
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

  try {
    window.reload();
    await sleep(4000);

    // 用渲染层同款查询取「当前会话」：App 也是取 session.list 的第一条（updated_at DESC），
    // 由此保证浏览器视图挂在渲染层真正显示的那个会话上，而不是自说自话的新 id。
    const list = await run<{ id: string }[]>(
      `window.banyan.invoke("session.list", ${JSON.stringify({ projectId })})`,
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

    // ---- A3-2：点文件路径 → 预览 ----
    // 走**真实的事件通道**推一个受控视图（不跑模型），让「正在处理」里出现可点的文件行；
    // 其中一条故意是越界路径，用来在 UI 上钉住「根由主进程推导」这条安全边界。
    log("[A3-2] 推受控会话视图：让「正在处理」出现文件行（含一条越界路径）");
    const rootPath = getProject(projectId)?.rootPath ?? process.cwd();
    const previewRel = "package.json";
    // 子目录里的真实文件：用来验「树按目录分组」，也是「点树里的文件 → 预览」的靶子
    const treeRel = "src/main/file-read.ts";
    const previewBody = readFileSync(join(rootPath, previewRel), "utf8");
    // 取该文件里第一行够长的内容片段作为「内容确实渲染了」的判据（不写死具体字样）
    const previewMarker = (
      previewBody.split("\n").find((line) => line.trim().length >= 8) ?? ""
    ).trim();
    // 工具卡（消息流 ④）里的路径用**绝对路径**驱动：read 的 path 常是绝对路径，
    // 顺带钉住「主进程收绝对路径、但仍须落在项目根内」这条边界
    const toolAbsPath = join(rootPath, "tsconfig.json");
    const toolMarker = (
      readFileSync(toolAbsPath, "utf8").split("\n").find((line) => line.trim().length >= 8) ?? ""
    ).trim();
    const stamp = Date.now();
    const fakeChange = (id: string, path: string, at: number): Record<string, unknown> => ({
      id,
      path,
      kind: "write",
      patch: null,
      addedLines: 0,
      removedLines: 0,
      timestamp: at,
    });
    /**
     * 受控会话视图的构造器：基准是一份「什么都没在跑」的视图，
     * 各用例只覆盖自己关心的字段（如 `lastRun` / `running`）。
     */
    const smokeView = (over: Record<string, unknown>): Record<string, unknown> => ({
      sessionId,
      lane: "main",
      cwd: rootPath,
      model: "smoke/model",
      imageInput: false,
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
      ...over,
    });
    window.webContents.send("session.view", smokeView({}));
    await sleep(400);

    // 文件行只在「正在处理」里，先切过去
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);

    checks.push(["点文件行命中（受控视图里有该行）", await clickFileRow(previewRel)]);
    await sleep(700);
    const fileOpened = await fileProbe(previewMarker);
    const afterOpen = await probe();
    checks.push(["点路径后激活「文件」页签", afterOpen.activeLabel === "文件"]);
    checks.push(["打开文件新增一个页签（共 3 个）", afterOpen.tabCount === 3]);
    checks.push(["文件视图渲染了文本内容", fileOpened.hasText && fileOpened.hasNeedle]);
    checks.push(["文件视图记录了被预览的路径", fileOpened.path === previewRel]);
    log(
      `  预览：path=${fileOpened.path}，渲染文本=${fileOpened.hasText}，命中片段=${fileOpened.hasNeedle}`,
    );

    // 切走再切回：内容不丢（FilePanel 重挂载后按上层持有的目标重读）
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    checks.push(["切走后文件视图不再渲染内容", (await fileProbe(previewMarker)).hasText === false]);
    await clickInDock(`b.textContent.trim() === "文件"`);
    await sleep(700);
    checks.push(["切回文件页签内容仍在", (await fileProbe(previewMarker)).hasNeedle]);
    checks.push(["切页签不改变页签数量（仍 3 个）", (await probe()).tabCount === 3]);

    // 越界路径：主进程拒绝 → 视图给出可读原因
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    checks.push(["越界文件行可点", await clickFileRow("../escape.txt")]);
    await sleep(700);
    const denied = await fileProbe("");
    checks.push(["越界路径被拒并给出原因", denied.errorShown && denied.path === "../escape.txt"]);

    // ---- A3-2 续：工具卡（消息流 ④）里的文件路径同样可点 ----
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    checks.push(["切回「正在处理」后文件视图已卸载", (await fileProbe("")).hasText === false]);
    checks.push(["工具卡路径可点（入参是绝对路径）", await clickPreviewByTitle(toolAbsPath)]);
    await sleep(700);
    const fromTool = await fileProbe(toolMarker);
    checks.push(["点工具卡路径 → 激活「文件」页签", (await probe()).activeLabel === "文件"]);
    checks.push(["工具卡路径原样送出（绝对路径）", fromTool.path === toolAbsPath]);
    checks.push(["根内绝对路径同样渲染出内容", fromTool.hasText && fromTool.hasNeedle]);
    log(`  工具卡预览：path=${fromTool.path}，渲染文本=${fromTool.hasText}，命中片段=${fromTool.hasNeedle}`);

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
    // 此刻 3 个页签（正在处理 / 浏览器 / 文件），激活在「文件」
    log("[A3-3] 页签关闭与「+」新增视图");
    const dock0 = await probe();
    checks.push(["展开态有「+」新增视图入口", dock0.addButton]);
    checks.push([
      "关闭按钮只出现在可关闭页签上（默认视图没有，⑦-E）",
      dock0.tabClose.length === 2 &&
        dock0.tabClose.includes("关闭浏览器") &&
        dock0.tabClose.includes("关闭文件"),
    ]);

    // 「+」菜单：只列产品里真有的视图；点菜单外即收
    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    const menu = await probe();
    checks.push([
      "「+」菜单列出全部可重开的视图（A3-5 后含四个面板，共 6 个）",
      menu.menuItems.length === 6 &&
        ["browser", "file", "changes", "usage", "tools", "rules"].every((kind) =>
          menu.menuItems.includes(kind),
        ),
    ]);
    await run(`(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    checks.push(["点菜单外即收起「+」菜单", (await probe()).menuItems.length === 0]);

    // 关闭**当前激活**的页签：数量减 1，激活位交还默认视图
    await clickInDock(`b.getAttribute("aria-label") === "关闭文件"`);
    await sleep(400);
    const afterCloseFile = await probe();
    checks.push([
      "关闭激活的「文件」→ 页签减 1 且激活位交还「正在处理」",
      afterCloseFile.tabCount === 2 && afterCloseFile.activeLabel === "正在处理",
    ]);
    checks.push(["关闭后文件视图已卸载", (await fileProbe("")).hasText === false]);

    // 「+」重新打开「文件」：关闭即丢弃该视图状态，故回到**空态**
    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    await clickMenuItem("file");
    await sleep(400);
    const reopenedFile = await probe();
    const emptiedFile = await fileProbe("");
    checks.push([
      "「+」重新打开「文件」→ 页签回到 3 且为空态（旧目标随关闭丢弃）",
      reopenedFile.tabCount === 3 &&
        reopenedFile.activeLabel === "文件" &&
        emptiedFile.emptyShown,
    ]);

    // 关掉「浏览器」：原生视图必须收起；再用「+」开回来必须重新可见（「关了能回来」）
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(500);
    checks.push(["激活「浏览器」后原生视图可见", await waitVisible(true)]);
    await clickInDock(`b.getAttribute("aria-label") === "关闭浏览器"`);
    await sleep(400);
    checks.push(["关闭「浏览器」后页签减 1", (await probe()).tabCount === 2]);
    checks.push(["关闭「浏览器」后原生视图已收起（getVisible=false）", await waitVisible(false)]);

    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    await clickMenuItem("browser");
    await sleep(500);
    checks.push([
      "「+」重新打开「浏览器」→ 页签回到 3 且原生视图重新可见",
      (await probe()).tabCount === 3 && (await waitVisible(true)),
    ]);

    // ---- A3-4：文件视图的「本次改动」树（范围 A） ----
    // 此刻「文件」是刚被「+」打开、还没选过文件的状态——正是树要当出口的那个场景
    log("[A3-4] 文件视图的「本次改动」树");
    await clickInDock(`b.textContent.trim() === "文件"`);
    await sleep(400);
    const tree = await treeProbe();
    checks.push([
      "「+」打开「文件」未选文件时：空态与树并存（树就是空态的出口）",
      tree.present && (await fileProbe("")).emptyShown,
    ]);
    checks.push([
      "树按目录分组（src / src/main 目录 + 叶子文件）",
      tree.dirs.includes("src") &&
        tree.dirs.includes("src/main") &&
        tree.files.includes(previewRel) &&
        tree.files.includes(treeRel),
    ]);
    checks.push([
      "树排除了不可预览的越界条目（⑦-4：放进去就是死条目）",
      ![...tree.dirs, ...tree.files].some((path) => path.includes("escape")),
    ]);

    checks.push(["点树里的文件", await clickTreeFile(treeRel)]);
    await sleep(700);
    const fromTree = await fileProbe("");
    checks.push([
      "点树里的文件 → 预览切换到该文件",
      fromTree.path === treeRel && fromTree.hasText,
    ]);
    log(`  树预览：path=${fromTree.path}，渲染文本=${fromTree.hasText}`);

    // 窄栏自动让位（容器查询兜底）：拖到最窄时整棵树隐藏，预览照旧
    await dragGrip(10000);
    await sleep(300);
    const narrowDock = await probe();
    checks.push([
      "右栏拖到最窄（220）时整棵树隐藏、预览照旧",
      narrowDock.width === 220 &&
        (await treeProbe()).present === false &&
        (await fileProbe("")).hasText,
    ]);
    await dragGrip(-10000);
    await sleep(300);
    checks.push([
      "右栏拉宽后树回来",
      (await probe()).width > 520 && (await treeProbe()).present,
    ]);

    // ---- A3-5：中栏的四个观测 / 管理面板迁入 ⑦ 页签 ----
    // 迁入前它们在**中栏**另起一个 aside（同一件事两处实现、两套入口）；迁入后
    // 只有「页签」这一个载体，② 的入口与「+」菜单都只是打开同一个页签的快捷方式。
    log("[A3-5] 面板迁入页签（改动 / 用量 / 工具 / 规则）");
    const beforeA35 = await probe();
    checks.push(["（前置）此刻共 3 个页签（正在处理 / 浏览器 / 文件）", beforeA35.tabCount === 3]);

    checks.push(["② 会话头有「用量」入口且点击命中", await clickInHead(`b.textContent.trim() === "用量"`)]);
    await sleep(500);
    const usageDock = await probe();
    checks.push([
      "点「用量」→ 新增页签并激活，且面板渲染在 ⑦ 内",
      usageDock.tabCount === 4 && usageDock.activeLabel === "用量" && (await dockHas("用量历史")),
    ]);

    checks.push(["② 会话头有「工具」入口且点击命中", await clickInHead(`b.textContent.trim() === "工具"`)]);
    await sleep(500);
    checks.push([
      "点「工具」→ 激活「工具」页签且渲染工具调用面板",
      (await probe()).activeLabel === "工具" && (await dockHas("工具调用")),
    ]);

    checks.push(["② 会话头有「规则」入口且点击命中", await clickInHead(`b.textContent.trim() === "规则"`)]);
    await sleep(500);
    checks.push([
      "点「规则」→ 激活「规则」页签且渲染审批规则面板",
      (await probe()).activeLabel === "规则" && (await dockHas("审批规则")),
    ]);

    checks.push(["② 会话头有「改动」入口且点击命中", await clickInHead(`b.textContent.trim().startsWith("改动")`)]);
    await sleep(500);
    const changesDock = await probe();
    checks.push([
      "点「改动」→ 激活「改动」页签且渲染文件改动面板",
      changesDock.activeLabel === "改动" && (await dockHas("文件改动")),
    ]);
    checks.push([
      "四个迁入的页签都可关闭（关闭由页签负责，面板内不再有「收起」）",
      ["关闭改动", "关闭用量", "关闭工具", "关闭规则"].every((label) =>
        changesDock.tabClose.includes(label),
      ),
    ]);
    // 关键判据：多开面板**不再新增 aside**（中栏浮层已消失）
    checks.push([
      "中栏不再有浮层面板（多开 4 个面板后 aside 数不变）",
      changesDock.asideCount === beforeA35.asideCount,
    ]);
    log(`  迁入后：页签 ${changesDock.tabCount} 个，aside ${changesDock.asideCount} 个`);

    // 关闭「改动」：页签减 1、激活位交还默认视图、面板内容随之卸载
    await clickInDock(`b.getAttribute("aria-label") === "关闭改动"`);
    await sleep(400);
    const closedA35 = await probe();
    checks.push([
      "关闭「改动」→ 页签减 1 且激活位交还「正在处理」",
      closedA35.tabCount === 6 && closedA35.activeLabel === "正在处理",
    ]);
    checks.push(["关闭后改动面板已卸载", (await dockHas("文件改动")) === false]);

    // 「+」重开「改动」：四个新页签都满足「关了能回来」（⑦-E 的出口保证）
    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    await clickMenuItem("changes");
    await sleep(500);
    const reopenedA35 = await probe();
    checks.push([
      "「+」重开「改动」→ 页签回到 7 且面板重新渲染",
      reopenedA35.tabCount === 7 &&
        reopenedA35.activeLabel === "改动" &&
        (await dockHas("文件改动")),
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
    checks.push([
      "覆盖确实比停靠区大（即用户看到的「超出、被窗口裁掉」）",
      overArea !== null &&
        overView !== undefined &&
        overView.width > overArea.width &&
        overView.height > overArea.height,
    ]);
    // 覆盖必须**真的落到页面上**：判据取页面自己的 innerWidth，而不是我们设的视图宽度。
    // 页面按 1280 重排，正是「页面比停靠区宽、右侧被窗口边缘切掉」的来源——用户那张截图就是它。
    checks.push([
      "覆盖尺寸真的落到页面（页面 innerWidth = 1280，而非停靠区宽度）",
      (await pageInnerWidth()) === 1280,
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
      "「恢复」后页面重新按停靠区宽度重排（页面 innerWidth 回到区域宽度）",
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
    window.banyan.invoke("session.open", ${JSON.stringify({ sessionId: first.id, cwd: process.env.BANYAN_SMOKE_CWD })}),
    window.banyan.invoke("session.open", ${JSON.stringify({ sessionId: second.id, cwd: process.env.BANYAN_SMOKE_CWD })})
  ])`);
  log(`两个 worker 就绪，耗时 ${Date.now() - started}ms`);

  await run(`Promise.all([
    window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "说出数字 1，只回一个字" })}),
    window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: second.id, text: "说出数字 2，只回一个字" })})
  ])`);
  await sleep(25000);

  const viewA = await run<{ messages: { role: string; text: string }[] } | null>(
    `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
  );
  const viewB = await run<{ messages: { role: string; text: string }[] } | null>(
    `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: second.id })})`,
  );
  log(`会话 A 消息数：${viewA?.messages.length}，末条：${viewA?.messages.at(-1)?.text.slice(0, 40)}`);
  log(`会话 B 消息数：${viewB?.messages.length}，末条：${viewB?.messages.at(-1)?.text.slice(0, 40)}`);

  // 分支：在会话 A 再问一轮，然后跳回第一个用户节点形成分叉
  await run(
    `window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "再说出数字 3，只回一个字" })})`,
  );
  await sleep(20000);

  type Node = { id: string; kind: string; summary: string; isTip: boolean; onActivePath: boolean };
  const before = await run<Node[]>(
    `window.banyan.invoke("session.branches", ${JSON.stringify({ sessionId: first.id })})`,
  );
  log(`分支节点数（分叉前）：${before.length}`);
  for (const node of before) {
    log(`  ${node.isTip ? "→" : " "} [${node.kind}] ${node.summary.slice(0, 40)}`);
  }

  const target = before.find((node) => node.kind === "user");
  if (target) {
    log(`跳转到首个用户节点：${target.id}`);
    await run(
      `window.banyan.invoke("session.navigate", ${JSON.stringify({ sessionId: first.id, targetId: target.id })})`,
    );
    await sleep(4000);

    const mid = await run<{ running: boolean; messages: { role: string; text: string }[] } | null>(
      `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
    );
    log(`跳转后：running=${mid?.running}，消息数=${mid?.messages.length}`);

    // 跳转后再提问，应当形成新分支而不是覆盖原有记录
    await run(
      `window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "改说字母 X，只回一个字" })})`,
    );
    await sleep(25000);

    const post = await run<{ running: boolean; messages: { role: string; text: string }[] } | null>(
      `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
    );
    log(`新分支提问后：running=${post?.running}，消息数=${post?.messages.length}`);
    for (const message of post?.messages ?? []) {
      log(`    [${message.role}] ${message.text.slice(0, 40)}`);
    }

    const after = await run<Node[]>(
      `window.banyan.invoke("session.branches", ${JSON.stringify({ sessionId: first.id })})`,
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
  } | null>(`window.banyan.invoke("session.view", ${JSON.stringify({ sessionId })})`);

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
      const attempt = window.banyan
        .invoke("session.open", ${JSON.stringify({ sessionId: session.id, cwd: process.env.BANYAN_SMOKE_CWD })})
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
    `window.banyan.invoke("session.open", ${JSON.stringify({ sessionId: busy.id, cwd: process.env.BANYAN_SMOKE_CWD })})`,
  );
  log("让长任务会话开工…");
  await run(
    `window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: busy.id, text: "分析当前项目：先 ls 列出顶层目录，再读取 package.json，用一句话总结这是什么项目。" })})`,
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
    `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: busy.id })})`,
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
        `window.banyan.invoke("approval.list", ${JSON.stringify({ sessionId })})`,
      );
      if (list.length > 0) return list.length;
      if (Date.now() > deadline) return 0;
      await sleep(1000);
    }
  };

  /** 列出当前会话调用过的工具名，用于区分「模型没调工具」与「调用未被拦」 */
  const toolTrail = async (sessionId: string): Promise<string> => {
    const view = await run<{ messages: { role: string; toolCalls?: { name: string }[] }[] } | null>(
      `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId })})`,
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
    `window.banyan.invoke("session.open", ${JSON.stringify({ sessionId: session.id, cwd: process.env.BANYAN_SMOKE_CWD })})`,
  );

  // ---- 场景一：只读命令应当自动放行 ----
  log("[场景1] 只读命令 ls，预期自动放行");
  await run(
    `window.banyan.invoke("session.prompt", ${JSON.stringify({
      sessionId: session.id,
      text: "用 bash 运行 ls -la，只要列目录，不要做别的",
    })})`,
  );
  await sleep(25000);
  const pendingAfterRead = await run<unknown[]>(
    `window.banyan.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  待审条目：${pendingAfterRead.length}（预期 0）`);

  // ---- 场景二：写入应当被拦下 ----
  log("[场景2] 写入 demo.md，预期出现待审");
  await run(
    `window.banyan.invoke("session.prompt", ${JSON.stringify({
      sessionId: session.id,
      text: "把 demo.md 末尾追加一行「审批测试」，用 edit 工具",
    })})`,
  );
  const count = await waitForPending(session.id, 60000);

  const pending = await run<{ toolCallId: string; toolName: string; summary: string; risk: string; reason: string }[]>(
    `window.banyan.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
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
  const pendingShot = (process.env.BANYAN_SMOKE ?? "").replace(/\.png$/, "-pending.png");
  if (pendingShot) {
    const image = await window.capturePage();
    await writeFile(pendingShot, image.toPNG());
    log(`  待审截图：${pendingShot}`);
  }

  log("[场景3] 批准该调用，预期文件真的被改");
  await run(
    `window.banyan.invoke("approval.resolve", ${JSON.stringify({
      sessionId: session.id,
      toolCallId: pending[0]!.toolCallId,
      approved: true,
    })})`,
  );
  await sleep(20000);

  const view = await run<{ fileChanges: { kind: string; path: string; addedLines: number }[] } | null>(
    `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  文件改动：${view?.fileChanges.length ?? 0} 项（预期 >=1）`);
  for (const change of view?.fileChanges ?? []) {
    log(`  - ${change.kind} ${change.path} +${change.addedLines}`);
  }

  const left = await run<unknown[]>(
    `window.banyan.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  处置后待审：${left.length}（预期 0）`);

  // ---- 场景四：拒绝后模型应知悉并继续对话，不能卡死 ----
  log("[场景4] 再次写入并拒绝，预期文件不变、对话继续");
  const changesBefore = view?.fileChanges.length ?? 0;
  await run(
    `window.banyan.invoke("session.prompt", ${JSON.stringify({
      sessionId: session.id,
      text: "再把 demo.md 末尾追加一行「第二次追加」，用 edit 工具",
    })})`,
  );
  const count2 = await waitForPending(session.id, 60000);

  const pending2 = await run<{ toolCallId: string }[]>(
    `window.banyan.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  待审条目：${pending2.length}（预期 1）`);
  if (count2 > 0 && pending2.length > 0) {
    await run(
      `window.banyan.invoke("approval.resolve", ${JSON.stringify({
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
    } | null>(`window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`);
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
  const model = process.env.BANYAN_SMOKE_MODEL ?? "deepseek/deepseek-v4-flash-vision-exp";
  log(`模型：${model}`);
  await run(
    `window.banyan.invoke("session.open", ${JSON.stringify({ sessionId: session.id, cwd: process.env.BANYAN_SMOKE_CWD, model })})`,
  );
  const modeInfo = await run<{ mode: string }>(
    `window.banyan.invoke("approval.mode.get", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`审批模式：${modeInfo.mode}`);

  /** 批准当前所有待审条目，返回处理条数 */
  const approvePending = async (): Promise<number> => {
    const pending = await run<{ toolCallId: string; toolName: string; risk: string; summary: string }[]>(
      `window.banyan.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
    );
    for (const item of pending) {
      log(`  待审 → 批准：${item.toolName} [${item.risk}] ${item.summary}`);
      await run(
        `window.banyan.invoke("approval.resolve", ${JSON.stringify({
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
        `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`,
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
  const only = process.env.BANYAN_SMOKE_ONLY;

  if (only !== "image") {
    log("[1] 浏览器任务");
    // 上传夹具用正斜杠：反斜杠在提示词里要转义，模型容易把转义符一起照抄进路径
    const projectRoot = process.env.BANYAN_SMOKE_CWD ?? process.cwd();
    const uploadFixture = join(projectRoot, "package.json").replaceAll("\\", "/");
    const browserPrompt =
      process.env.BANYAN_SMOKE_BROWSER_PROMPT ??
      `请依次用浏览器工具完成十件事，每步只做一件：1) browser_act 打开 https://example.com ；2) browser_act 执行 wait（mode 用 idle）等页面就绪；3) browser_read 执行 snapshot；4) browser_read 执行 console 读取控制台；5) browser_read 执行 network 查看网络请求；6) browser_read 执行 downloads 查看下载列表；7) browser_act 执行 viewport 把视口设为 width=375、height=700；8) browser_screenshot 截图，并用一句话描述截图里的标题、正文字样，以及画面是否已变成窄屏（移动端）布局；9) browser_act 执行 viewport 恢复默认尺寸（即不传 width 和 height）；10) browser_act 执行 upload，ref 填第 3 步 snapshot 结果里的第一个 ref、paths 填 [${uploadFixture}]，然后把工具返回的原文照抄出来。`;
    await run(
      `window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text: browserPrompt })})`,
    );
    await drive("浏览器任务", 180_000);

    // 观测能力断言：这些动作的返回文本有固定前缀，只在它们跑通时才可能出现
    log("[1b] 观测能力断言");
    const view = await run<{ messages: { role: string; text: string }[] } | null>(
      `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`,
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
        `window.banyan.invoke("session.prompt", ${JSON.stringify({
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
      `window.banyan.invoke("session.prompt", ${JSON.stringify({
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
