// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：basic
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import { sleep, report } from "../context";

export async function runBasic(
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
