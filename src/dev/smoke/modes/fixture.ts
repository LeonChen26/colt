// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：fixture
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { app, BrowserWindow } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { hostBridge } from "../../../main/host";
import { sessionManager } from "../../../main/session-manager";
import { runActionChain } from "../../../worker/lib/browser-tool";
import { join } from "node:path";
import type { HostResult } from "@shared/worker-protocol";
import { createFixtureServer } from "../../../../scripts/fixture-server.mjs";
import { sleep, uncaughtErrors } from "../context";

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
export async function runFixture(projectRoot: string, log: (message: string) => void): Promise<void> {
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

    // 可见性过滤：隐藏的不进清单、视口下方阈值内（400px）保留、阈值外（1200px）剔除。
    // 断言挂在文案上而不是 ref 上——文案是夹具页钉死的，ref 序号随页面加元素会变。
    checks.push([
      "snapshot 剔除隐藏元素",
      !snapshot.text.includes("隐藏不应出现的按钮") && !snapshot.text.includes("隐藏不应出现的链接"),
    ]);
    checks.push(["snapshot 保留视口下方阈值内元素", snapshot.text.includes("视口下方四百像素")]);
    checks.push(["snapshot 剔除视口外过远元素", !snapshot.text.includes("视口下方一千二百像素")]);

    // 新元素标记：首次 snapshot 的元素全部带 `*[`（本页第一次进清单），立即二次应全部褪去
    const snapAgain = await call("snapshot");
    checks.push(["snapshot 首次清单带 *[ 新元素标记", snapshot.text.includes("*[")]);
    checks.push(["snapshot 二次清单无 *[（无新增）", !snapAgain.text.includes("*[")]);

    // 截图叠框：回报叠框数量且图片真实返回（框的可见性判据与 snapshot 同源）。
    // fixture 无渲染层上报矩形，视图停留在出生时的隐藏态——产品侧 screenshot 会在
    // 「未摆过且未收起」的间隙先按兜底矩形摆放一次（同真实场景「navigate 后立刻截」
    // 的竞态兜底），这里的断言顺带把那条兜底路径也验掉。
    const shot = await call("screenshot");
    const overlayN = Number(/叠 (\d+) 个元素框/.exec(shot.text)?.[1] ?? 0);
    checks.push(["screenshot 叠元素框并回报数量（>=6）", overlayN >= 6 && shot.image !== undefined]);

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

    // ---- 真实输入：点击 / 输入 / 按键走 Chromium 的输入管线（不是注入合成事件）----
    // 判据一律取**页面自己的记录**，不看工具返回值：「已点击 / 已输入」只能说明事件发出去了，
    // 页面收到了什么才算事实（§五⑫：探针量的那个量必须真的会变）。
    const refIn = (text: string, label: string, role: string): string | undefined =>
      new RegExp(`\\[(e\\d+)\\] ${role} "${label}"`).exec(text)?.[1];
    const snapshotIn = await call("snapshot");
    const mdRef = refIn(snapshotIn.text, "按下探针", "button");
    const kbRef = refIn(snapshotIn.text, "键盘靶输入框", "input");
    const coveredRef = refIn(snapshotIn.text, "被遮挡的靶", "button");
    log(`真实输入靶：md=${mdRef} kb=${kbRef} covered=${coveredRef}`);
    checks.push([
      "snapshot 找到真实输入靶元素",
      mdRef !== undefined && kbRef !== undefined && coveredRef !== undefined,
    ]);

    // 状态位：勾没勾 / 灰没灰 / 当前值——不看这些，模型只能靠截图猜（这一版的主要补强）
    checks.push(["snapshot 报出 checked 状态", /\[e\d+\] input "已勾选靶" \(checked\)/.test(snapshotIn.text)]);
    checks.push(["snapshot 报出 disabled 状态", /\[e\d+\] button "禁用按钮靶" \(disabled\)/.test(snapshotIn.text)]);
    checks.push([
      "snapshot 报出输入框当前值",
      /\[e\d+\] input "键盘靶输入框" = "初始值"/.test(snapshotIn.text),
    ]);

    if (mdRef !== undefined && kbRef !== undefined && coveredRef !== undefined) {
      // 点击：真鼠标序列——pointerdown / mousedown **和** click 都到（合成 el.click() 只有 click）
      const clicked = await call("click", { ref: mdRef });
      await sleep(250);
      const mdLog = (await call("text")).text;
      log(`click（真实输入）：${clicked.text}｜页面记录：${/point[^\n]*/.exec(mdLog)?.[0] ?? "无"}`);
      checks.push(["click 回话报出命中的元素", clicked.text.includes("命中")]);
      checks.push([
        "真点击派发了 pointerdown/mousedown（合成 click 做不到）",
        /pointerdown\/mousedown=[1-9]/.test(mdLog),
      ]);
      checks.push(["真点击同时派发了 click", /click=[1-9]/.test(mdLog)]);

      // 归属提示：操作后页面上出现「Agent 点击」角标，1 秒后自行消失。
      // 它回答的是「这一步是谁做的」——页面向不向应取决于页面自己，光看“闪了一下”分不出归属。
      checks.push([
        "操作后有「Agent 点击」角标（归属提示）",
        (await call("text")).text.includes("Agent 点击"),
      ]);
      await sleep(1200);
      checks.push([
        "角标自行消失（不堆在页面上）",
        !(await call("text")).text.includes("Agent 点击"),
      ]);

      // 被遮挡：如实拒绝，且页面一个事件都没收到——比「报了成功却没反应」诚实
      let blocked = "";
      try {
        await call("click", { ref: coveredRef });
      } catch (error) {
        blocked = error instanceof Error ? error.message : String(error);
      }
      log(`click（被遮挡）：${blocked}`);
      checks.push([
        "被遮挡的点击被拒绝且点名遮挡者",
        blocked.includes("遮挡") && blocked.includes("遮罩靶"),
      ]);
      checks.push(["被拒绝时没有真的点下去（页面零事件）", (await call("text")).text.includes("尚未点击")]);

      // 输入：
      // ① 替换语义（不是追加）；② insertText **不派发 keydown**——后者是如实记录的能力边界
      // （依赖按键联想的控件不会触发），不是缺陷，所以也要有断言钉住。
      const typed = await call("type", { ref: kbRef, text: "替换后" });
      await sleep(250);
      const afterType = (await call("snapshot")).text;
      log(`type：${typed.text}`);
      checks.push([
        "type 是替换而非追加（先全选再插入）",
        /\[e\d+\] input "键盘靶输入框" = "替换后"/.test(afterType),
      ]);
      checks.push(["type 回话如实报出替换掉的字符数", typed.text.includes("替换原有")]);
      checks.push([
        "insertText 不派发 keydown（如实的能力边界）",
        (await call("text")).text.includes("尚未按键"),
      ]);

      // 按键：发给当前聚焦元素（上一步的 type 刚把它聚焦了）
      const pressed = await call("key", { key: "Enter" });
      await sleep(250);
      const kbLog = (await call("text")).text;
      log(`key：${pressed.text}｜页面记录：${/keydown=[^\n]*/.exec(kbLog)?.[0] ?? "无"}`);
      checks.push(["key 派发了 keydown 且键名正确", kbLog.includes("keydown=Enter")]);
      checks.push(["key 回话写清组合", pressed.text.includes("Enter")]);

      // 未知键名：拒绝并列出可用键（不能默默按成另一个键）
      let badKey = "";
      try {
        await call("key", { key: "F5" });
      } catch (error) {
        badKey = error instanceof Error ? error.message : String(error);
      }
      log(`key（未知键名）：${badKey}`);
      checks.push(["未知键名被拒绝且给出可用键", badKey.includes("未知") && /enter/i.test(badKey)]);

      const actedState = hostBridge.browserState(sessionId);
      checks.push([
        "改动类动作后状态标记为「agent 正在操作」",
        actedState !== null && actedState.agentActing,
      ]);

      // 接管态：**两端都显式**（与已撤掉的「面板不可见就拦」不同：依据是用户点过）
      const taken = hostBridge.browserSetControl(sessionId, true);
      checks.push(["接管会给 agent 一条提示（说清为什么被拒）", taken.notice.includes("接管")]);
      checks.push(["接管态随状态一并报给界面", taken.state.controlledByUser]);

      // 审批层前置否决：这条验的是 **session-manager 把 BrowserHost.controlBlock 接进了
      // ApprovalStore.setPrecheck**——若没接，下面这发 click 会变成一张「是否允许点击」的待审卡，
      // 让用户为一个注定失败的动作做决定。直接问审批存储，不惊动 worker/渲染层，无副作用；
      // 断言「是 decision 且被拒」而不是「有 request」，才钉得住「在弹卡之前」。
      const preRejected = sessionManager.approvals.evaluate({
        sessionId,
        toolCallId: "smoke-taken",
        toolName: "browser_act",
        argsJson: JSON.stringify({ action: "click", ref: mdRef }),
        now: Date.now(),
      });
      checks.push([
        "接管期间改动类动作在**审批前**就被拒（不是先弹卡再拒）",
        "decision" in preRejected && preRejected.decision.approved === false,
      ]);
      checks.push([
        "被前置否决的接管动作没有留下待审卡",
        sessionManager.approvals.listPending(sessionId).length === 0,
      ]);

      let blockedWrite = "";
      try {
        await call("click", { ref: mdRef });
      } catch (error) {
        blockedWrite = error instanceof Error ? error.message : String(error);
      }
      log(`click（接管中）：${blockedWrite}`);
      checks.push([
        "接管期间拒绝改动类动作，并指出怎么恢复",
        blockedWrite.includes("接管") && blockedWrite.includes("交还"),
      ]);
      checks.push([
        "接管期间只读动作照常（看还是可以看）",
        (await call("snapshot")).text.includes("夹具页"),
      ]);
      const released = hostBridge.browserSetControl(sessionId, false);
      checks.push(["交还给 agent 一条提示（提醒页面可能被改过）", released.notice.includes("交还")]);
      const afterRelease = await call("click", { ref: mdRef });
      log(`click（交还后）：${afterRelease.text}`);
      checks.push(["交还后照常可操作", afterRelease.text.includes("命中")]);
    }

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

    // ---- 动作链：一次链填完三字段表单并提交；提交即跳转的两种形态（链尾 / 链中） ----
    // 链循环是 worker 侧 browser-tool 的真实实现（runActionChain），这里用一个转发到
    // hostBridge.handle 的桥驱动它——「逐动作 RPC + 指纹比对 + 中止文案」走的都是本体。
    // 放在弹窗段**之后**：本段会导航去 form.html，而前面的段用的还是主页 snapshot 的 ref。
    const chainBridge = {
      call: (capability: "browser", action: string, params: Record<string, unknown>) =>
        hostBridge.handle({ sessionId, capability, action, params }),
    };
    const formInputRef = (snap: string, label: string): string | undefined =>
      new RegExp(`\\[(e\\d+)\\] input "${label}"`).exec(snap)?.[1];
    const formSubmitRef = (snap: string): string | undefined =>
      new RegExp(`\\[(e\\d+)\\] button "提交表单"`).exec(snap)?.[1];

    await call("navigate", { url: `${server.url}form.html` });
    const snap1 = (await call("snapshot")).text;
    const name1 = formInputRef(snap1, "姓名字段");
    const email1 = formInputRef(snap1, "邮箱字段");
    const submit1 = formSubmitRef(snap1);
    if (name1 !== undefined && email1 !== undefined && submit1 !== undefined) {
      const chained = await runActionChain(chainBridge, [
        { action: "type", ref: name1, text: "张三" },
        { action: "type", ref: email1, text: "zhang@example.com" },
        { action: "click", ref: submit1 },
      ]);
      log(`链（提交收尾）：${chained.text.split("\n").slice(0, 4).join(" | ")}`);
      checks.push([
        "链尾提交：完成文案 + 跳转提示",
        chained.text.includes("动作链完成") && chained.text.includes("已跳转"),
      ]);
      await sleep(800);
      const done1 = (await call("text")).text;
      log(`链（提交收尾）回显页：${done1.slice(0, 160).replace(/\n/g, " ")}`);
      checks.push([
        "链填的值真到了页面（GET 参数回显）",
        done1.includes("姓名=张三") && done1.includes("邮箱=zhang@example.com"),
      ]);

      // 链中提交：跳转后面的动作不该执行（邮箱应保持空）
      await call("navigate", { url: `${server.url}form.html` });
      const snap2 = (await call("snapshot")).text;
      const name2 = formInputRef(snap2, "姓名字段");
      const email2 = formInputRef(snap2, "邮箱字段");
      const submit2 = formSubmitRef(snap2);
      if (name2 !== undefined && email2 !== undefined && submit2 !== undefined) {
        const aborted = await runActionChain(chainBridge, [
          { action: "type", ref: name2, text: "李四" },
          { action: "click", ref: submit2 },
          { action: "type", ref: email2, text: "不该被输入" },
        ]);
        log(`链（中途跳转）：${aborted.text.split("\n").slice(0, 4).join(" | ")}`);
        checks.push([
          "链中提交：中止并如实报告未执行数",
          aborted.text.includes("已中止") && aborted.text.includes("余下 1 个动作未执行"),
        ]);
        await sleep(800);
        const done2 = (await call("text")).text;
        log(`链（中途跳转）回显页：${done2.slice(0, 160).replace(/\n/g, " ")}`);
        checks.push([
          "跳转后未执行的动作真的没发生",
          done2.includes("姓名=李四") && !done2.includes("不该被输入"),
        ]);
      }
    } else {
      log("表单页靶元素未找全，跳过动作链断言");
    }

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
 * ⑦-G 的「任务摘要」（v1.67 起三段：本次用量 → 计划 → 紧跟的一行总账）同样用**真实的事件通道**（`session.view`）推一个
 * **受控视图**来驱动：不跑模型，但走的是产品里一模一样的那条链路（事件 → DOM → 点击 → 落点）。
 * ⑦-G 第四步之后「点文件路径 → 预览」落进「任务摘要」的下钻**内容层**（工具卡是唯一入口），
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
