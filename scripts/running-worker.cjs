/**
 * 诊断用的假 worker：「一个一直在跑的会话」，不加载内核、不发任何网络请求。
 *
 * 为什么需要它：`sessionManager.isRunning()` 的唯一真源是 worker 发来的 `view.running`
 * （见 `src/main/session-manager.ts` 的 `case "view"`），没有任何公开钩子能直接置位。
 * 要验「运行中的会话让整次工作区移除被拒绝」这条守卫，就得有一个**不自己跑完**的会话；
 * 而让真 worker 跑起来意味着真调模型（计费 + 依赖这台机器上恰好配了可用密钥）。
 *
 * ## 只伺候「自己人」：cwd 不含标记的会话一律不碰
 *
 * 渲染层挂载时会**自动打开当前项目的第一条会话**，那条很可能是**用户的真实会话**——
 * 只要它成功 fork 到本脚本，下面两件事就会往用户数据里写假东西：
 *   · `ready` → 主进程 `setKernelSessionId(sessionId, 假的 kernelId)`：那条会话之后按
 *     这个名字去找 JSONL 历史会找不到；
 *   · `view`  → 主进程 `touchSession(sessionId, 消息数, 首条用户消息前 30 字)`：
 *     真实会话的标题与消息数被冒烟占位文本覆写。
 * 所以本脚本只认 cwd 里带 `MARKER` 的会话（都是用例自己造的靶子）；别的会话
 * **一条消息都不发、直接退出**——主进程随即失败（而不是干等就绪超时），全程零写入。
 *
 * 与真 worker 走同一条消息通道（`process.parentPort`），时序：
 *   init（cwd 含标记）→ ready（自造 kernelSessionId）+ view(running: true)
 *   init（cwd 不含标记）→ 立刻 exit(0)
 *   abort → view(running: false)      ← 用例据此在同一条会话上接着验「跑完就能删」
 *
 * 仅供诊断冒烟使用：`COLT_WORKER_OVERRIDE` 指向它，且该变量只在 isDev 下生效
 * （见 session-manager 的 `#spawnWorker`）。
 */
const MARKER = "smoke-rm-workspace";

let externalSessionId = "fake-session";
const kernelSessionId = `fake-kernel-${Date.now()}`;

function send(message) {
  process.parentPort?.postMessage(message);
}

/** 与 `ConversationView` 同形（`modes/dock.ts` 的 viewBase 是同一份形状） */
function makeView(running) {
  return {
    sessionId: externalSessionId,
    model: "smoke-rm-workspace-fake/fake-model",
    imageInput: false,
    thinkingLevel: "high",
    skills: [],
    subagents: [],
    // 首条用户消息会被主进程用作会话标题，用例据此断言「报错点明了是哪一条」
    messages: [
      {
        id: "fake-msg-1",
        role: "user",
        text: "冒烟占位：这条会话一直在跑",
        toolCalls: [],
      },
    ],
    toolResults: [],
    todos: [],
    fileChanges: [],
    streamingText: null,
    thought: null,
    runningTools: [],
    running,
    lastRun: null,
    queuedCount: 0,
    stats: {
      messageCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      contextUsed: 0,
    },
  };
}

process.parentPort?.on("message", (event) => {
  const command = event.data;
  if (command?.type === "init") {
    // 不属于本用例的会话：什么都不发就退出（理由见文件头）
    if (!String(command.cwd ?? "").includes(MARKER)) {
      process.exit(0);
    }
    externalSessionId = command.externalSessionId ?? externalSessionId;
    send({
      type: "ready",
      externalSessionId,
      kernelSessionId,
      cwd: command.cwd ?? process.cwd(),
      model: "smoke-rm-workspace-fake/fake-model",
    });
    // 关键：就绪之后立刻声明「我在跑」——主进程侧 isRunning() 从此为真
    send({ type: "view", view: makeView(true) });
    return;
  }
  // 用例要求「跑完了」：这样同一条会话上还能接着验「跑完之后删得掉」
  if (command?.type === "abort") {
    send({ type: "view", view: makeView(false) });
    return;
  }
  if (command?.type === "dispose") process.exit(0);
});
