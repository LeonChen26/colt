/**
 * 冒烟模式：memory
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { upsertProject, createSession, listSessionFileChanges } from "../../../main/db/repo";
import { hostBridge } from "../../../main/host";
import { sessionManager } from "../../../main/session-manager";
import { normalizeRootKey } from "../../../main/db/index";
import { indexMemorySnapshot, isFts5Available, openMemoryDatabase, searchMemory } from "../../../main/db/memory-index";
import type { MemoryHit } from "../../../main/db/memory-index";
import { listProviders } from "../../../main/providers";
import { hasUsableProvider } from "@shared/model-ref";
import { join } from "node:path";
import type { ConversationView } from "@shared/worker-protocol";
import { sleep, uncaughtErrors } from "../context";

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
export async function runMemory(
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-memory-fixture");
  const memoryPath = join(fixtureDir, ".colt", "memory.md");
  const fixtureKey = normalizeRootKey(fixtureDir);
  mkdirSync(join(fixtureDir, ".colt"), { recursive: true });
  const fixtureEntries = [
    "部署流程：先 pnpm build，再 pnpm dist",
    "约定：汇报用中文",
    "冒烟夹具说明：本目录仅用于记忆链路验证",
  ];
  writeFileSync(memoryPath, `# 项目记忆（冒烟夹具）\n\n${fixtureEntries.join("\n")}\n`, "utf8");
  log(`夹具记忆：${memoryPath}`);
  log(`FTS5 可用：${isFts5Available()}（false 时全部走 LIKE 兜底，断言两种情况都成立）`);

  // 对照项目：往库里塞一条**别的项目**的记忆，证明「检索不到它」是隔离层强制，
  // 而不是「库里恰好没有」。跑完删掉（派生库，残留一行无害，但能删就删干净）。
  const foreignKey = normalizeRootKey(join(fixtureDir, "对照项目"));
  indexMemorySnapshot({
    scope: "project",
    projectKey: foreignKey,
    sourcePath: join(fixtureDir, "对照项目", ".colt", "memory.md"),
    sessionId: "smoke-memory",
    content: "另一个项目的私有部署密钥：never-match-smoke",
  });

  const checks: [string, boolean][] = [];
  // 会话建在**夹具自己的项目**下，这是绕开两条渲染层竞态的关键：
  // ① App 挂载时会自动选中「当前项目」的 list[0] 并以项目 rootPath 为 cwd 打开——
  //    若会话挂在仓库项目下且恰逢列表响应晚于建会话，渲染层会抢先打开我们的会话，
  //    于是真正 fork 的是**它**那条（cwd = 仓库根），把我们要验的夹具 cwd 顶掉。
  //    （原注释还记了一条「Conversation 卸载即 session.close 会把就绪前的 worker 杀掉」：
  //    2026-09-18 起渲染层不再在卸载时关 worker，那条已不成立，但**结论不变**。）
  // ② worker 复用分支只同步模型、不校验 cwd——先到者定 cwd，后来者被静默忽略。
  // 夹具项目下渲染层要么不来看（当前项目是仓库），要么来看时 cwd 恰好也是夹具目录：
  // 无论哪种时序，所有 fork 的 cwd 都正确。
  const fixtureProject = upsertProject(fixtureDir);
  // 渲染层初始 activeProject = project.list[0]（最近打开优先，App.tsx 挂载时选定）。
  // 夹具项目刚被 upsert 刷新了「最近打开」，会把渲染层引到夹具项目上——它便自动打开
  // 我们刚建的会话，抢在我们前面用仓库根把它打开。把仓库项目顶回 list[0]，
  // 渲染层就去忙它自己的旧会话，不再碰这个会话。
  upsertProject(process.env.COLT_SMOKE_CWD ?? process.cwd());
  const session = createSession(
    fixtureProject.id,
    join(app.getPath("userData"), "sessions", fixtureProject.id),
  );
  log(`会话：${session.id}（项目：${fixtureProject.name}）`);

  try {
    await run(
      `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: session.id, cwd: fixtureDir })})`,
    );

    // worker 启动即上报（不等模型发话），落库是异步的：轮询到出现为止
    let firstHit: MemoryHit | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      firstHit = searchMemory({ projectKey: fixtureKey, query: "部署流程" }).find(
        (hit) => hit.content === fixtureEntries[0],
      );
      if (firstHit) break;
      await sleep(500);
    }
    checks.push(["worker 启动即上报项目记忆并落库（真实跨进程链路）", firstHit !== undefined]);
    if (firstHit) {
      checks.push(
        [
          "入库行字段正确（scope/status/sourcePath）",
          firstHit.scope === "project" &&
            firstHit.status === "active" &&
            firstHit.sourcePath === memoryPath,
        ],
      );
    }

    // 查询两条路都要通：≥3 字走 FTS（或降级 LIKE），二字词恒走 LIKE（trigram 3 字下限）
    const twoChar = searchMemory({ projectKey: fixtureKey, query: "约定" });
    checks.push(["二字词走 LIKE 兜底命中", twoChar.some((hit) => hit.content === fixtureEntries[1])]);
    const latin = searchMemory({ projectKey: fixtureKey, query: "pnpm" });
    checks.push(["拉丁词查询命中", latin.some((hit) => hit.content === fixtureEntries[0])]);

    // 能力路由：与 worker 的 memory_search 同一条 hostBridge 通道
    const viaHost = await hostBridge.handle({
      sessionId: session.id,
      capability: "memory",
      action: "search",
      params: { query: "部署流程" },
    });
    log(`memory.search：${viaHost.text.split("\n")[0]}`);
    checks.push([
      "hostBridge memory 检索命中且格式带「项目·现行」",
      viaHost.text.includes("项目·现行") && viaHost.text.includes(fixtureEntries[0]),
    ]);
    const miss = await hostBridge.handle({
      sessionId: session.id,
      capability: "memory",
      action: "search",
      params: { query: "绝不匹配的词组xyz" },
    });
    checks.push(["无匹配时给「没有匹配」文案", miss.text.startsWith("没有匹配")]);

    // 项目隔离：对照条目在库里（换个 projectKey 直查能见到），hostBridge 检索却看不见
    const foreignDirect = searchMemory({ projectKey: foreignKey, query: "私有部署密钥" });
    checks.push(["对照项目条目确实在库里（隔离不是空库巧合）", foreignDirect.length === 1]);
    const foreignViaHost = await hostBridge.handle({
      sessionId: session.id,
      capability: "memory",
      action: "search",
      params: { query: "私有部署密钥" },
    });
    checks.push([
      "项目隔离：hostBridge 检索看不到其它项目条目",
      !foreignViaHost.text.includes("never-match-smoke"),
    ]);

    // 关会话：worker 没了，记忆检索上下文必须一起清（否则残留 cwd 继续放行检索）
    const closed = await run<unknown>(
      `window.colt.invoke("session.close", ${JSON.stringify({ sessionId: session.id })})`,
    );
    checks.push(["session.close 成功", JSON.stringify(closed).includes('"closed":true')]);
    await sleep(500);
    const afterClose = await hostBridge
      .handle({
        sessionId: session.id,
        capability: "memory",
        action: "search",
        params: { query: "部署" },
      })
      .then(
        () => "仍然可检索",
        (error: unknown) => `已拒绝：${error instanceof Error ? error.message : String(error)}`,
      );
    log(`关闭后检索：${afterClose}`);
    checks.push(["关闭后记忆上下文已清（检索被拒）", afterClose.startsWith("已拒绝")]);
    checks.push(["关闭会话未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    // 先出结论再清理：删掉对照条目；夹具条目留给下一轮 upsert（同身份幂等覆盖）
    try {
      openMemoryDatabase(app.getPath("userData"))
        .prepare("DELETE FROM memory_entries WHERE project_key = ?")
        .run(foreignKey);
    } catch (error) {
      log(`清理对照条目失败（派生库，无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[memory] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}

/**
 * 记忆端到端（真实调用）——唯一打模型的记忆验证。
 *
 * 免费的 `memory` 模式只验「跨进程链路」（worker→索引→检索），全是结构性断言；
 * 本模式验的是**行为质量**：注入真的让模型「知道」、沉淀真的写对文件并进索引、
 * /memory-tidy 真的合并重复并删过时、被清理的条目真的能从冷层找回。
 * 共四次真实模型调用，**计费**——模式名带 e2e，跑之前想清楚。
 *
 * 夹具预置 5 条记忆：1 条注入探针（密语）+ 2 条语义重复（pnpm）+ 1 条自相矛盾的
 * 过时条目（往一台「已停用删除」的服务器上做每日部署）+ 1 条有效条目。刻意把
 * 「该合并」「该删除」设计成几乎无歧义的形态，把模型非确定性造成的假红降到最低；
 * 偶发不达标时先看落盘文件与回答日志（全量进 log），再定性是用例歧义还是产品缺陷。
 */
export async function runMemoryE2e(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-memory-e2e-fixture");
  const memoryPath = join(fixtureDir, ".colt", "memory.md");
  const fixtureKey = normalizeRootKey(fixtureDir);
  mkdirSync(join(fixtureDir, ".colt"), { recursive: true });
  const secretEntry = "项目密语是「菠萝披萨」（用于验证注入，勿删）";
  const keepEntry = "代码注释用中文";
  const duplicateA = "包管理器用 pnpm，不要用 npm";
  const duplicateB = "包管理器固定用 pnpm（工程约定）";
  const staleEntry =
    "部署方式：每天手工 FTP 上传到 old-server.example（该服务器已于 2025-01 停用删除）";
  writeFileSync(
    memoryPath,
    `# 项目记忆（记忆端到端夹具）\n\n${[secretEntry, duplicateA, duplicateB, staleEntry, keepEntry].join("\n")}\n`,
    "utf8",
  );
  log(`夹具记忆：${memoryPath}`);

  const checks: [string, boolean][] = [];
  const fixtureProject = upsertProject(fixtureDir);
  // ⚠️ 刻意**不**把仓库项目顶回 list[0]（与免费 memory 模式相反）：本模式需要渲染层
  // 把这个会话显示出来——/memory-tidy 从输入框走的是「当前会话」，textarea 属于
  // 渲染层自己的 activeSession。夹具项目刚刷新了「最近打开」+ 会话是项目内最新，
  // App 挂载自动打开的就是它，cwd = 项目 rootPath = 夹具目录，恰好正确。
  // StrictMode 的挂载→卸载→重挂载会杀一次就绪前的 worker，重挂载会重新打开——
  // 没有第二个人跟它抢，让它自己收敛即可（免费模式的教训只在不该有人抢时成立）。
  const session = createSession(
    fixtureProject.id,
    join(app.getPath("userData"), "sessions", fixtureProject.id),
  );
  log(`会话：${session.id}（项目：${fixtureProject.name}）`);

  /** 主进程直读视图：不绕渲染层 invoke（那条路慢，还受界面状态影响） */
  const getView = (): ConversationView | undefined => sessionManager.getView(session.id);

  /** 等一轮运行落定。判据：不在运行中，且（终态异常 或 出现了本轮的新助手消息）——
   *  只看 running=false 会把「上一轮已结束」的瞬时状态误判成本轮完成。 */
  const waitRunSettled = async (before: number, timeoutMs: number): Promise<ConversationView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = getView();
      if (view && !view.running) {
        const failed = view.lastRun !== null && view.lastRun.status !== "completed";
        const answered =
          view.messages.length > before &&
          view.messages.some((m, i) => i >= before && m.role === "assistant");
        if (failed || answered) {
          if (failed) {
            log(
              `运行终态异常：${view.lastRun?.status}${view.lastRun?.error ? `（${view.lastRun.error}）` : ""}`,
            );
          }
          return view;
        }
      }
      if (Date.now() > deadline) throw new Error("等待运行结束超时");
      await sleep(2000);
    }
  };

  /** 从视图取最后一条助手回答 */
  const lastAnswer = (view: ConversationView): string => {
    for (let i = view.messages.length - 1; i >= 0; i -= 1) {
      const m = view.messages[i]!;
      if (m.role === "assistant") return m.text;
    }
    return "";
  };

  /** 发一轮真实 prompt（走 IPC 与用户同一条路）并等它落定，返回视图与回答 */
  const askAndSettle = async (text: string, timeoutMs = 180_000) => {
    const before = getView()?.messages.length ?? 0;
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text })})`,
    );
    const view = await waitRunSettled(before, timeoutMs);
    return { view, before, answer: lastAnswer(view) };
  };

  const readMemory = (): string => readFileSync(memoryPath, "utf8");
  const pollFile = async (
    predicate: (text: string) => boolean,
    timeoutMs: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate(readMemory())) return true;
      if (Date.now() > deadline) return false;
      await sleep(2000);
    }
  };
  const pollIndex = async (
    predicate: () => boolean,
    timeoutMs: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      if (Date.now() > deadline) return false;
      await sleep(2000);
    }
  };

  /** 把文本敲进输入框并回车（React 受控组件须用原生 setter；同 dock 段的形态） */
  const typeAndEnter = (text: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", bubbles: true, cancelable: true,
      }));
      return true;
    })()`);

  try {
    // 前置检查：没有可用模型时显式失败——真实调用验证不该静默跑成一场空
    if (!hasUsableProvider(listProviders())) {
      checks.push(["前置：存在已配密钥的模型服务（没有就无法真实调用）", false]);
      log("没有已配密钥的模型服务。请先在设置里配好一个服务再跑本模式。");
      return;
    }
    checks.push(["前置：存在已配密钥的模型服务", true]);

    window.reload();
    await sleep(4000);
    // 等渲染层自动打开夹具会话、worker 就绪（视图出现即就绪）
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

    // 整理与沉淀都要写记忆文件：夹具会话切 full-access，写路径不被审批卡住。
    // 审批模式是会话级的，只影响这个夹具会话，不碰用户其它会话。
    await run(
      `window.colt.invoke("approval.mode.set", ${JSON.stringify({ sessionId: session.id, mode: "full-access" })})`,
    );

    // ---- TC-A 注入可见性（1 次调用）----
    // 明令禁止工具：模型若读文件就不是「注入生效」的证据，所以工具动用单独断言。
    const tcA = await askAndSettle(
      "测试开始。不要调用任何工具、不要读取任何文件，直接凭你上下文里已有的信息回答：本项目记忆里记的「项目密语」是什么？只回答密语本身。",
    );
    const usedToolsInA = tcA.view.messages.some(
      (m, i) => i >= tcA.before && m.role === "assistant" && m.toolCalls.length > 0,
    );
    log(`TC-A 回答：${tcA.answer}`);
    checks.push(["TC-A 注入：模型没有动用工具（否则注入未被证明）", !usedToolsInA]);
    checks.push(["TC-A 注入：不读文件也答出了记忆里的密语", tcA.answer.includes("菠萝披萨")]);

    // ---- TC-B 沉淀落盘 + 索引同步（1 次调用）----
    const tcB = await askAndSettle(
      "请把这条事实沉淀进项目记忆（.colt/memory.md）：冒烟夹具站的端口固定是 0（SMOKE_PORT_ZERO）。完成后告诉我写好了。",
    );
    log(`TC-B 回答：${tcB.answer}`);
    const sedimented = await pollFile((text) => text.includes("SMOKE_PORT_ZERO"), 60_000);
    checks.push(["TC-B 沉淀：事实真的写进了记忆文件", sedimented]);
    const indexed = await pollIndex(
      () =>
        searchMemory({ projectKey: fixtureKey, query: "SMOKE_PORT_ZERO" }).some(
          (h) => h.status === "active",
        ),
      30_000,
    );
    checks.push(["TC-B 索引同步：新条目可被 memory_search 检索到", indexed]);

    // ---- TC-C 整理（1 次调用，走渲染层输入框——产品真实入口）----
    // 整理跑在子 lane，主视图 running 恒为 false：以**文件落盘**为完成信号，
    // 同时并行盯两类瞬时 DOM（完成通知 / 可见报错），谁先出现都提前收敛。
    let tidyNotice: string | null = null;
    let tidyError: string | null = null;
    const domWatcher = (async () => {
      const deadline = Date.now() + 280_000;
      while (Date.now() < deadline && tidyNotice === null && tidyError === null) {
        const notice = await run<string | null>(
          `(() => { const el = document.querySelector("[data-conv-compact-notice]"); return el ? el.textContent : null; })()`,
        ).catch(() => null);
        if (notice !== null && notice.includes("记忆整理完成")) {
          tidyNotice = notice;
          break;
        }
        const error = await run<string | null>(
          `(() => { const el = document.querySelector("[data-conv-error]"); return el ? el.textContent : null; })()`,
        ).catch(() => null);
        if (error !== null && error.includes("记忆整理")) {
          tidyError = error;
          break;
        }
        await sleep(500);
      }
    })();
    await typeAndEnter("/memory-tidy");
    const tidyOk = await pollFile((text) => {
      const pnpmLines = text.split("\n").filter((l) => l.includes("pnpm"));
      return (
        pnpmLines.length <= 1 &&
        !text.includes("old-server") &&
        text.includes("菠萝披萨") &&
        text.includes(keepEntry)
      );
    }, 240_000);
    await domWatcher;
    checks.push([
      "TC-C 整理：重复合并（pnpm 2→1）、过时删除（old-server）、有效保留（密语/注释）",
      tidyOk,
    ]);
    log(`整理后的记忆文件：\n${readMemory()}`);
    checks.push([
      "TC-C 完成通知出现在界面（子 lane 不可见，通知是唯一结果出口）",
      tidyNotice !== null,
    ]);
    if (tidyError !== null) log(`整理的可见报错：${tidyError}`);
    // 索引口径：被清理的条目就地归档，冷层仍可检索
    const archived = await pollIndex(
      () =>
        searchMemory({ projectKey: fixtureKey, query: "old-server" }).some(
          (h) => h.status === "archived",
        ),
      30_000,
    );
    checks.push(["TC-C 冷层归档：被删条目 archived 且仍可检索", archived]);
    // 改动记录口径：对记忆文件的改写如实落库（SECURITY.md「整理面」的承诺）
    const tidyChanges = listSessionFileChanges(session.id).filter((c) =>
      c.path.replace(/\\/g, "/").endsWith(".colt/memory.md"),
    );
    checks.push([
      "TC-C 改动记录：记忆文件的改写进了会话的文件改动（诚实报告）",
      tidyChanges.length > 0,
    ]);

    // ---- TC-D 冷层检索（1 次调用）----
    // 现行文件此时已无部署条目（TC-C 验过）：答出 old-server 的唯一来源是冷层。
    const tcD = await askAndSettle(
      "不要读取记忆文件。用 memory_search 工具查一下「部署」，告诉我：这个项目以前的部署方式在记忆原文里是怎么写的？引用原文回答。",
    );
    log(`TC-D 回答：${tcD.answer}`);
    checks.push([
      "TC-D 冷层检索：现行已删的条目仍能被 memory_search 答出",
      tcD.answer.includes("old-server"),
    ]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    // 先出结论再清理：夹具条目按 project_key 整段删除（派生库，可随时重建）；
    // 会话行留在库里，与其它冒烟模式一致
    try {
      openMemoryDatabase(app.getPath("userData"))
        .prepare("DELETE FROM memory_entries WHERE project_key = ?")
        .run(fixtureKey);
    } catch (error) {
      log(`清理夹具条目失败（派生库，无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[memory-e2e] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}

/**
 * 切会话回挂冒烟：复现「运行中的会话切走再切回后卡在『正在启动会话进程…』」。
 * 步骤：建长任务会话 → 让它跑起来 → 切到另一个会话 → 再切回来 →
 * 轮询界面上的启动提示是否在合理时间内消失。
 */
