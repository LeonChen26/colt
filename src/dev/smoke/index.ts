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
 * dock：工作区（右栏）界面行为——折叠/展开、拖拽调宽与上下限、宽度记忆、⑦-F 自动展开、
 *       ⑦-G 的「任务摘要」（进行中的动作 + 底部总账）与它的下钻（清单 → diff → 内容）、
 *       点文件路径 → 下钻内容层（工具卡入口）、页签关闭与「+」新增视图、
 *       面板迁入页签（A3-5 / ⑦-H / ⑦-G：「工具」「改动」「文件」三个视图都取消后只剩统计与规则）、
 *       观测抽屉（B2）与它的**条目详情**（N1：点行展开完整字段 + 复制到剪贴板）、
 *       浏览器前进/后退/刷新（B1），以及 ⑥ Live Bar 的运行状态段（C1/C2：已中断 / 已失败 / 空闲）
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
 *
 * 本文件只做**调度**：建 log / run 两个闭包、按 COLT_SMOKE_MODE 分派、收尾截图与落日志。
 * 各模式的正文在 `modes/` 下，共享件在 `context.ts`。
 *
 * 这里**不住在 src/main/**：它是开发期装置，放进生产源码树会让 main 层凭空多出三分之一体积，
 * 且能随手 import 主进程内部——搬出来之后这层越界在物理上就不成立了。
 */
import { app, BrowserWindow } from "electron";
import { appendFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { upsertProject } from "../../main/db/repo";
import { dirname, join } from "node:path";
import { setActiveOutputPath, uncaughtErrors } from "./context";
import { runAskUser } from "./modes/ask-user";
import { runAskUserE2e } from "./modes/ask-user-e2e";
import { runBasic } from "./modes/basic";
import { runAdvanced } from "./modes/advanced";
import { runApproval } from "./modes/approval";
import { runCrash } from "./modes/crash";
import { runDock } from "./modes/dock";
import { runFixture } from "./modes/fixture";
import { runHost } from "./modes/host";
import { runMemory, runMemoryE2e } from "./modes/memory";
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
    } else if (mode === "ask-user") {
      await runAskUser(window, project.id, sessionsDir, log, run);
    } else if (mode === "ask-user-e2e") {
      await runAskUserE2e(window, log, run);
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
    } else if (mode === "perf") {
      await runPerf(window, project.id, sessionsDir, log, run);
    } else if (mode === "todo") {
      await runTodo(window, project.id, sessionsDir, log, run);
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
