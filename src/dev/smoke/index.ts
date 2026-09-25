// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 端到端冒烟
 * basic：建项目 → 建会话 → 真实对话 → 截图
 * advanced：多会话并行 → 分支查询 → navigateTree 分叉 → 截图
 * fixture：以本地夹具站为靶子，不开模型跑完浏览器能力（观测 + 上传下载 + 弹窗拦截）
 * ask-user：模型提问（ask_user）的阻塞链路——卡片真的出现、选项真的能点、答案载荷与选择一致、
 *       跳过与超时各自收尾、全权模式下照样弹（不打模型、不计费）
 * ask-user-e2e：同上链路的**真实模型**版——模型真的看见并调用 ask_user、全权模式下不被
 *       静默放行、答案作为工具结果回到模型且它接着往下做（**打模型、计费**）
 * mcp-e2e：MCP 工具链路的**真实模型**端到端（打模型；云端计费，本地 Ollama 免费）——
 *       模型真的看得见 mcp__ 工具 → 调用弹审批卡（未知工具等人批，不静默放行）→
 *       点「允许一次」→ 夹具 stdio server 真实往返 → 结果作为工具结果回到模型。
 *       夹具 `out/smoke-mcp-e2e-fixture/.colt/mcp.json` 声明 server `fixture`，
 *       server 进程用 ELECTRON_RUN_AS_NODE 让 electron 按 Node 跑（不依赖 PATH 有 node）
 * mcp-real：真实**第三方** server 版（打模型；本地 Ollama 免费，云端计费）——场景由
 *       COLT_SMOKE_MCP_SCENARIO 选（filesystem / pi-lens），验「真 server 的工具名逐字落到
 *       审批卡」与「真 stdio 往返」；pi-lens 场景另印证「自带 MCP server 的第三方扩展可直连」
 * mcp-reload：MCP 的**配置热重载 + 设置页可见性**链路（**不打模型、不计费**）——两版配置
 *       现写现 reload：冷启动装载 → 加 server（分页那支在真 worker 里也收全）→ 删 server
 *       （连工具一起消失，同一 worker 不重启）；再验 `mcp.status` / `mcp.reload` 两个 IPC 的
 *       返回形状，含「没有活会话」时的退路（live=false + 声明 + idle）
 * skills-reload：技能的**设置页可见性 + 热重载 + 启用/禁用**链路（**不打模型、不计费**）——三版技能目录
 *       现写现 rescan：冷启动装载 → 加技能（不重启会话即可用）→ 超长正文（给用户看全文、
 *       告警如实说模型只收到截断后的）；再单个禁用（偏好落到项目级 .colt/skills.json、`/` 候选
 *       随之排除、启用后恢复）；最后验 `skills.status` / `skills.rescan` / `skills.setDisabled` /
 *       `skills.reveal` 的返回形状，含「没有活会话」时的退路（live=false + 空清单）
 * subagent-e2e：子代理链路的**真实模型**端到端（打模型；云端计费，本地 Ollama 免费）——
 *       模型按名调用 demo 子代理（＝<available_subagents> 清单真进了提示词）→
 *       subagent 调用免闸、子 lane 的内部 write 照常弹审批卡（带「来自 demo」归属）→
 *       点「允许一次」→ 子代理结论回主模型；fresh 隔离用「主对话密语缺席于子代理
 *       transcript」的确定性判据。夹具 `.agents/agents/demo.md` 与生产发现路径同构
 * dock：工作区（右栏）界面行为——折叠/展开、拖拽调宽与上下限、宽度记忆、⑦-F 自动展开、
 *       ⑦-G 的「任务摘要」（v1.67 起三段：本次用量 → 计划 → 紧跟的一行总账）与它的下钻（清单 → diff → 内容）、
 *       点文件路径 → 下钻内容层（工具卡入口）、页签关闭与「+」新增视图、
 *       面板迁入页签（A3-5 / ⑦-H / ⑦-G：「工具」「改动」「文件」三个视图都取消后只剩统计与规则）、
 *       观测抽屉（B2）与它的**条目详情**（N1：点行展开完整字段 + 复制到剪贴板）、
 *       浏览器前进/后退/刷新（B1），以及 ⑥ Live Bar 的运行状态段（C1/C2：已中断 / 已失败 / 空闲）
 * rm-workspace：「移除工作区」（规则 ③-D）三段——①「运行中的会话让整次移除被拒绝」+
 *       「跑完就能删」的对照；②「假 worker 对**不属于本用例的会话**零写入」（渲染层挂载会
 *       自动打开当前项目第一条会话，那多半是用户的真实会话）；③**点界面那一按**的连锁反应
 *       （原生确认框打桩成「确认」，断言侧栏那行消失 / 库里也没了 / 别家项目没被牵连）。
 *       ①② 要挂 `COLT_WORKER_OVERRIDE=scripts/running-worker.cjs` 假 worker（不调模型、
 *       不计费），**缺了就明说跳过**；③ 不依赖它，总在跑。前提自己建：独立靶子项目 +
 *       临时免密钥 provider，不碰本机既有配置
 * model：未开启会话（无 worker）时也能选模型——落库的选定值照样回显、切换立即生效；
 *        以及**没有可用模型**时主区黄条与对话区共存（输入卡片的下半行不能被裁掉）；
 *        另有「还没用起来的会话」一条链：空项目直接给草稿（打开就见输入框）、草稿不进侧栏、
 *        首次发消息才落库转正，以及**起手态**的排布（输入卡片上移到相对中间）与出口
 *        （「新建工作目录」真的在磁盘上建出目录并切过去）
 * memory：跨会话记忆检索（L3a）的真实跨进程链路——不开模型：真实 worker 起动即上报
 *        memoryIndex → 主进程落派生库（data/memory.db）→ hostBridge memory 检索；
 *        另验二字词 LIKE 兜底（FTS trigram 3 字下限）、项目隔离、关会话清检索上下文
 * memory-e2e：记忆行为的真实调用验证（**打模型、计费**）——注入可见性（不读文件答密语）、
 *        沉淀落盘+索引同步、/memory-tidy 整理（合并/删过时/归档/通知/改动记录）、
 *        冷层检索（现行文件已删的条目仍能被 memory_search 答出）
 * todo：待办清单（第 ④ 项目能力）的跨进程链路与界面，**不打模型**——走产品自己的写入路径
 *        `hostBridge.handle({capability:"todo"})`：真实往返（工具 → 库 → 主进程视图 → DOM）、
 *        单条 in_progress 约束、已完成折一行 + 命中测试、依赖未满足的「等待：」与拒绝开工、
 *        空态两层（无清单不渲染 / 有清单空闲）、页签更名（v1.48「任务摘要」）、
 *        worker 回收重启后从库重建、下钻面包屑与「返回」文案同名
 * perf：长会话的**渲染**开销（不调模型、不计费）——用 rAF 采样最长帧：条数扫描量「打开长会话」
 *        的挂载成本；再量流式期间「每 50ms 整份重推」的每帧成本，且分三组对照——「只动最后一条」
 *        （真实流式）、「内容一个字节都不变」（稳定投影的纯度检验）、「空历史」
 *        （把消息列表的成本从容器自身的固定成本里分出来）；
 *        末段断言「消息窗口」：只挂最近一段（挂载数不随历史增长）、流式追加时跟着走、
 *        「载入更早」按段展开、显式展开后不再跟随——判据取每行的 `data-msg-row` 与界面文字；
 *        再断言「只看问答」的整轮折叠：默认不收、打开后每轮收成一行、点开能看回过程、
 *        关掉完全复原，且**提问与最终回复一条不少**（折叠最容易犯的错是连正文一起收掉）；
 *        最后断言「目录 / 搜历史」：列出每条提问、搜索只回命中、点一行**真的跳过去**，
 *        且跳过去之后**挂载数仍是一个窗口**（尾行不等于末尾）——
 *        跳转若沿用「一直挂到末尾」就把几千条一次挂出来，等于把窗口作废
 * subagent：子代理的呈现链路（不调模型、不计费）——推受控视图驱动：④ 卡**特化** + 有界预览
 *        （如实说「最近 12 / 共 20 步」）、**此刻动作只在 ④**（右栏不再重复列，v1.53）、
 *        「中止」在 **④ 子代理卡**上（命中测试）、**不自动展开右栏**（决策三）、
 *        已结束后不再给「中止」而 ④ 卡保留、点 ④ 卡「在右栏查看完整过程」→ **下钻到子代理流**
 *        （面包屑 + ESC 逐层回退；完整流按需拉、拉不到如实说）、不存在的子代理回空而非报错；
 *        分支树排除与导航守卫属 worker 侧会话数据，由 `tests/lane-ownership.test.ts` 覆盖
 *
 * 本文件只做**调度**：建 log / run 两个闭包、按 COLT_SMOKE_MODE 分派、收尾截图与落日志。
 * 各模式的正文在 `modes/` 下，共享件在 `context.ts`。
 *
 * 这里**不住在 src/main/**：它是开发期装置，放进生产源码树会让 main 层凭空多出三分之一体积，
 * 且能随手 import 主进程内部——搬出来之后这层越界在物理上就不成立了。
 */
import { app, BrowserWindow } from "electron";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { deleteSession, listSessions, upsertProject } from "../../main/db/repo";
import { sessionManager } from "../../main/session-manager";
import { dirname, join } from "node:path";
import {
  removeFixtureProjects,
  removeOrphanSessionJsonl,
  setActiveOutputPath,
  sleep,
  uncaughtErrors,
} from "./context";
import { runAskUser } from "./modes/ask-user";
import { runAskUserE2e } from "./modes/ask-user-e2e";
import { runBasic } from "./modes/basic";
import { runAdvanced } from "./modes/advanced";
import { runApproval } from "./modes/approval";
import { runCrash } from "./modes/crash";
import { runDock } from "./modes/dock";
import { runUiLogic } from "./modes/ui-logic";
import { runFixture } from "./modes/fixture";
import { runHost } from "./modes/host";
import { runMemory, runMemoryE2e } from "./modes/memory";
import { runMcpE2e } from "./modes/mcp-e2e";
import { runMcpReal } from "./modes/mcp-real";
import { runMcpReload } from "./modes/mcp-reload";
import { runSkillsReload } from "./modes/skills-reload";
import { runSubagentE2e } from "./modes/subagent-e2e";
import { runPerf } from "./modes/perf";
import {
  runModelFallback,
  runModelKeyless,
  runModelNoUsable,
  runModelSelect,
  runModelSwitchDuringOpen,
  runSessionDraft,
} from "./modes/model";
import { runReenter } from "./modes/reenter";
import { runRmWorkspace } from "./modes/rm-workspace";
import { runSubagent } from "./modes/subagent";
import { runTodo } from "./modes/todo";

export async function runSmoke(window: BrowserWindow, outputPath: string): Promise<void> {
  // outputPath 由 launcher 归一化到 out/ 下（见 main/index.ts 的 smokeArtifactPath）
  setActiveOutputPath(outputPath);
  // 起手区「新建工作目录」（`project.createScratch`）默认落在**家目录**的 Colt/ 下——
  // 那是用户真实的工作产物目录，自动跑时绝不能碰。指到 out/ 下（已 gitignore），
  // 且路径**固定**（override 是原样使用的，不拼时间戳）：于是 upsertProject 按 root_key
  // 去重，跑一百次也只留一行项目，不会攒出一串只在冒烟里存在的目录（AGENTS.md §五⑩）。
  // 调用方自己设了就用它（`??=`）——那是有意为之，别覆盖。
  process.env.COLT_WORKSPACE_ROOT ??= join(dirname(outputPath), "smoke-workspace");
  // 内置技能目录（随包分发的那份 `out/main/builtin-skills`）同样要**显式置空**：它就躺在
  // worker 旁边的产物目录里，不指开的话「这台机器上装了几个技能」取决于**当前包里带了什么**，
  // 于是加一个内置技能就会让别的模式的技能清单悄悄多一条。要真验随包那份的模式自己删掉这个
  // 变量（见 `modes/skills-reload.ts` 的 ①b）。前提要自己建立，别指望它恰好为空（AGENTS.md §五⑬）。
  //
  // 默认那个目录**先删后建**：上一轮往里写过技能的话，「空目录」就是假的，别的模式会带着
  // 上一轮的名字开跑。只清我们自己定的那个——调用方显式设的**不动**，清它等于删人家的东西。
  if (process.env.COLT_BUILTIN_SKILLS_DIR === undefined) {
    const dir = join(dirname(outputPath), "smoke-builtin-skills");
    rmSync(dir, { recursive: true, force: true });
    process.env.COLT_BUILTIN_SKILLS_DIR = dir;
  }
  mkdirSync(process.env.COLT_BUILTIN_SKILLS_DIR, { recursive: true });
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

  // 环境前提显式化（AGENTS.md §五⑬）：交互桌面上跑冒烟，窗口随时可能被别的窗遮住
  // （Windows 遮挡检测 → document.hidden=true）。F11（visible-interval）之后「窗口不可见
  // 就停表」是**产品行为**——断言依赖的 400ms 电平重申 / 1s 观测轮询会在遮挡期间停摆，
  // 红的是环境不是产品（2026-09-19 实测：dock 3 红，全是遮挡期间重申滞后、读数冻结）。
  // 所以这里钉死「始终可见」并关掉后台节流，与 browser-host 对浏览器视图的做法同因
  // （`browser-host.ts` #applyBounds：hidden 的页面不重排，读数全冻结）。
  // 「不可见时暂停」这一行为本身由 tests/visible-interval.test.ts 逐拍单测覆盖，
  // 冒烟不需要、也不应该在遮挡态下再验一遍。
  const pinVisibility = (): void => {
    void window.webContents
      .executeJavaScript(`(() => {
        Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
        Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
      })()`)
      .catch(() => undefined);
  };
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on("did-finish-load", pinVisibility);
  pinVisibility();

  // 会话清扫的锚点：try 内赋值（upsert 出项目即记），finally 据此只删「本次新增」的会话。
  let smokeProjectId: string | undefined;
  let preexistingSessionIds = new Set<string>();

  try {
    const projectRoot = process.env.COLT_SMOKE_CWD ?? process.cwd();
    const project = upsertProject(projectRoot);
    smokeProjectId = project.id;
    // 跑前快照本项目已有会话：收尾只删这之后新建的，跑之前就在库里的一律不碰——
    // 冒烟拿的是开发者的真实项目（upsertProject 的是仓库根），不能顺手动用户数据。
    preexistingSessionIds = new Set(listSessions(project.id).map((session) => session.id));
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
    } else if (mode === "ask-user") {
      await runAskUser(window, project.id, sessionsDir, log, run);
    } else if (mode === "ask-user-e2e") {
      await runAskUserE2e(window, log, run);
    } else if (mode === "mcp-e2e") {
      await runMcpE2e(window, log, run);
    } else if (mode === "mcp-real") {
      await runMcpReal(window, log, run);
    } else if (mode === "mcp-reload") {
      await runMcpReload(window, log, run);
    } else if (mode === "skills-reload") {
      await runSkillsReload(window, log, run);
    } else if (mode === "subagent-e2e") {
      await runSubagentE2e(window, log, run);
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
    } else if (mode === "ui-logic") {
      await runUiLogic(window, project.id, sessionsDir, log, run);
    } else if (mode === "rm-workspace") {
      await runRmWorkspace(window, project.id, sessionsDir, log, run);
    } else if (mode === "perf") {
      await runPerf(window, project.id, sessionsDir, log, run);
    } else if (mode === "todo") {
      await runTodo(window, project.id, sessionsDir, log, run);
    } else if (mode === "subagent") {
      await runSubagent(window, project.id, sessionsDir, log, run);
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
    // 夹具收尾：注销这次跑动用过的一次性夹具项目（否则每跑一趟就往库里攒会话）。
    // 放在落日志之前，好让「注销了哪些」也进 .log；失败不阻断本次结论。
    try {
      await removeFixtureProjects(log);
    } catch (error) {
      lines.push(`[SMOKE] 夹具收尾失败（不阻断结论）${String(error)}`);
    }
    // 会话清扫：各模式在冒烟项目（仓库根，开发者的真实项目）里直接 createSession 造会话，
    // 收尾不带走就会一直攒在侧栏里（2026-09-23 实测：dev 库攒出 173 条空会话——
    // model 每趟泄 4 条、perf 每趟 1 条，产品的草稿逻辑本身没坏：草稿只在内存，
    // 发首条消息才落库）。只删本次新增（跑前快照之外的那些）；先关 worker 再删行，
    // 最后把删行后变无主的 JSONL 历史一并扫掉（判据取文件头 kernelId，见 context.ts）。
    if (smokeProjectId !== undefined) {
      try {
        const created = listSessions(smokeProjectId)
          .filter((session) => !preexistingSessionIds.has(session.id))
          .map((session) => session.id);
        for (const sessionId of created) sessionManager.close(sessionId);
        if (created.length > 0) await sleep(300); // 等 dispose 的进程退出、释放 JSONL 句柄
        for (const sessionId of created) deleteSession(sessionId);
        if (created.length > 0) log(`会话清扫：删掉本次新建的会话 ${created.length} 条`);
        removeOrphanSessionJsonl(log);
      } catch (error) {
        lines.push(`[SMOKE] 会话清扫失败（不阻断结论）${String(error)}`);
      }
    }
    try {
      await writeFile(`${outputPath}.log`, lines.join("\n"), "utf8");
    } catch {
      // 日志落盘失败不影响结论
    }
    app.quit();
  }
}
