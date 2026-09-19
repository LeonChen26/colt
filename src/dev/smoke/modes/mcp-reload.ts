// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：mcp-reload
 *
 * MCP 的**配置热重载 + 设置页可见性**链路（**不调模型、不计费**）。
 *
 * 为什么单独一条：单测覆盖了 runtime 的装载 / 分页 / 远程 / reload 与配置纯函数，
 * 但**从渲染层到主进程、再到 worker、再绕回来**这一段——`mcp.status` / `mcp.reload`
 * 两个 IPC → `SessionManager` 的 FIFO 兑现 → worker 的 `mcpReload` 命令 →
 * 工具清单写回 harness 与主 lane——**一个字节都没验过**。这段全是「名字对不上就静默失效」
 * 的接线（协议字段名、FIFO 配对、命令路由），正是 `AGENTS.md` §四说的
 * 必须跑一遍真实链路才放心的那一类。
 *
 * 夹具：`out/smoke-mcp-reload-fixture/.colt/mcp.json`，全程改写三版配置：
 * ① 只有 `alpha`（3 工具的 stdio 夹具）→ ② 加上 `beta`（分页夹具，5 工具）→ ③ 只剩 `beta`。
 * server 进程用 `ELECTRON_RUN_AS_NODE` 让 electron 按 Node 跑（不依赖 PATH 里有 node，
 * 同 mcp-e2e）。另有一个**永远不开会话**的项目 `out/smoke-mcp-reload-other`，
 * 专门验「没有活 worker」那条退路。
 *
 * 断言分四组：① 冷启动装载；② 热重载加 server（分页那支真的收全了）；③ 热重载删 server；
 * ④ 两个 IPC 的返回形状（含 `live: false` 的退路）。
 *
 * **不含设置页 DOM 断言**：设置页那段跟渲染层的 `activeProject` 走，而冒烟里它是渲染层
 * 自己的选择（它是并发参与者，见 ask-user-e2e 的原则）。界面层的判据落在这两个 IPC 上——
 * 组件只是把它们画出来；DOM 这一半靠人工看一眼截图。
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSession, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { sleep, uncaughtErrors } from "../context";

export async function runMcpReload(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-mcp-reload-fixture");
  const otherDir = join(process.cwd(), "out", "smoke-mcp-reload-other");
  const alpha = {
    command: process.execPath,
    args: [join(process.cwd(), "tests", "helpers", "mcp-fixture-server.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const beta = {
    command: process.execPath,
    args: [join(process.cwd(), "tests", "helpers", "mcp-paged-fixture-server.mjs")],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };

  const writeConfig = (servers: Record<string, unknown>): void => {
    mkdirSync(join(fixtureDir, ".colt"), { recursive: true });
    writeFileSync(
      join(fixtureDir, ".colt", "mcp.json"),
      JSON.stringify({ mcpServers: servers }, null, 2),
      "utf8",
    );
  };

  writeConfig({ alpha });
  // 另一个项目：有声明、但**全程不开会话**——验「没有活 worker」的退路（live:false + idle）
  mkdirSync(join(otherDir, ".colt"), { recursive: true });
  writeFileSync(
    join(otherDir, ".colt", "mcp.json"),
    JSON.stringify({ mcpServers: { solo: alpha } }, null, 2),
    "utf8",
  );
  const otherProject = upsertProject(otherDir);

  // ⚠️ 必须**跨毫秒**（`sleep(5)`）：`listProjects()` 只有 `ORDER BY last_opened_at DESC`、
  // **没有次级键**，两个 upsert 落在同一毫秒就排序不定——实测到两行 `last_opened_at` 完全相同
  // （`1789816825110`），排序把 other 排到了第一，于是渲染层自动打开的是**那个没会话的项目**，
  // 本模式的「前置：渲染层自动打开夹具会话」当场假红（`AGENTS.md` ⑬：前提要显式建立，
  // 别指望「两次调用恰好不同毫秒」）。
  await sleep(5);
  // 顺序有意：夹具项目**最后** upsert，last_opened_at 严格最新 ⇒ 渲染层自动打开的当前项目是它
  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  log(`夹具项目：${fixtureDir}（.colt/mcp.json 第一版：只有 alpha）`);
  log(`会话：${session.id}（项目：${project.name}）`);
  log(`无会话项目：${otherDir}`);

  const checks: [string, boolean][] = [];
  const summarize = (servers: { name: string; status: string; tools: string[] }[]): string =>
    JSON.stringify(servers.map((item) => ({ name: item.name, status: item.status, tools: item.tools.length })));

  try {
    // 与 mcp-e2e 同一条路：worker 的生死交给渲染层（挂载时自动打开「当前项目」的最新会话）
    window.reload();
    await sleep(4000);
    const readyDeadline = Date.now() + 60_000;
    let opened = false;
    while (Date.now() < readyDeadline) {
      if (sessionManager.getView(session.id)) {
        opened = true;
        break;
      }
      await sleep(1000);
    }
    checks.push(["渲染层自动打开夹具会话（worker 就绪）", opened]);
    if (!opened) return;

    // ① 冷启动装载：worker init 时按第一版配置连上 alpha
    const initial = await sessionManager.mcpStatus(session.id);
    log(`初始状态：${summarize(initial)}`);
    checks.push([
      "冷启动装载：alpha 已连接，3 个工具名逐字正确",
      initial.length === 1 &&
        initial[0]!.name === "alpha" &&
        initial[0]!.status === "connected" &&
        initial[0]!.transport === "stdio" &&
        ["mcp__alpha__echo", "mcp__alpha__add", "mcp__alpha__fail"].every((name) =>
          initial[0]!.tools.includes(name),
        ),
    ]);

    // ② 热重载：加 beta（分页夹具）——同一个 worker，不重启会话
    writeConfig({ alpha, beta });
    const added = await sessionManager.mcpReload(session.id);
    const addedByName = new Map(added.map((item) => [item.name, item]));
    log(`加 beta 后：${summarize(added)}`);
    checks.push([
      "热重载（加 server）：两个 server 都在、都连着——会话没重启",
      added.length === 2 &&
        addedByName.get("alpha")?.status === "connected" &&
        addedByName.get("beta")?.status === "connected",
    ]);
    checks.push([
      "分页 server 在真 worker 里也收全了（beta 的 5 个工具一个不少）",
      ["page1", "page2", "page3", "page4", "page5"].every((name) =>
        (addedByName.get("beta")?.tools ?? []).includes(`mcp__beta__${name}`),
      ),
    ]);

    // ③ 热重载：删 alpha——它连工具一起消失（清单与 harness 必须同时对齐，见 mcp-reload.ts）
    writeConfig({ beta });
    const removed = await sessionManager.mcpReload(session.id);
    const removedByName = new Map(removed.map((item) => [item.name, item]));
    log(`删 alpha 后：${summarize(removed)}`);
    checks.push([
      "热重载（删 server）：alpha 连工具一起消失，beta 照常",
      removed.length === 1 &&
        removedByName.get("beta")?.status === "connected" &&
        !removed.some((item) => item.tools.some((tool) => tool.startsWith("mcp__alpha__"))),
    ]);

    // ④ 两个 IPC 的返回形状（设置页看到的就是这两条）
    const live = await run<{ servers: { name: string }[]; live: boolean }>(
      `window.colt.invoke("mcp.status", ${JSON.stringify({ projectId: project.id })})`,
    );
    checks.push([
      "IPC mcp.status（有活会话）：live=true 且是活运行态",
      live.live === true && live.servers.length === 1 && live.servers[0]!.name === "beta",
    ]);

    const idle = await run<{ servers: { name: string; status: string }[]; live: boolean }>(
      `window.colt.invoke("mcp.status", ${JSON.stringify({ projectId: otherProject.id })})`,
    );
    log(`无会话项目：${JSON.stringify(idle)}`);
    checks.push([
      "IPC mcp.status（无活会话）：live=false，回配置声明且 status=idle（「没打开会话」≠「没连上」）",
      idle.live === false &&
        idle.servers.length === 1 &&
        idle.servers[0]!.name === "solo" &&
        idle.servers[0]!.status === "idle",
    ]);

    const ipcReload = await run<{ servers: { name: string }[]; live: boolean }>(
      `window.colt.invoke("mcp.reload", ${JSON.stringify({ projectId: project.id })})`,
    );
    checks.push([
      "IPC mcp.reload（有活会话）：live=true，重载后仍是 beta",
      ipcReload.live === true && ipcReload.servers.length === 1 && ipcReload.servers[0]!.name === "beta",
    ]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    try {
      await run(
        `window.colt.invoke("session.close", ${JSON.stringify({ sessionId: session.id })})`,
      );
    } catch (error) {
      log(`关闭会话失败（无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[mcp-reload] 断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
