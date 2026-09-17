/**
 * 冒烟模式：host
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import { hostBridge } from "../../../main/host";
import { join } from "node:path";
import { sleep, makeSolidPng, report } from "../context";

/**
 * 宿主能力冒烟：真实验证「审批闸门 → toolRpc → BrowserHost / ComputerHost → 结果投影」全链路。
 *
 * 刻意保持默认的 approval 审批模式，由本流程轮询待审并自动批准，
 * 从而把风险分级、签名、放行/回执这些环节一并覆盖，而不是绕过它们。
 */
export async function runHost(
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
