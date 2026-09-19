# 架构

> **什么时候读这份**：跨进程改动、加 IPC 通道、加 worker 命令、加右栏视图、加表字段、**升级 pi 依赖**——**动手之前**。
> 这些改动的共同点是**要同时改几处**，漏一处不会编译报错，只会在运行期静默失灵。

---

## 一、四个进程与各自边界

```
┌─────────────────────────────────────────────────────────────┐
│ main（Electron 主进程）                                      │
│  · 窗口 / 原生视图（WebContentsView）  · SQLite              │
│  · IPC 路由（渲染层所有调用的落点）    · 审批闸门             │
│  · 宿主能力（浏览器 / 电脑控制）       · worker 进程池        │
└───────────────┬──────────────────────────────┬──────────────┘
                │ IPC（invoke / event）        │ 消息（WorkerCommand / WorkerMessage）
┌───────────────┴──────┐              ┌────────┴──────────────┐
│ preload              │              │ worker（每会话一个）    │
│  按通道名白名单桥接   │              │  · 持内核 harness/lane │
└───────────────┬──────┘              │  · 跑工具、读文件、bash │
                │                     │  · 投影 ConversationView│
┌───────────────┴──────┐              └───────────────────────┘
│ renderer（React）    │   ← 只能通过 window.colt.invoke/on 说话
└──────────────────────┘
```

| 进程 | 职责 | **不做**什么 |
|---|---|---|
| **main** | 窗口、原生视图、DB、IPC 路由、审批、宿主能力、worker 池 | 不直接调模型（内核在 worker 里）；不渲染界面 |
| **preload** | 按 `IPC_CHANNELS` / `IPC_EVENTS` 白名单暴露 `window.colt.invoke/on` | 不含任何业务逻辑 |
| **renderer** | 界面、纯前端状态、纯函数计算（`lib/`） | 不碰 fs、不碰密钥、不直接连模型 |
| **worker** | 每会话一个 `utilityProcess`：持内核、跑工具、投影视图 | **不碰窗口与 OS 权限**——那两样在主进程，只能走 `toolRpc` 请主进程代做 |

**为什么每会话一个进程**：长历史会话重放、工具执行、bash 都可能卡住或崩溃；隔离到进程后，一个会话卡死不拖累其它会话，崩溃也只丢一个会话的运行时状态（会话数据在磁盘）。

**为什么窗口能力必须在主进程**：`WebContentsView`、`desktopCapturer`、系统剪贴板都要求 Electron GUI 侧。worker 里的工具（`worker/lib/browser-tool.ts`、`computer-tool.ts`）只是**薄封装**，实质是把请求发给主进程再等回。

---

## 二、一次对话的往返

```
① ⑤ 输入区发送
      └─ window.colt.invoke("session.prompt") → preload → main/ipc
② main 查密钥、必要时拉起 worker（池内没有则开），下发 prompt
③ worker 把 prompt 交给内核 lane → 模型流式返回
④ 工具调用发生，按类型分两路：
      ├─ 内核侧工具（读文件 / bash …）→ 在 worker 里执行
      └─ 宿主能力（浏览器 / 电脑控制）→ toolRpc 反向上行 → main → 原生视图 → 结果回传
      └─ ⚠️ **两种情况都先过审批闸门**：worker 阻塞在 before_tool，
         发 approvalRequest → main 的审批中枢判定（放行 / 上报用户）→ 用户处置 → 回传
⑤ 事件流（文本 / 思考 / 工具状态 / 用量）持续从 worker 上报
      └─ worker/lib/project.ts 投影成 ConversationView
      └─ worker/lib/telemetry.ts 转成 usage / toolCall 上报
⑥ main 侧落库：usage / toolCalls / fileChanges / 净值，然后 `session.view` 推给渲染层
⑦ 渲染层重渲染
```

三个容易记错的点：

- **DB 是 main 写的**，不是 worker。worker 只**上报**（`usage` / `toolCall` / `fileChange`），main 收到后落库，再把加工过的视图推回渲染层（`session-manager.ts` 的 `#withDbChanges`）。
- **净值在主进程算**：**基线**由 worker 在改动前抓（`worker/lib/baseline.ts`，挂在 `before_tool`），**当前内容与 diff** 由 main 算（`main/net-change.ts` + 纯函数 `shared/line-diff.ts`）。
- **`ConversationView` 是「全量快照 + 全量重推」**，不是增量：流式期间 `scheduleFlush` 每 50ms 把**整份**视图重新投影、重新序列化、重新发一遍（`worker/entry.ts`）。
  所以**任何大 payload 放进视图，代价都要乘上「被推了几次」**——一轮几十分钟的运行里，同一张截图会被搬几十上百次。
  带图的工具结果因此在视图里只留 `hasImage`：图片由 worker 落盘一次（`worker/lib/tool-image-spill.ts`），
  卡片展开时才用 `session.toolOutput` 从主进程读回（命名与校验见 `shared/tool-output.ts`、读取见 `main/tool-output.ts`）。
  往视图里加新字段前先问一句：**它会不会很大、以及会不会每 50ms 重发一次？**
  同一个「重推」在**渲染层**还有第二个后果：每次推送都新建 `messages` / `toolResults` / `fileChanges`
  三个数组，**每个元素都是新对象**——哪怕内容没变。所以渲染层拿到视图后先过一遍「稳定投影」
  （纯函数 `renderer/src/lib/stable-view.ts`，挂在 `Conversation/use-stableView.ts`），
  把没变的部分换回旧引用，`MessageBubble` 的 `memo` 才生效。少了这层，剪掉的只是**传输**成本，
  重渲染成本一点没少（实测 370 条消息时每帧 566ms → 加这层后 53ms，且不再随历史长度增长）。
  另一半是**挂载**成本：引用再稳，一次把几千条消息都挂成 DOM 仍要几百毫秒到几秒（实测 370 条
  单次挂载 563ms、800 条 1107ms；而真实库里最长的会话有 **2937** 条可渲染消息）。
  所以消息列表走**窗口**：只挂最近一段（算术在纯函数 `renderer/src/lib/message-window.ts`，
  组件是 `Conversation/MessageList.tsx` 的 `MessageWindow`），更早的按「载入更早」或滚到顶再补一段。
  两条行为是刻意定的：**没显式展开时窗口锚在最新**（流式追加跟着走），**展开后锚点固定**
  （新消息只把尾部加长，不挤掉用户正在读的那几行）；顶上补进来的高度由 `useLayoutEffect` 补偿回
  滚动位置。挂载数因此与历史长度脱钩：800 条实测最长帧 1107ms → 129ms。
  窗口还有第三档**浮动段**：从会话目录跳到某一轮时只挂目标那一小段（上下各能翻页），
  而不是「从目标一直挂到末尾」——后者会把几千条一次挂出来，等于把窗口作废。
  翻到底会自动交回「跟随底部」，否则新消息落在窗口外、界面看着像卡住了；「回到最新」同理。

---

## 三、契约只有一个真源

跨进程的东西**只允许定义一次**，其余全部由编译期断言强制对齐。

| 契约 | 真源 | 强制方式 |
|---|---|---|
| 渲染层 → 主进程 | `src/shared/protocol.ts` 的 `IPC_CHANNELS` + `IpcInvokeMap`（类型） | 两者的**双向编译期断言**；`preload` 的白名单同源；**注册 ↔ 声明的双向相等**由 `tests/contract.test.ts` 守卫 |
| 主进程 → 渲染层（推送） | 同文件的 `IPC_EVENTS` + `IpcEventMap` | 同上；**发送点 ↔ 声明的双向相等**同上 |
| main ↔ worker | `src/shared/worker-protocol.ts` 的 `WorkerCommand` / `WorkerMessage` / `ConversationView` | 类型联合 + 穷尽 switch |

> **不要再在文档里写「N 条 / N 个」**：这类数字会随增删漂移，而漂移没有守卫能发现（2026-09 实测：文档写 48、实际 49；删 3 个死通道后又变成 46）。
> 要看条数就跑测试或读真源。
| 只读工具名单 | `src/shared/readonly-tools.ts`（**唯一真源**） | 被审批策略与「未经闸门即执行」告警共同消费——两份漂移会**要么刷假告警、要么遮蔽真漏报** |

**这条纪律的价值**：加一个通道时，编译器会替你找出所有没改的地方。所以**不要绕过它**——不要在渲染层拼通道名字符串，也不要在 worker 里读主进程的私有类型。

> **给既有推送 payload 加字段**（如 v1.39 给 `BrowserViewState` 加 `contentWidth`、v1.40 再加 `zoom`）也走这里：
> 只改 `IpcEventMap` 顶层的类型定义，字段**设成必填而非可选**——必填会让编译器把每一个构造点
> 都指出来（本仓是 `browser-host.ts` 的 `stateOf` 与 `#emitState` 两处）；设成可选就全部漏过去，
> 留一批「有时是 `undefined`」的推送在线上。跨进程的字段**宁可要求每处都显式给值**。

---

## 四、与 pi 内核的边界（升级依赖前必读）

worker 里跑的是 pi 的内核（`@earendil-works/pi-agent-core` / `pi-ai`）。**我们对它只有 11 处 import**，
且全部走 pi 在 `package.json` 的 `exports` 里声明的公开入口——没有一处 import `dist/` 下的内部模块，
也没有 `patches/` / `overrides` / vendoring。这条「零补丁」是升级能一直是「改版本号 + 跑测试」的前提，**不要破坏它**。

| 用到的内核能力 | 公开入口 | 我们的用法 |
|---|---|---|
| 工具集 | `createBashTool` / `createEditTool` / `createReadTool` / `createWriteTool` | `worker/entry.ts` 组装 lane 工具集 |
| 自定义工具 | `AgentHarnessTool` / `ExecutionToolContext`（类型） | `worker/lib/browser-tool.ts`、`computer-tool.ts` |
| 钩子 | `harness.hooks.on("before_tool" / "after_tool" / "transform_context")` | 审批闸门、净值基线抓取、浏览器变更提示注入（`entry.ts:426-474`） |
| 事件 | `harness.events.on("usage" / "tool_start" / "tool_end")` | 用量与工具状态上报 |
| 会话持久化 | `JsonlSessionRepo` | **格式归 pi**；我们只在自己的库里存 `kernel_session_id` 做映射 |
| 状态归约 | `reduceLaneSnapshot` + `LaneSnapshot` | 投影成我们自己的 `ConversationView` |
| 模型 / provider | `createModels` / `createProvider` / `envApiKeyAuth` / `lazyApi` + `pi-ai/providers/*` + `pi-ai/api/*` | `shared/provider-factory.ts`、`main/providers.ts`、`main/approval/analyzer.ts` |
| 执行环境 | `pi-agent-core/node` 的 `NodeExecutionEnv` | worker 里的 bash / fs |
| 上下文 | `BACKGROUND_CONTEXT`（实为 `@earendil-works/chord/context` 经 pi 转出） | worker 的 `Context` |

**四条纪律**

1. **只走公开入口**——根导出，或 `exports` 里声明过的子路径（如 `pi-agent-core/node`、`pi-ai/providers/*`）。
   pi 没声明、但恰好能 import 到的路径也是内部，别用。
2. **pi 的类型只允许出现在 `worker/`**：`worker/lib/project.ts` 是唯一的投影出口，内核的数据结构在那里变成
   我们的 `ConversationView`；渲染层与主进程永远只认我们自己的类型。投影里还带一道**编译期哨兵**
   （`COVERED_BLOCK_TYPES`，键集由 pi 的 `Message["content"]` 派生）：pi 新增或改名内容块类型时它
   **编译不过**，逼我们在 `extract*` 里显式处理——否则新类型会被静默丢掉（`docs/ERRORS.md` 的「不许静默」）。
3. **字段语义以「定义与写入点」为准，不按名字猜**。本仓为此付过学费：`faulted` 名字看着像「任务失败」，
   实为 harness `fault` 事件的会话级硬故障、且从不复位（`AGENTS.md` §四）。
4. **不 fork、不打补丁**：`patches/` 与 `overrides` 保持为空。

**升级 pi 的清单**

1. 读 pi 的 release notes，先列出改了什么。
2. 改 `package.json` 的 pin（两个 pi 包 + `typebox`，理由见本节末）。
3. `npm install` → `npm run typecheck` → `npm test` → `npm run build`。
   **`typecheck` 这一步会替我们拦下内核新增的内容块类型**——见下面「纪律 2」的哨兵。
4. 冒烟：`COLT_SMOKE_MODE=fixture` + `COLT_SMOKE_MODE=dock`。
5. **逐项核对「我们用过的内核字段」**：`LaneSnapshot.lastResult`（`status` / `kind`）、会话条目的 `seq`、
   `thinkingLevel`、`Usage` 各字段、`JsonlSessionMetadata`。
6. 单独一个提交，消息里写明升到哪个版本、改了什么。

> 这三个包**全部精确 pin，不用 `^`**（与 pi 自己的做法一致：它把 `diff` / `typebox` / `yaml` / `ignore`
> 都钉死）。两条具体理由：① 0.x 的 `^0.85.1` 虽然只放开补丁位，但「谁跑一次 `npm update` 就静默升」
> 比看上去危险——升级应当是一个**动作**，不是一个**意外**；② **`typebox` 必须与 pi 完全同版**：
> 我们在 `browser-tool.ts` / `computer-tool.ts` 里用 `Type` 构造工具入参 schema 交给 pi 校验，
> 而 TypeBox schema 是**运行时对象**——一旦出现两份实例，校验分歧极难定位。

**已知的继承度缺口**（想「继承社区资产」时看这里，别以为已经接上了）

| 内核已提供 | 我们的状态 |
|---|---|
| `loadSkills` + `formatSkillsForSystemPrompt` | **已接**——`worker/lib/skills.ts` 扫 `.agents/skills`（项目级）与 `~/.agents/skills`（用户级），同名项目级胜出；装载**状态**随视图下发（`ConversationView.skills`，整份 `ViewSkill[]`，v1.53），只把**告警**当事件播报（信任口径见 `docs/SECURITY.md`）。**内核这里是两套机制、缺一不可**：`resources.skills` 只管「按名显式调用」（`lane.skill`，界面入口是输入框的 `/skill <名字>`，v1.42），让模型**看见**必须由应用把 `formatSkillsForSystemPrompt` 拼进系统提示词——**内核只导出这个函数、自己从不调用**，漏拼是**静默失败**（装载、告警、计数全都正常，只有模型不知道），故有 `composeSystemPrompt` 与专门用例守住 |
| `loadPromptTemplates` / `parseCommandArgs` / `substituteArgs` | **未接**——斜杠命令是自研的一版平行实现 |
| 遥测（`pi-telemetry`：`startHarnessSpan` / `defineTelemetrySchema`） | **未接**——自研 `worker/lib/telemetry.ts` |
| 存储一致性套件（`pi-agent-core/harness/session/testing`） | 未使用——可把「是否仍兼容」变成可执行检查 |
| 插件 / 组合运行时（`@earendil-works/chord`，**已在依赖树里**） | **未启用**——只用了它的 `BACKGROUND_CONTEXT` 一个符号 |

⚠️ 还有一条**没有版本锚点**的耦合：worker 的集成形态是照 pi 仓库里
`packages/coding-agent/src/experimental/mini/worker/run.ts` 抄的（`worker/entry.ts` 头注自己写着）。
`@earendil-works/coding-agent` 不是我们的依赖——拿不到它的版本号，也收不到变更通知，而那个路径还在
`experimental/` 下。**改动 worker 形态时记住这一点。**

**Pi 生态的「扩展宿主」给了什么、我们为什么不用**（2026-09 记）

`@juicesharp/rpiv-todo` 一类包（源码解包在 `.workbuddy/pi-ext-review/`）依赖的**不是** `pi-agent-core`，
而是另一个包 `pi-coding-agent`（+ `pi-tui`）。它把四样权力交给插件，**四样本仓一样都没有**：

| 宿主给的权力 | 扩展怎么用 | 本仓对应 |
|---|---|---|
| **加载权**：`package.json` 的 `pi.extensions` + jiti 直接加载 `.ts`，调用默认导出的 `(pi: ExtensionAPI) => void` | 包的入口就是那个函数 | ❌ **不自建扩展宿主**；能力**内建**进 `AgentHarness.create({ tools })`（`worker/entry.ts`） |
| **提示词组装权**：`registerTool` 的 `promptSnippet` / `promptGuidelines` | 模型「知道该用这个工具」靠宿主把这些字符串拼进系统提示词 | ❌ 内核 `AgentTool` 只有 `name / label / description / parameters / execute`（`pi-agent-core/dist/types.d.ts`）——引导只能写进 `description` 或 `composeSystemPrompt` |
| **TUI 渲染权**：`ctx.ui.setWidget(key, factory, { placement })`（`render(width) => string[]`）、`ui.custom` / `ui.notify` / `ui.onTerminalInput` | 面板、交互表单、键盘拦截 | ❌ 本仓是 React + 主进程原生视图；对应物是渲染层组件 + IPC 通道 |
| **会话生命周期**：`pi.on("session_start" / "session_compact" / "session_tree" / "session_shutdown")` | 重放状态、按前台 / 子会话分派、清理 | 🔸 内核**没有同名事件**；对应点要在 `session-manager` 与 worker 侧自己找 |

结论与 `NEXT-PHASE.md` §3.2「扩展宿主层：明确不做」互为印证：**装进来逻辑能跑、画不出东西**，等于死入口；
且扩展是**代码**，在 worker 内以完整权限运行，其副作用不是工具调用，天然躲开 `before_tool` 闸门。

⚠️ 但它有**半套机制本仓可以直接用**——因为它只吃内核既有能力、不经过扩展宿主：
**工具结果自带全量快照**（`AgentToolResult.details`）+ 从会话分支重放（`sessionManager.getBranch()`，
取最后一条匹配的 toolResult，last-write-wins）；`rpiv-todo` 靠这两条做到「不落盘也能在 `/reload`
与压缩后活下来」。⚠️ 该重放依赖「分支里还找得到最后一条快照」这个前提（pi 的压缩保不保留最近
toolResult，**未在本仓内核上验证**）；且本仓还多一条它没有的约束：**worker 会被空闲回收重启**。

---

## 五、新增能力要走哪几步

### A. 加一个 IPC 通道（渲染层 → 主进程）

1. `shared/protocol.ts`：`IPC_CHANNELS` 加通道名 + `IpcInvokeMap` 加 `request` / `response` 类型。
2. `main/ipc/index.ts`：`handle("通道名", …)` 落点。
3. 渲染层：`window.colt.invoke("通道名", …)`。
4. `preload` **不用改**（白名单从 `IPC_CHANNELS` 派生）。

要**推送**（主进程 → 渲染层）则改 `IPC_EVENTS` + `IpcEventMap`，main 侧发、渲染层 `on`。

### B. 加一个 worker 命令

`shared/worker-protocol.ts` 的 `WorkerCommand` 联合加成员 → `worker/entry.ts` 加处理分支 → `main/session-manager.ts` 里加调用方（`#post`）。

⚠️ 与 `A` 的区别：**`A` 是渲染层的请求，`B` 是主进程对 worker 的指令**。多数「用户点了一下要影响 agent」的需求两处都要改。

### C. 加一个右栏视图（⑦）

1. `WorkspaceDock.tsx`：`DockKind` 加值 + `DOCK_KIND_META` 加元数据。
2. **`closable` 决定它是否出现在「+」菜单**——菜单项**由该字段推导**，不要手写第二份列表。
3. 加渲染分支；面板放 `features/Conversation/panels/`，用 `SidePanelShell` 作外壳。
4. 冒烟 `dock` 模式加断言（页签数按 `data-dock-tab` 认，**别用 `button[aria-pressed]`**——容器里还有别的可切换控件）。

⚠️ 新视图必须回答「**关掉之后怎么回来**」（出口：`+` 菜单 / 自动展开规则 / 其它入口）。

### D. 加一个表字段

1. `main/db/index.ts`：`SCHEMA` 加列 + `SCHEMA_VERSION` **加一** + `MIGRATIONS` 加一条（用 `addColumnIfMissing`）。
2. `main/db/repo.ts`：行类型与映射、读写函数。
3. `tests/migration.test.ts`：**断言存量行为**（旧数据应留 `NULL` 还是回填，取决于该字段语义——「NULL = 从未设置」是一种语义，见 `thinking_level`）。
4. 更新 `tests/migration.test.ts` 的 `LATEST` 常量。

⚠️ 迁移**写错会毁用户数据**，且只在已有用户库上才暴露。规则见 `docs/SECURITY.md` 的「数据」。

### E. 加一个工具（给模型用）

1. `worker/lib/` 下写薄封装（现有：`browser-tool.ts`、`computer-tool.ts`）。
2. 送进 lane 的工具集。
3. **判断它是否只读**：只读就必须加进 `shared/readonly-tools.ts` 这个唯一真源，否则要么被误报、要么遮蔽真漏报。
4. 需要宿主能力就走 `host-bridge`（`toolRpc`）。
5. 若涉及写盘 / 危险命令，确认审批策略能识别它——见 `docs/SECURITY.md`。

---

## 六、资源与上限（一览）

改动这些值之前先想清楚：**它们大多是「不设就会出事」才存在的**。

| 项 | 值 | 为什么 |
|---|---|---|
| worker 池上限 | **6** | 超出时回收最久未活动的空闲会话；被钉住的最**后**才动（不是绝不——全钉住还得让出一条，否则新会话开不出来） |
| worker 空闲回收 | **30 分钟**（扫描间隔 60s） | 一个 worker 是一个进程，不回收会越积越多。2026-09-18 由 5 分钟放宽：切走不再杀 worker 之后，这是唯一的**定时**回收，而它捞的往往是用户还要回来的会话——刻意往「响应优先」偏（切回的即时性由渲染层的视图缓存兜底）。被钉住的会话**跳过**不回收 |
| 会话钉住（pin） | 用户逐条设，**只活本次运行** | 把「别自动回收」交回用户：空闲回收跳过、池满最后才淘汰。规则本身是 `main/worker-pool.ts` 的两条纯函数（`reapTargets` / `evictionVictim`），由单测钉死——30 分钟的回收器冒烟里等不到。标记只存内存（`main/session-pins.ts`），不落库：worker 本就不跨重启，重启后一切重放，钉不钉没区别 |
| worker 启动上限 | **120s**（`COLT_READY_TIMEOUT_MS`） | 长历史重放可能数十秒；但超过就是卡住，必须拒绝等待方，否则界面永久停在「正在启动会话进程…」 |
| `dispose` 宽限 | **3s**，超时强杀 | `dispose` 只是一条消息，worker 忙时可能迟迟不处理 |
| 宿主 RPC 上限 | **90s** | **必须大于**主进程侧最长动作（`browser/wait` 页内硬超时 60s + 主进程 5s 余量）。若取等，按上限等待时必然被 RPC 超时抢先，把「等待超时」误报成「宿主能力坏了」，模型会原参重试 |
| 观测缓冲 | **300** 条 | 控制台 / 网络缓冲上限 |
| 下载 | 单文件 **100MB**（超限取消并如实提示）；观测列表保留最近 **5** 条 | 落盘要有界。⚠️ 那个 5 是**观测列表**的条数上限（`MAX_DOWNLOADS_PER_SESSION` 只做缓冲截断），**并不阻止第 6 个下载**——要真正限制下载数量需另加每会话计数与 `item.cancel()` |
| 截图 TTL | **2 分钟** | 电脑控制的截图不能无限留 |
| 文件预览 | 文本 **1MB** / 图片 **8MB** | 超出**直接报「过大」，不截断**——半截文件比看不到更容易误导 |
| 工具截图 | 落盘一次、按需读回（视图里只留 `hasImage`），单张上限 **8MB** | 视图是全量快照、流式期间每 50ms 重推（见 §二），base64 放进视图等于被反复搬运。落盘在 `<userData>/tool-output/<sessionId>/`（名 = `<toolCallId>.<ext>`），会话删除时整目录清掉；读不回来要分档如实说（`missing` / `too-large` / `unreadable`），不能一律说「没有」 |
| 基线快照 | 文本 **1MB** | 净值基线的体积上限 |
| 「页面够不到的内容宽度」重测 | 去抖 **300ms**；装载未完成时重试 **3 次 × 500ms** | 拖动分隔条时宽度逐像素变化，逐次去查页面布局太贵；而 `did-finish-load` 触发时子资源仍在飞（`isLoading()` 仍为 true），**只量一次会静默漏掉**——页面真装不下却永远不提示（v1.39 实测踩过） |
| 「适应宽度」的最小缩放 | **0.6**（`MIN_FIT_ZOOM`） | 最窄栏（219）里装下 700px 的页面要缩到约 31%，那已经认不出字了——缩到看不见等于把「看不到右边」换成「什么都看不到」。到下限仍装不下就**如实说**并撤掉按钮，不再往下缩 |
| 渲染层 bundle | 约 **2.0 MB** | 目前没有预算机制，只作为观察值记录在此 |

---

## 七、构建与产物

`electron-vite` 三份产物：`out/main`、`out/preload`、`out/renderer`。类型检查分三个 tsconfig（`node` / `web` / `test`）——**`npm run build` 会先跑前两个**，所以构建过了不代表测试类型也对，`npm run typecheck` 才跑全部三个。

冒烟装置用 `import.meta.env.DEV` 守卫，**生产构建会把整段树摇掉**——包里不残留「可被环境变量激活的入口」。

### 环境约束（会真的拦住你）

- **`electron` 精确 pin 在 `44.2.0`**。本机开着 Windows「智能应用控制」（SAC）时会拦未签名的 `electron.exe`：`npm run dev` 报 `spawn UNKNOWN`（errno `-4094`），而 `build` / `test` 全绿。官方 Electron 本就不签名，SAC 按微软信誉库放行，**实测阈值在发布后 7~11 天**——所以不要用 `^`，升版本后必须**真起一次** `npx electron --version`。
- **Node ≥ 22**（`node:sqlite`、`node:test`）。
- 浏览器工具**只接受 http/https**，且不能开 `file://`——预览本地 HTML 要先起静态服务。
