// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：mcp-real
 *
 * MCP 链路的**真实第三方 server** 端到端（打模型；本地 Ollama 免费，云端计费）。
 *
 * 与 mcp-e2e 的分工：mcp-e2e 用仓库自带夹具（server `fixture`、工具 `echo`）验
 * 「mcp__ 工具天然过闸门弹卡」这条机制；本模式换成**外部真实 server**，验夹具盖不住的两件事：
 *  ① 真 server 的工具名逐字落到审批卡上（server 名 + 工具名经 `mcpToolName` 拼装）；
 *  ② 真 server 的 stdio 往返真的发生。
 *
 * 场景由 `COLT_SMOKE_MCP_SCENARIO` 选（默认 `filesystem`）：
 *  - `filesystem`：官方 `@modelcontextprotocol/server-filesystem`，工具 `write_file`，
 *    「文件真的落到磁盘」是往返物证（不依赖界面自述）。
 *  - `pi-lens`：第三方 `pi-lens`（LSP + 60 余个 linter/type-checker + tree-sitter/ast-grep），
 *    它**自带 MCP server**（bin `pi-lens-mcp` → `dist/mcp/server.js`）。⚠️ 实测前提：
 *    它的 MCP server 启动时**静态 import** 了 `@earendil-works/pi-tui`（见其
 *    `dist/clients/deps/pi-tui.js`，是 3 个具名绑定的再导出），而 pi-tui 被它声明为
 *    **optional peer**（注释说「宿主运行时解析该裸标识符」）——所以只装 `pi-lens` 会
 *    `ERR_MODULE_NOT_FOUND: @earendil-works/pi-tui` 直接起不来，**必须把 pi-tui 一起装上**。
 *    「文档说宿主耦合很薄」与「运行时有硬 import」并不矛盾，但后者才是决定能不能跑起来的那条。
 *
 * 判据分层（AGENTS.md：前提由外部决定时要么显式建立、要么明说未成立）：
 *  - **模型无关层**（硬断言）：真 worker 连上该 server，事件流如实告知工具数。
 *  - **模型相关层**（best-effort）：模型是否去调该工具由模型决定；不调用就**明说「前提未成立，
 *    跳过」**，不照打一条假红（小模型 0.6b 的服从是概率事件）。
 */
import { app, BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSession, listSessionEvents, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { listProviders } from "../../../main/providers";
import { hasUsableProvider } from "@shared/model-ref";
import type { ConversationView } from "@shared/worker-protocol";
import { activeOutputPath, isolateUserHome, sleep, uncaughtErrors } from "../context";

interface PromptCtx {
  nonce: string;
  workDir: string;
}

interface Scenario {
  /** mcp.json 里的键，同时也是工具名里的 server 段 */
  serverName: string;
  /** 装到 `out/<installDir>` 的 npm 包，一次装齐（含运行期真正需要的 peer） */
  packages: string[];
  /** 安装根目录名（`out/` 下） */
  installDir: string;
  /** server 入口，相对 `out/<installDir>/node_modules` */
  entryParts: string[];
  /** server 进程的额外 argv（如允许目录） */
  extraArgs: (workDir: string) => string[];
  /** 要模型调用的完整工具名 */
  tool: string;
  /** 点名 prompt：弱模型也要能稳调用 */
  prompt: (ctx: PromptCtx) => string;
  /** 可选的磁盘物证：返回 [断言名, 是否通过] */
  diskProof?: (ctx: PromptCtx) => [string, boolean];
}

const SCENARIOS: Record<string, Scenario> = {
  filesystem: {
    serverName: "filesystem",
    packages: ["@modelcontextprotocol/server-filesystem@2026.8.31"],
    installDir: "mcp-real",
    entryParts: ["@modelcontextprotocol", "server-filesystem", "dist", "index.js"],
    extraArgs: (workDir) => [workDir],
    tool: "mcp__filesystem__write_file",
    prompt: ({ nonce, workDir }) =>
      `请**使用工具 mcp__filesystem__write_file** 创建一个文件：参数 path 填「${join(workDir, "mcp-proof.txt")}」，` +
      `参数 content 填「${nonce}」。不要使用其它工具。拿到工具返回后，把返回内容原样复述给我，然后停下来。`,
    diskProof: ({ nonce, workDir }) => {
      const target = join(workDir, "mcp-proof.txt");
      return [
        "官方 server 真的把文件写到了磁盘（内容含 nonce）",
        existsSync(target) && readFileSync(target, "utf8").includes(nonce),
      ];
    },
  },
  "pi-lens": {
    serverName: "pi-lens",
    // pi-tui 不是可选项：缺它 server 起不来（见文件头）
    packages: ["pi-lens@4.2.1", "@earendil-works/pi-tui@0.85.1"],
    installDir: "pi-lens",
    entryParts: ["pi-lens", "dist", "mcp", "server.js"],
    extraArgs: () => [],
    tool: "mcp__pi-lens__pilens_diagnostics",
    prompt: () =>
      "请**使用工具 mcp__pi-lens__pilens_diagnostics**（参数留空）。不要使用其它工具，不要编造结果。" +
      "拿到工具返回后，把返回内容原样复述给我，然后停下来。",
  },
};

export async function runMcpReal(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const checks: [string, boolean][] = [];

  const scenarioKey = process.env.COLT_SMOKE_MCP_SCENARIO ?? "filesystem";
  const scenario = SCENARIOS[scenarioKey];
  if (scenario === undefined) {
    log(`未知场景 ${scenarioKey}（可选：${Object.keys(SCENARIOS).join(" / ")}）`);
    return;
  }
  const { serverName, tool: MCP_TOOL } = scenario;
  // 用户级（全局）MCP 配置会一并生效——先置空，免得本机的全局 server 混进这次真实往返。
  isolateUserHome(`mcp-real-${serverName}`, log);

  const repoRoot = process.cwd();
  const serverRoot = join(repoRoot, "out", scenario.installDir);
  const serverEntry = join(serverRoot, "node_modules", ...scenario.entryParts);
  const fixtureDir = join(repoRoot, "out", `smoke-mcp-${serverName}`);
  const workDir = join(repoRoot, "out", `smoke-mcp-${serverName}-work`);
  const nonce = `colt-mcp-real-${Math.random().toString(16).slice(2, 10)}`;

  /** 主进程直读视图：不绕渲染层（那条路受界面状态影响） */
  const getView = (): ConversationView | undefined => sessionManager.getView(sessionId);

  /** 等一轮运行落定；判据同 mcp-e2e */
  const waitSettled = async (before: number, timeoutMs: number): Promise<ConversationView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = getView();
      if (view && !view.running) {
        const failed = view.lastRun !== null && view.lastRun.status !== "completed";
        const answered =
          view.messages.length > before &&
          view.messages.some((m, i) => i >= before && m.role === "assistant");
        if (failed || answered) {
          if (failed) log(`运行终态异常：${view.lastRun?.status}（${view.lastRun?.error ?? ""}）`);
          return view;
        }
      }
      if (Date.now() > deadline) throw new Error("等待运行结束超时");
      await sleep(2000);
    }
  };

  /**
   * 等模型发起该 MCP 工具调用（以「待审队列出现该工具」为信号）。
   * 返回 undefined 表示模型本轮结束了却没调用——**前提未成立**，由调用方明说并跳过往返断言。
   */
  const waitApproval = async (timeoutMs: number): Promise<string | undefined> => {
    const deadline = Date.now() + timeoutMs;
    let sawRunning = false;
    for (;;) {
      const hit = sessionManager.approvals
        .listPending(sessionId)
        .find((item) => item.toolName === MCP_TOOL);
      if (hit !== undefined) return hit.toolCallId;
      const view = getView();
      if (view?.running === true) sawRunning = true;
      if (sawRunning && view !== undefined && !view.running) {
        log(`本轮终态：${JSON.stringify(view.lastRun)}`);
        for (const item of view.toolResults.filter((r) => r.isError)) {
          log(`  工具报错：${item.output.slice(0, 300)}`);
        }
        log(`模型没调用 ${MCP_TOOL} 就结束了本轮`);
        return undefined;
      }
      if (Date.now() > deadline) {
        log(`等待 ${MCP_TOOL} 超时（${timeoutMs}ms）`);
        return undefined;
      }
      await sleep(1000);
    }
  };

  /**
   * 等某个工具调用的结果落进视图。
   * 刻意**不**等整轮收尾（`running` 变 false）：结果一到就够断言了，而本地小模型拿到结果后
   * 还要啰嗦很久——把 MCP 的判据挂在模型收尾上会让它假红（实测 0.6b 会超过 180s）。
   */
  const waitToolResult = async (
    toolCallId: string,
    timeoutMs: number,
  ): Promise<ConversationView["toolResults"][number] | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = getView()?.toolResults.find((item) => item.id === toolCallId);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) return undefined;
      await sleep(1000);
    }
  };

  // 缺包就地装一次（落 out/，gitignored；不进 package.json，不污染产品依赖）。
  // ⚠️ 必须**一次装齐** scenario.packages：`npm i --prefix --no-save <单个包>` 会把此前
  // 装的东西当多余依赖清掉（npm 按该目录的 package.json 收敛整棵树）。
  if (!existsSync(serverEntry)) {
    log(`未找到 ${serverName} server，正在安装 ${scenario.packages.join(" + ")} → ${serverRoot}`);
    const install = spawnSync(
      "npm",
      ["i", "--prefix", serverRoot, "--no-save", "--silent", ...scenario.packages],
      { shell: true, encoding: "utf8" },
    );
    log(`  安装退出码：${install.status ?? "null"}`);
    if (install.stderr) log(`  ${install.stderr.trim().slice(0, 400)}`);
  }
  checks.push([`前置：${serverName} server 已就绪（入口文件存在）`, existsSync(serverEntry)]);
  if (!existsSync(serverEntry)) return;

  mkdirSync(join(fixtureDir, ".colt"), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  // ELECTRON_RUN_AS_NODE：electron 按 Node 解释器跑第三方 server——不依赖 PATH 里有 node。
  writeFileSync(
    join(fixtureDir, ".colt", "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          [serverName]: {
            command: process.execPath,
            args: [serverEntry, ...scenario.extraArgs(workDir)],
            env: { ELECTRON_RUN_AS_NODE: "1" },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  const sessionId = session.id;
  log(`场景：${scenarioKey}（server=${serverName}，工具=${MCP_TOOL}）`);
  log(`夹具项目：${fixtureDir}（已写 .colt/mcp.json）`);
  log(`会话：${sessionId}`);

  try {
    if (!hasUsableProvider(listProviders())) {
      checks.push(["前置：存在已配密钥的模型服务（没有就无法真实调用）", false]);
      log("没有已配密钥的模型服务。请先在设置里配好一个服务再跑本模式。");
      return;
    }
    checks.push(["前置：存在可用的模型服务", true]);

    window.reload();
    await sleep(4000);
    const readyDeadline = Date.now() + 60_000;
    let opened = false;
    while (Date.now() < readyDeadline) {
      if (getView()) {
        opened = true;
        break;
      }
      await sleep(1000);
    }
    checks.push(["渲染层自动打开夹具会话（worker 就绪）", opened]);
    if (!opened) return;

    // 模型无关层的硬断言：真 worker 连上了该第三方 server。
    // 连不上就**不往下发 prompt**——否则白烧一次模型调用却验的是「没接上」的场景。
    const eventsDeadline = Date.now() + 40_000;
    let mcpEvent: string | null = null;
    while (Date.now() < eventsDeadline) {
      const hit = listSessionEvents(sessionId).find(
        (item) =>
          item.message.includes("MCP") &&
          item.message.includes(serverName) &&
          item.message.includes("已连接"),
      );
      if (hit) {
        mcpEvent = hit.message;
        break;
      }
      await sleep(500);
    }
    checks.push([
      `装载如实告知：事件流里有「已连接 ${serverName}」记录（真 worker 连上了该 server）`,
      mcpEvent !== null,
    ]);
    if (mcpEvent !== null) log(`  事件：${mcpEvent}`);
    if (mcpEvent === null) {
      log("该 server 未连上，跳过模型调用（不白烧一次调用）");
      return;
    }

    // 对抗条件：审批档（同 mcp-e2e——MCP 的安全语义就是弹卡等人批）
    await run(
      `window.colt.invoke("approval.mode.set", ${JSON.stringify({
        sessionId,
        mode: "approval",
      })})`,
    );
    log("审批模式已设为 approval（弹卡等人批，正是要验的那条闸门）");

    const prompt = scenario.prompt({ nonce, workDir });
    const before = getView()?.messages.length ?? 0;
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId, text: prompt })})`,
    );
    log(`已发出 prompt，等模型调用 ${MCP_TOOL}…`);

    const toolCallId = await waitApproval(150_000);
    if (toolCallId === undefined) {
      log("前提未成立（模型没调用该工具），跳过往返断言——模型侧服从是概率事件，不算产品缺陷");
      return;
    }

    const request = sessionManager.approvals
      .listPending(sessionId)
      .find((item) => item.toolCallId === toolCallId);
    checks.push([
      `模型真的调用了该工具：待审队列出现 ${MCP_TOOL}`,
      request !== undefined && request.toolName === MCP_TOOL,
    ]);
    checks.push([
      "调用进了审批闸门：未知 MCP 工具是「弹卡等人批」，不是静默放行/直接拒绝",
      request !== undefined && request.risk === "moderate" && request.reason.trim() !== "",
    ]);
    if (request !== undefined) {
      log(`  审批请求：toolName=${request.toolName}，summary=${request.summary}`);
      log(`  risk=${request.risk}，依据=${request.reason}`);
    }

    // 亲眼确认：把卡片当前的样子截下来（派生伴生产物，落 out/，与主产物同名加后缀）
    if (activeOutputPath !== "") {
      try {
        const cardImage = await window.capturePage();
        const cardPath = `${activeOutputPath.replace(/\.png$/, "")}-card.png`;
        writeFileSync(cardPath, cardImage.toPNG());
        log(`  审批卡截图：${cardPath}`);
      } catch (error) {
        log(`  审批卡截图失败（不影响结论）：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 渲染侧：卡真的画出来了，且点得到「允许一次」——批准走真实 UI 路径（同 mcp-e2e）
    const card = await run<string>(`(() => {
      const btns = [...document.querySelectorAll("button")].filter(
        (b) => b.textContent !== null && b.textContent.includes("允许一次"),
      );
      if (btns.length !== 1) return "buttons:" + btns.length;
      const btn = btns[0];
      const rect = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit === null || !btn.contains(hit)) return "not-hittable";
      btn.click();
      return "clicked";
    })()`);
    log(`  审批卡：${card}`);
    await sleep(500);
    checks.push([
      "点「允许一次」后待审清空（批准真的到了闸门）",
      card === "clicked" && sessionManager.approvals.listPending(sessionId).length === 0,
    ]);

    const result = await waitToolResult(toolCallId, 120_000);
    checks.push([
      "MCP 结果作为工具结果回到模型（第三方 server 真实 stdio 往返）",
      result !== undefined && result.isError === false,
    ]);
    if (result !== undefined) log(`  工具结果：${result.output.slice(0, 200)}`);

    const proof = scenario.diskProof?.({ nonce, workDir });
    if (proof !== undefined) {
      checks.push(proof);
      if (proof[1]) log(`  磁盘物证：已确认`);
    }

    // 收尾是 best-effort：本地小模型拿到结果后可能长时间啰嗦，超时不当作失败
    let settled: ConversationView | undefined;
    try {
      settled = await waitSettled(before, 240_000);
    } catch {
      log("等待本轮收尾超时（本地小模型慢）——MCP 往返已完成，跳过收尾断言");
    }
    if (settled !== undefined) {
      const lastText = ((): string => {
        for (let i = settled.messages.length - 1; i >= 0; i -= 1) {
          const m = settled.messages[i]!;
          if (m.role === "assistant" && m.text.trim() !== "") return m.text;
        }
        return "";
      })();
      log(`模型最终回复：${lastText.slice(0, 200)}`);
      checks.push([
        "模型接着往下做了（本轮 completed 且给出了新的助手消息）",
        settled.lastRun?.status === "completed" && lastText !== "",
      ]);
    }
    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    try {
      await run(`window.colt.invoke("session.close", ${JSON.stringify({ sessionId })})`);
    } catch (error) {
      log(`关闭会话失败（无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[mcp-real] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
