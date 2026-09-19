// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：crash
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import { isDev } from "../../../main/lib/app-mode";
import { sleep } from "../context";

/**
 * 故障注入冒烟：让 worker 在发回就绪事件前就退出，
 * 验证 session.open 会「快速失败」而不是永久挂起（否则界面卡在启动提示）。
 */
export async function runCrash(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  // 这条模式**只有真装上故障才有意义**：不装的话 session.open 会正常成功、打出「OK」，
  // 等于把「就绪前退出能否快速失败」这条路径**全绿地放过去**。实测踩过（2026-09-18）：
  // 当时 `!app.isPackaged` 的运行期漂移让注入永远装不上，这里却什么都没说。
  // 所以先自证前提，缺了就**明说跳过**，而不是交出一份看着通过的日志。
  if (!isDev || !process.env.COLT_WORKER_OVERRIDE) {
    log(
      "跳过：未装故障注入，这条模式验不了任何东西。" +
        `当前 isDev=${isDev}、COLT_WORKER_OVERRIDE=${JSON.stringify(process.env.COLT_WORKER_OVERRIDE)}；` +
        "请设 COLT_WORKER_OVERRIDE=<仓库>/scripts/crash-worker.cjs 再跑。",
    );
    return;
  }
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
        .invoke("session.open", ${JSON.stringify({ sessionId: session.id })})
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
