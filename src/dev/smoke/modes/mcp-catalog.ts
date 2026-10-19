// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 内置可选 MCP 目录的**界面与 IPC**（P1 验收：设置页里真的有一行、点了看得见事实）。
 *
 * 不打模型、不计费、**不装任何东西**——这条模式只回答三件事：
 * 1. 设置页里那一行在不在，五项前置检查是不是都摆出来了；
 * 2. 「可选」是不是真的可选：没装的时候不该出现「卸载」，也不该有任何东西被自动写进
 *    用户级配置（本模式把 `COLT_MCP_HOME` 指到空目录，跑完检查它仍然只有 .colt 之外的空）。
 * 3. IPC 的形状：`mcp.catalog` 回的条目与探测项数量、`configPath` 是否指向隔离目录。
 *
 * 为什么不断言探测的**结论**：那取决于是哪台机器（有没有 Python、装没装 codewiki）。
 * 断言结论就等于把用例绑在开发者的环境上；这里断言的是**结构**——四项都在、每项都有
 * 结论文字、失败的有下一步。至于每个分支的判定，`tests/mcp-catalog.test.ts` 用注入的执行器
 * 逐条钉住了（那才是能造出「Python 3.11」「mcp 2.1」的地方）。
 */
import { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isolateUserHome, uncaughtErrors } from "../context";

export async function runMcpCatalog(
  // 本模式不开原生视图、不碰主进程窗口对象：界面断言一律走 `run()`（渲染层 executeJavaScript）
  _window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  // 前提显式建立（AGENTS.md §五⑬）：用户级 MCP 配置指到一个空目录，
  // 于是「没装」这件事是**我们摆出来的**，而不是「这台机器恰好没装」。
  const home = isolateUserHome("mcp-catalog", log);
  const userConfig = join(home, ".colt", "mcp.json");

  const checks: [string, boolean][] = [];

  // 设置页入口是一个 `title="设置"` 的按钮；重复点会切回对话，故先看区块在不在再点。
  // 设置页现在是**导航化**的（默认停在「模型服务」），所以点开之后还要切到 MCP 那一屏——
  // 否则 `data-mcp-preset` 根本不在 DOM 里（这是导航化带来的一处必然改动）。
  const openSettings = async (): Promise<boolean> => {
    const opened = await run<boolean>(`(async () => {
      const present = () => document.querySelector('[data-mcp-preset="codewiki"]') !== null;
      if (present()) return true;
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.getAttribute("title") === "设置");
      if (!button) return false;
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const nav = document.querySelector('[data-settings-nav="mcp"]');
      if (nav) nav.click();
      // 目录要一次 IPC 往返（里面还在跑前置检查）：轮询到卡片出现，别赌固定毫秒
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (present()) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return present();
    })()`);
    return opened;
  };

  const firstOpen = await openSettings();
  checks.push(["「MCP」屏的「可安装」段里出现 codewiki 卡片", firstOpen]);
  if (!firstOpen) {
    log("  设置页里没出现目录卡片，后面的 DOM 断言无从验起");
  }

  const card = await run<{
    found: boolean;
    text: string;
    probes: { id: string; ok: boolean; text: string }[];
    hasManual: boolean;
    hasUninstall: boolean;
    status: string;
  } | null>(
    `(() => {
      const el = document.querySelector('[data-mcp-preset="codewiki"]');
      if (!el) return null;
      const probes = [...el.querySelectorAll("[data-mcp-probe]")].map((row) => ({
        id: row.getAttribute("data-mcp-probe") ?? "",
        ok: row.getAttribute("data-mcp-probe-ok") === "1",
        text: (row.textContent ?? "").replace(/\\s+/g, " ").trim(),
      }));
      return {
        found: true,
        text: (el.textContent ?? "").replace(/\\s+/g, " ").trim(),
        probes,
        hasManual: el.querySelector("[data-mcp-manual]") !== null,
        hasUninstall: [...el.querySelectorAll("button")].some(
          (b) => (b.textContent ?? "").trim() === "卸载"),
        status: (el.textContent ?? "").includes("已安装") ? "installed" : "not-installed",
      };
    })()`,
  );

  checks.push([
    "检查项都在（Python / git / Node.js / codewiki / mcp）",
    (card?.probes.length ?? 0) === 5,
  ]);
  checks.push([
    "前置检查逐项都有结论文字（不是五个空白点）",
    (card?.probes ?? []).every((probe) => probe.text.length > 0),
  ]);
  checks.push([
    "「钉住」的版本要求写在卡片上（mcp < 2 那条是实测崩点）",
    card !== null && card.text.includes("mcp < 2"),
  ]);
  checks.push(["「不用一键安装」的手动命令留在折叠区里", card?.hasManual === true]);
  checks.push(["隔离目录里还没有配置（打开设置页不该顺手写盘）", existsSync(userConfig) === false]);
  checks.push([
    "没装时不出现「卸载」（没有«假装已装»的控件）",
    card?.status === "installed" ? card.hasUninstall : card?.hasUninstall === false,
  ]);

  // IPC 形状：与界面上看到的是同一份
  const view = await run<{
    presets: { id: string; installed: boolean; runtime: boolean; probe: { items: unknown[] }; configPath: string }[];
    configError: string | null;
  }>('window.colt.invoke("mcp.catalog", undefined)');
  checks.push(["mcp.catalog 恰好一项（首条是 codewiki）", view.presets.length === 1 && view.presets[0]?.id === "codewiki"]);
  checks.push([
    "catalog 的 configPath 指向隔离的用户目录（没退回家目录）",
    view.presets[0]?.configPath === userConfig,
  ]);
  checks.push(["catalog 的检查项也是五项", view.presets[0]?.probe.items.length === 5]);
  checks.push(["空目录下没有配置错误", view.configError === null]);

  // 再点一次「刷新」：幂等，且不会因为重复挂载多出一张卡
  const refreshed = await run<{ found: boolean; cards: number; settled: boolean }>(`(async () => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => ["刷新", "刷新中…"].includes((b.textContent ?? "").trim()));
    if (!button) return { found: false, cards: 0, settled: false };
    button.click();
    // 探测会 spawn 五条命令：轮询到按钮回到「刷新」，别赌固定毫秒
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if ((button.textContent ?? "").trim() === "刷新") break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const cards = document.querySelectorAll('[data-mcp-preset="codewiki"]').length;
    return { found: true, cards, settled: (button.textContent ?? "").trim() === "刷新" };
  })()`);
  // 「找不到按钮」必须单独判：否则上面的 cards 断言会在空转中静默通过（假绿）
  checks.push(["「刷新」按钮找得到（屏头唯一那个动作）", refreshed.found]);
  checks.push(["刷新能走完（按钮回到「刷新」）", refreshed.settled]);
  checks.push(["点「刷新」不会多出一张卡", refreshed.cards === 1]);

  checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  if (uncaughtErrors.length > 0) log(`  未捕获异常：${uncaughtErrors.join(" | ")}`);

  log(`前置检查读数：${JSON.stringify(card?.probes.map((probe) => [probe.id, probe.ok]) ?? [])}`);
  log("（探测结论随机器而变，本模式只断言结构与「可选」语义；判定分支见单测）");

  const passed = checks.filter(([, ok]) => ok).length;
  for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
  log(`通过 ${passed}/${checks.length}`);
}
