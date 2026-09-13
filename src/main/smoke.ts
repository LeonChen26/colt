/**
 * 端到端冒烟
 * basic：建项目 → 建会话 → 真实对话 → 截图
 * advanced：多会话并行 → 分支查询 → navigateTree 分叉 → 截图
 * fixture：以本地夹具站为靶子，不开模型跑完浏览器能力（观测 + 上传下载 + 弹窗拦截）
 */
import { app, BrowserWindow, nativeImage } from "electron";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { upsertProject, createSession } from "./db/repo";
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
