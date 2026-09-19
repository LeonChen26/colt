# 子代理（subagent）设计草案

> **状态**：**已实施**（2026-09-19，P0–P3；决策 D1–D10 逐条落地，见 §3、§13）。
> **落地位置**：worker 侧 `src/worker/lib/{subagent,agent-defs,subagent-view,lane-ownership,tool-bookkeeping,approval-bridge}.ts`；
> 界面侧 `SubagentPreview.tsx` / `panels/SubagentStream.tsx` / `FollowPanel.tsx` / `MessageList.tsx` / `ChangeDrilldown.tsx`；
> 冒烟 `COLT_SMOKE_MODE=subagent`（免模型）；单测 `tests/{subagent,lane-ownership,agent-defs,subagent-view,stable-view,telemetry,project}.test.ts`。
> **P4 未做**（按计划）：按子代理归属分组统计、`/subagent` 命令；~~计费 e2e~~ **`subagent-e2e` 已建并已实测**（2026-09-19，qwen3:0.6b，15/15 全绿，见 §10、§12 上方的运行手册与 `NEXT-PHASE.md` §5 3-f）。
> **一句话**：给模型一个「把一件事整包交给另一个 agent 去做」的工具——子代理跑在**同会话的独立
> lane** 上（进程内、独立 transcript、独立工具白名单），**开局只有委托方写的那段任务描述**（`fresh`，
> 刻意不继承主对话历史），产出一段结论回到主对话；界面上它是 ④ 的一张**活卡** + ⑦「任务摘要」
> **此刻**段里的一行，完整过程点进去看。
> **配套**：动手前读 `docs/ARCHITECTURE.md`（§四 内核边界与「Pi 生态的扩展宿主给了什么、我们为什么不用」、
> §E 加一个工具）、`docs/PRINCIPLES.md`（#1 永远有心跳、#8 自动行为不抢焦）、
> `docs/SECURITY.md`（免审批边界 / 子 lane 的既有口径）、`docs/ERRORS.md`（失败怎么讲）、
> `docs/UI-REGIONS.md`（⑦-A 现场 vs 叙述、⑦-E 默认视图、⑦-G 总账与下钻、v1.48 三段顺序）、
> `AGENTS.md` §1.4（体量闸）§3.5（先读代码）§3.6（死控件）§四（「参数传了、行为却由库决定」）。
> **兄弟设计**：`docs/DESIGN-todo.md`（它进的是「任务摘要」**第一段**，本设计进**第二段「此刻」**，
> 两者改的是同一个 `FollowPanel.tsx`——排期时注意别互相踩，见 §10）。
> **参考实现**：`pi-subagents@0.68.0`（MIT，源码在 `.workbuddy/pi-ext-review/`）——
> **只抄两样**：①「fork 是真实会话分叉、不是摘要注入」这个事实认定；②结果回传的**诚实口径**
> （进程状态 ≠ 任务完成）。
> ⚠️ **不要抄它的执行模型**：它早期「每个子代理一个 `pi` CLI 子进程」，上游 0.65.0 起已改成
> **进程内会话**（见 `.workbuddy/pi-ext-review/pi-lens-4.2.0/docs/subagent-compat.md`）。
> 它的扩展宿主层（`promptSnippet` / `renderCall` / `setWidget`）在本仓**没有对应物**，
> 理由见 `ARCHITECTURE.md` §四。

---

## 1. 依据

| 来源 | 约束 |
|---|---|
| `NEXT-PHASE.md` §3.2 能力表 ⑤ | 子代理「未开工（**先设计 fork 语义**）」；**多 lane 有 `TIDY_LANE` 先例** |
| `NEXT-PHASE.md` §3.2 扩展宿主层 | **不自建扩展宿主**；能力**内建**进 `AgentHarness.create({ tools })`，每个都过审批闸门 |
| `ARCHITECTURE.md` §四 | 内核 `AgentTool` 只有 `name / label / description / parameters / execute`——**没有** `promptSnippet` / `promptGuidelines`，引导只能写进 `description` 或 `composeSystemPrompt` |
| `PRINCIPLES.md` #1 | 永远能看出在不在动：子代理的存活状态必须**界面上看得见**，不能靠猜 |
| `PRINCIPLES.md` #8、`UI-REGIONS.md` ⑦-D | 自动行为**不抢焦**：子代理启动**不自动切/展开右栏**（见 §3 决策三） |
| `UI-REGIONS.md` ⑦-A | ④ 是「叙述」、⑦ 是「现场」，**同一件事的两种表达不可互相替代** → 决定子代理过程放哪 |
| `UI-REGIONS.md` ⑦-G / ⑦-H | 「同一类对象只在一处渲染」；附属内容**给结论不给流水**；**下钻**是既有语言 |
| `UI-REGIONS.md` v1.48 | ⑦ 默认视图=**任务摘要**，三段顺序 = **计划 → 此刻 → 改动总账**；子代理进「此刻」段（还在更名中，见 §11 排期） |
| `SECURITY.md` §技能 / 整理面 | 子 lane 的既有口径：工具白名单**按 lane 持久化**、审批 HookRegistry **全 harness 共享不豁免**、子 lane **对界面不可见**（故必须有显式出口） |
| `AGENTS.md` §1.4 | `worker/entry.ts` 与 `main/session-manager.ts` 是**有体量闸的大户**（上限=建闸那天行数，零余量）——新逻辑必须压进新文件 |
| `AGENTS.md` §3.6 | 不许死入口：有子代理的界面，点下去必须有可见反馈 |
| `AGENTS.md` §四 | 「库提供了函数」≠「库会调用它」：让模型**看见**子代理清单必须应用自己拼进提示词（同技能那次的翻车） |

---

## 2. 现状（代码实测，不是推测）

| 事实 | 位置 |
|---|---|
| 内核**原生支持同会话多 lane**：`harness.lane(name, {createAt}, context)`、`harness.lanes()`；忙判定 **per-lane**（`LaneBusy` 带 lane 字段） | `@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:679-705`、`runtime/harness.js:56-130` |
| `createAt` 是一条**条目 id 或 null**；内核取 `tipId = branch ? branch.tip : options.createAt ?? null` | `runtime/harness.js:83` |
| 内核**没有**任何 subagent / task / spawn / delegate 工具，也**没有 lane 级 fork**（`OperationRequest.kind` 只有 `prompt\|skill\|prompt_template\|compaction\|navigation`） | `harness/tools/index.d.ts`（只有 bash/edit/read/write）、`agent-harness.d.ts:48-77` |
| **有**会话级 fork：`SessionRepo.fork(scope: "branch" \| "tree")`，产生**新 session** | `harness/session/types.d.ts:474-510` |
| `lane.watch()` **按 lane 名过滤事件**——主 lane 的订阅**天生看不到子 lane** | `runtime/lane.js`（`installWatch` 的过滤式） |
| 所有 hook 入参都带 `{ lane, runId }` → 可按 lane 分流 | `agent-harness.d.ts:606-610` |
| `watchSession()`（订阅整会话 lane 变化）**类型在、运行时 `throw SliceNotImplemented`** | `runtime/harness.js:228-230` |
| 本仓 worker 注册 14 个工具（`read/write/edit/bash` + `browser×3` + `computer×2` + `memory_search` + `ask_user`），**无 subagent** | `worker/entry.ts:368-377` |
| **唯一的子 lane 先例**：`/memory-tidy` → `harness.lane(TIDY_LANE)`（**不传 `createAt`** ⇒ 起点 `null`、自成一条链） | `worker/entry.ts:797`（`lane` 在 `:814`）、`worker/lib/memory-tidy.ts:33` |
| 子 lane 的**四条既有语义**可直接继承：独立 transcript、`setActiveTools` 按 lane 持久化、审批共享、崩溃恢复按 lane 名重开 | `entry.ts:613-637`（恢复循环）、`SECURITY.md` 整理面 |
| 子 lane **对界面不可见**的根因是三重叠加：主 lane 的 `watch` 快照 + `pushView` 只投影这一份 + telemetry 只采主 lane | `entry.ts:547/597-601`、`telemetry.ts:16` |
| `transform_context` 是**唯一**能做「按 lane 换系统提示词」的地方（harness 级系统提示词是单值） | `entry.ts:430`（临时提醒）、`:445`（AGENTS.md/记忆 + TIDY 分流） |
| 视图**唯一出口** `pushView()`，流式期间 `scheduleFlush` 每 50ms 全量重推 | `entry.ts:271-283` |
| 投影是**纯函数**，且有「升级哨兵」逼你处理新内容块类型 | `worker/lib/project.ts:222-372`、`COVERED_BLOCK_TYPES :34-39` |
| `ConversationView` **无任何 lane 维度**；`lane` / `cwd` / `faulted` **曾被删掉**并留了「别顺手加回来」的注记 | `shared/worker-protocol.ts:118-128` |
| `streamingText` / `thought` 是**单值**、`running` 单布尔、`runningTools` 扁平（**多 lane 并行在契约上不可表达**） | `worker-protocol.ts:153-172` |
| 遥测**只采主 lane**（4 条单测钉着），子 lane 的用量/工具调用**一律丢弃** | `telemetry.ts:16,25,73,136` + `tests/telemetry.test.ts` |
| 分支树扫的是**会话级** `session.findEntries`，`projectBranchNodes` **不认 lane** | `entry.ts:252-256`、`project.ts:148-205` |
| 消息流按 turn 分组**只认 role**（两条 lane 的消息混进来会被错并成一轮） | `renderer/src/lib/turn-groups.ts`（`groupTurns`） |
| ⑦「任务摘要」**此刻段**的数据源就是 `runningTools`，注释写明「**全应用唯一出处**」 | `FollowPanel.tsx:8`、`:96`、`:135` |
| 此刻段取摘要的函数**只认 `command` / `path`**——`{agent, task}` 会退化成光秃秃一行 `subagent` | `FollowPanel.tsx:41-50` |
| 审批 / 提问队列键是 `sessionId + toolCallId`，两者**都无 lane 字段** | `shared/protocol.ts`（`ApprovalRequest` / `UserQuestionRequest`） |
| `READONLY_TOOLS` 是免审批的**唯一真源**；`ask_user` **不在**名单里，故必须在 `before_tool` **显式跳过** | `shared/readonly-tools.ts`、`entry.ts:404-421`、`:459-471` |
| 有 request/response 型 IPC 的既有范式：`session.branches` 走主进程 `pendingBranches` 队列 + 超时 | `main/session-manager.ts`（`branches()`） |
| 免模型的冒烟范式：`COLT_SMOKE_MODE=ask-user`（推受控视图 + 主进程打桩计数） | `src/dev/smoke/modes/ask-user.ts` |
| 打模型的 e2e 范式：**worker 的生死交给渲染层**（`upsertProject(夹具)` + `window.reload()`），**不**直连 `session.open` | `src/dev/smoke/modes/ask-user-e2e.ts`、`AGENTS.md` §五末条 |
| `GLOSSARY.md` **没有**「子代理 / lane fork」词条（只有 `harness / lane`） | `docs/GLOSSARY.md:121` |

---

## 3. 关键决策

十条结构性决定。逐条对应上面的代码事实。

### 决策一（D2）：执行模型 = **同会话多 lane，进程内**

不学「`repo.fork` 新 session + 第二个 harness」。理由：

1. **先例已验过四条**（决策二列出），`TIDY_LANE` 把「独立 transcript / 按 lane 白名单 / 审批共享 /
   按名恢复」都跑通了，本设计与它同一形态，**零新机制**。
2. `repo.fork` 产出的是**新 session**——多一行会话记录、多一个 worker 进程、资源账要重算
   （`NEXT-PHASE.md` 对多实例的既有警告：**必须与资源上限/挂起同时交付**）。
3. **并行是白拿的**：模型在一条 assistant 消息里发多个 `subagent` 调用 → 内核并发执行工具 →
   多条 lane 同时跑。**不需要编排 DSL**。
   ⚠️ 待实测确认内核的工具并发策略（`AgentHarnessOptions.toolExecution`）；设计上**不依赖**它——
   单个子代理先通，并行是 bonus。

代价如实记下：**所有 lane 共用一份 JSONL、共用一个进程**——worker 崩溃会带走所有在跑的子代理。
（不影响正确性：崩溃恢复循环按 lane 名重开，与 TIDY 同一条路。）

### 决策二（D3）：fork 语义 = **只有 `fresh`；`fork` 明确否决**

| | `fresh`（`createAt: null`） | `fork`（`createAt: 主 lane 当前 tip`） |
|---|---|---|
| 子代理看得见 | **只有 `task` 那段话** + agent 的系统提示词 | 主对话**到该点为止的全部历史** + `task` |
| 本质 | 一座空岛（TIDY 就是这种） | 真实会话分叉点（**不是**摘要注入） |
| 成本 | 便宜 | 每次委派**重放一遍主上下文** |
| 分支树过滤 | 无共享祖先 → 整条链都是它的 | 需「上溯到分叉点为止」的一半逻辑 |

**否决 `fork` 的理由（不是「晚点做」，是「与目的冲突」）**：子代理存在的意义就是**隔离上下文**；
`fork` 是**隐式整份复制**，把主对话的噪声与错误假设一起搬过去，还每次付一遍重放的钱。而 `fresh`
逼出来的是**显式、有损、由委托方决定什么重要**的交接——那段 `task` 就是上下文通道，这才是健康的。

**落地口径**：v1 **连 `context` 参数都不暴露**——模型没有机会选错。要加 `fork` 的前提先被证明：
「委托方写不清任务、必须靠整份历史」，而当前判断是它写得清。

⚠️ **因此 `lane-ownership.ts` 的过滤算法只写 `fresh` 那一种**（整条链排除），**不要**预先写通用算法——
那是「为不存在的需求修路」（`worker/lib/memory-tidy.ts:9-10` 正好在骂这类事）。

### 决策三（D5）：呈现 = **④ 活卡 +「任务摘要」此刻段 + 下钻；不新增页签、不自动展开**

先说被推翻的版本：本设计的初版是「④ 工具卡 + 右栏**新增『子代理』页签**」——那是**同一件事两个入口**，
而本仓刚为消除双入口动过三次手术（A3-5 消「改动面板 vs 代码变更视图」、⑦-G 把三处重复的路径列表
收敛成「总账 + 下钻」、⑦-H「附属视图给结论不给流水」）。故重做。

**关键事实**：子代理调用**本来就会出现在**「任务摘要」此刻段——一次 `subagent` 调用在整个子代理
运行期都是一个 running tool，而此刻段的数据源就是 `runningTools`（`FollowPanel.tsx:8`、`:96`）。
**总览已经存在**，我们只需让它显示得对。

| 场景 | 承载 | 数据 |
|---|---|---|
| 运行中 | 「任务摘要」**此刻段**一行（名称 + 任务 + 当前动作 + 计时 + 中止） | `view.subagents[]` 中 `status === "running"` |
| 已结束 | **④ 的卡**（随 transcript 持久） | `view.subagents[]` + 工具卡 |
| 想看内部过程 | 点此刻段那一行 / 点 ④ 卡 → ⑦ **下钻到子代理流**（面包屑 + ESC，复用既有下钻栈） | 按需拉完整 transcript |
| ④ 卡展开 | **有界预览**（最近 N 步） | `ViewSubagent.tail` |
| 审批 / 提问 | **仍在 ④ 主流**，加「来自 X」chip | 队列键不变（`toolCallId` 天然唯一） |

**为什么不是「④ 内联完整流」**：④ 是「叙述」（⑦-A），把**另一次叙述**嵌进来，会让「我刚才让 agent
做了什么」这条主线被淹没——而隔离正是子代理存在的理由。且 ④ 的 turn 分组 / 消息窗口 / `TurnRail`
都假设**一条线性流**，嵌套流要另写一套。

**不自动展开右栏**（对齐 ⑦-D 不抢焦）：⑦-F 那次自动展开是给「外部对象」的（agent 首次加载浏览器）；
子代理是**模型自己发起**的，routine 起来会反复把用户的右栏撑开。而「必须被看到」已由 ④ 那张卡保证
——它在对话流里，用户必然看见。

### 决策四（D6）：`subagent` **自身豁免闸门**，但它内部的工具**照拦**

否则同一件事弹两次卡（委派一次 + 子代理内部工具各一次），用户会去关审批——那更糟。

**安全性不降**：`subagent` 的副作用**全部落在子代理的工具调用上**，那里照样过 `before_tool`。
读是免审批的（`READONLY_TOOLS`），写/执行会弹卡——所以「免审批地委派一个只读调研」是安全的，
而「委派一个删目录的动作」会在子代理那层被拦下。**没有绕过路径**。

**实现口径**（与 `ask_user` 同一处理方式，理由也一样——名字**不在** `READONLY_TOOLS` 里）：
`before_tool` 里显式跳过 + `after_tool` 的「未经闸门即执行」纵深防御里显式豁免
（`entry.ts:404-421`、`:459-471`）。**两处都要写**，漏一处就刷假告警。

### 决策五（D8）：计量拆成**两个判据**（费用计入、上下文占用不计）

现状是一刀切：`telemetry.ts:16,25,73,136` 把非主 lane 的 usage / toolCall **全部丢弃**。
对 TIDY 那没问题（用户没主动要求看整理花了多少）；对子代理就**变成静默**——用户**付了钱却看不到**。

拆开：

| 量 | 口径 | 理由 |
|---|---|---|
| `contextUsed`（上下文占用条） | **仍只算主 lane** | 子代理占用不该顶满**主**上下文条 |
| `usage` / `costUsd`（费用） | **全 lane 上报**，带归属 | 用户真的付了这笔钱，藏起来是静默（`ERRORS.md`） |

⚠️ 这是**对既有定调的推翻**（`SECURITY.md` 现有措辞是「子 lane 消耗不计入会话统计」），要同批改文档。
归属信息先只在 `ViewSubagent.stats` 里展示；DB 按子代理分组统计留 P4（要动 `db` 的 usage 表）。

### 决策六（D10）：子代理条目**从分支树投影里排除**，且**禁止导航到它们**

**问题**：lane 在持久化里**就是命名分支**；`projectBranches` 扫的是**会话级** `session.findEntries`
（`entry.ts:252-256`），`projectBranchNodes` 不认 lane（`project.ts:148-205`）。`fresh` 的子 lane
起点是 `null` ⇒ 它的条目**自成一条根链**。

⚠️ **这条是读代码推断的（未实测），且它可能今天就已存在**：`TIDY_LANE` 同样不传 `createAt`。
若成立，整理 lane 的条目会作为**独立根节点**出现在左栏分支树里，且可点——一点就 `navigate`
**把主 lane 的指针挪到整理 lane 的节点上**。**P0 的第一件事是验证它**（只读探针，别先改代码）。

**修法**（纯函数，`lane-ownership.ts`）：子 lane 的条目 = 从 `tip_sub` 沿 `parentId` 上溯的那条链
（`fresh` 无共享祖先，整条都是它的）；从分支树排除这些条目。**纵深防御**：`navigate` 收到落在该集合里
的 `targetId` 时拒绝，并回一条可见错误。

### 决策七（D9）：视图只带**尾部**，完整流**按需拉**

视图每 50ms 全量重推（`entry.ts:271-283`）；N 个子代理的**全文**会按推送次数乘上去——与
「截图不进视图、落盘按需读回」同一条教训（`worker-protocol.ts:37-44`）。故：

- `ViewSubagent.tail` = 流式文本 / 思考 / running 工具 / **最近 N 步**（带上真实总步数）；
- 完整 transcript 走**按需拉**的新通道 `session.subagentTranscript`，范式抄 `session.branches`
  （主进程 `pendingXxx` 队列 + 超时）。

### 决策八（D1 / D4 / D7 / D9 之外的三条，一并记）

| # | 决定 | 理由 |
|---|---|---|
| **D1 触发方** | **模型自主委派**（`subagent` 工具）；用户手动 `/subagent` 留 P4 | 上下文隔离的价值主要在「模型自己判断该拆分时」；「用户显式触发」已由 `/memory-tidy` 覆盖 |
| **D4 身份** | lane 名 = `sub:${agentName}:${shortId}`，名字即持久身份 | 内核按 lane 名持久化配置与恢复（`memory-tidy.ts:32-33`），崩溃恢复白拿 |
| **D7 递归** | v1 **禁止 depth > 1**：白名单不含 `subagent` + 工具描述明写 + worker 守卫 | 递归 spawn 是最容易失控的一类（自我复制 + 费用失控） |

---

## 4. 契约变更

### `shared/worker-protocol.ts`

```ts
/** 一个子代理实例的总账；完整流按需拉（决策七） */
export interface ViewSubagent {
  /** lane 名 = 稳定持久身份（决策八 D4） */
  id: string;
  /** 主对话里那次 subagent 调用；④ 工具卡与此刻段那一行的锚点 */
  toolCallId: string;
  /** agent 定义名（显示用） */
  name: string;
  /** 一句话任务摘要（④ 卡与此刻段显示） */
  title: string;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  /** 仅 failed 时有值；摘要展示由渲染层负责 */
  error?: string;
  /** 运行中的**有界**尾部快照（视图每 50ms 全量重推，故必须有界） */
  tail: {
    streamingText: string | null;
    thought: string | null;
    runningTools: ViewRunningTool[];
    /** 最近 MAX_SUBAGENT_STEPS_IN_VIEW 步 */
    recentSteps: ViewMessage[];
    /** 真实总步数（截断时如实给总数，不许静默裁掉） */
    stepCount: number;
  };
  /** 子代理自己的消耗（决策五 D8） */
  stats: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface ConversationView {
  /* …既有字段… */
  subagents: ViewSubagent[];
}
```

⚠️ **不改 `ViewMessage`**：子代理的流**不混进主 `messages`**——否则 `groupTurns`（只认 role）
会把两条 lane 的消息错并成同一轮。隔离靠**独立承载**，不靠渲染层猜。

### 命令 / 消息

```ts
// WorkerCommand
| { type: "subagentAbort"; id: string }        // 单子代理中止（P2）
| { type: "subagentTranscript"; id: string }   // 拉完整流（按需，决策七）

// WorkerMessage
| { type: "subagentTranscript"; id: string; messages: ViewMessage[]; toolResults: ViewToolResult[] }

// 阻塞卡带上来源（P2）——审批/提问队列键不变
| { type: "approvalRequest"; /* …既有… */; subagent?: { id: string; name: string } }
| { type: "askUserRequest"; /* …既有… */; subagent?: { id: string; name: string } }
```

### 新 IPC 通道

`session.subagentTranscript`：`IPC_CHANNELS` + `IpcInvokeMap` + `IPC_EVENTS` + `IpcEventMap` + preload
**五处联动**（有编译期键对齐断言兜底，见 `ARCHITECTURE.md`）。**视图本身搭 `session.view` 顺风车，零新事件。**

### 常量放哪：`worker/lib/subagent.ts`，**不放** `shared/limits.ts`

`limits.ts` 的准入判据是「两侧不同值就会**静默**出错」（挂半路、界面停住没有失败信号）。
本设计的上限**只有 worker 用**（超时、并发数、视图截断、目录块预算），渲染层不读任何一个 ⇒
**不进 `limits.ts`**（那里自己写着「仅 main / worker 本地使用的上限…不必进这里」）。
⚠️ **但要解释为什么不进**，免得下一个人照「两侧共享的常量」一律往里塞。

---

## 5. worker 侧编排

### 新增文件（全部有单测）

| 文件 | 职责 | 纯度 |
|---|---|---|
| `worker/lib/subagent.ts` | `subagent` 工具工厂 + 编排（建 lane / watch / abort / timeout / depth 守卫）+ 常量 | 入口薄 |
| `worker/lib/agent-defs.ts` | `.agents/agents/*.md` 的发现 / 解析 / 同名取舍 + 目录块组装 | **纯函数 + IO 分离**（对标 `worker/lib/skills.ts`） |
| `worker/lib/subagent-view.ts` | `LaneSnapshot → ViewSubagent` 投影 + 尾部截断 | **纯函数** |
| `worker/lib/lane-ownership.ts` | 「哪些条目属于子 lane」的计算（决策六 D10） | **纯函数** |

⚠️ **体量闸**：以上全部落在新文件里，`entry.ts` 只留**装配一行 + `case` 一行委托**——
这是提问链路被闸逼出来的结构，照搬。

### 一次 `subagent` 调用的生命周期

```
模型发 subagent{agent, task, title?}
  └─ before_tool：toolName==="subagent" → 豁免闸门（决策四 D6，同 ask_user）
  └─ execute()：
       ① 解析 agent 定义（名字不存在 → throw，文案给出可用名，对标 @shared/skill-error）
       ② 守卫：depth（本 lane 不能再开）、并发上限、主 lane 是否已在跑
       ③ name = `sub:${agent}:${shortId}`
          lane = await harness.lane(name, { createAt: null }, context)   // fresh
       ④ lane.setActiveTools(agentTools)      // 硬白名单，按 lane 持久化
       ⑤ watch = await lane.watch(context); watch.start(e => { reduce; scheduleFlush() })
       ⑥ 注册进 subagents 表 + pushView()      // ④ 卡与此刻段立刻可见
       ⑦ r = await lane.prompt(task, undefined, context)
       ⑧ 终态 → pushView(); 退订 watch; 返回工具结果（结论文本 + 诚实 details）
```

⚠️ **失败有两条路径，缺一不可查**（`Result.err` 的 `LaneBusy` / `Closed` / accept 被拒；
以及 `Result.ok` 但 `record.status` 为 `failed` / `aborted`）。这是 `compact` / `memoryTidy`
**已经踩过两次**的坑（`entry.ts:770-795`、`:821-835`）——不查就是「点了没反应」。

### 系统提示词归属（`transform_context` 加**第三个**分流）

现有一条是 `TIDY_LANE` 专用提示词，一条是主对话（AGENTS.md / 记忆注入）。新增子代理分支：

| lane | 系统提示词 |
|---|---|
| main | 编码助手基础提示词 + 技能清单 + AGENTS.md + 记忆（现状） |
| `memory-tidy` | `memoryTidySystemPrompt`（现状） |
| **`sub:*`** | **agent 定义正文** + AGENTS.md 块。**不注入记忆、不注入技能清单** |

不注入记忆/技能的理由：记忆是**主对话的**沉淀优势，注入等于把父的上下文偷渡给子代理；
技能清单会暗示「你可以调技能」，而子代理的工具面是硬白名单、没有 `skill` 能力 ⇒ **死入口**（§3.6）。

### 让模型**看见**子代理（**必须显式做**）

内核**不会**自动往提示词里放 agent 目录（同 `formatSkillsForSystemPrompt` 那次的教训：
**只导出、不调用**）。故在主 lane 的 `transform_context` 里拼一个 `<available_subagents>` 块：

- 有界（`MAX_AGENT_CATALOG_CHARS`）；**只在主 lane 注入**（子 lane 注入会暗示递归）；
- **判据必须落在最终产物上**：断言**组装后的提示词字符串**里真的出现了清单，
  而不是「目录被读到了」——`AGENTS.md` §四 记的正是这个坑。

### agent 定义（声明式，对标 skills 的开放姿态）

```
<cwd>/.agents/agents/<name>.md      # 项目级优先
~/.agents/agents/<name>.md          # 用户级
```

```markdown
---
description: 只读的代码调研员——在大范围文件里定位事实，给出带出处的结论
tools: read, grep, glob, ls, memory_search
---
（正文 = 该子代理的系统提示词）
```

- 名字取**文件名**（目录内唯一）；`description` **必填**（它要进目录块）。
- 同名取舍与遮蔽**如实告知**，完全复用 skills 那套口径（项目级胜出、被遮蔽的名字报出来）。
- 内建兜底两个：`researcher`（只读白名单）、`general`（默认工具集）。
- ⚠️ **实现前先确认内核是否导出 frontmatter 解析器**（`loadSkills` 内部显然解析了，但未必导出）。
  没有就写**极简解析**（只认 `key: value` 与逗号分隔数组），并注明「不是完整 YAML」——
  **不要为此引新依赖**。

---

## 6. 分支树与导航（决策六 D10 的落地）

- **P0 先验证**：只读探针跑一次 `/memory-tidy`，前后 dump `session.branches`，看是否多出根节点。
  **验证先于修复**（`AGENTS.md` §1.2）。探针若证明无此问题，本节的修法降级为「预防子代理引入」。
- **过滤**：`lane-ownership.ts` 导出 `ownedEntries(tipId, entries)`（`fresh` 专用），
  `projectBranches` 在交给 `projectBranchNodes` **之前**把子 lane 的条目剔除。
- **导航守卫**：`case "navigate"` 收到落在该集合里的 `targetId` → 拒绝 + 可见错误
  （理由：「点了子代理的过程节点，不该改变主对话的历史指针」）。
- **TIDY 同批处理**：整理 lane 与子代理 lane 走同一条排除规则（它同样是 `createAt: null`）。

---

## 7. 计量（决策五 D8 的落地）

- `telemetry.ts` 拆成两个判据：`contextUsedFromUsage` 保留 `MAIN_LANE` 过滤；
  `buildUsageUpload` / `ToolCallTracker.end` **去掉** lane 过滤，并**带上归属**。
- `WorkerMessage.usage` 增 `subagentId: string | null`（主 lane 为 `null`）。
- `ViewSubagent.stats` 由子 lane 自己的 usage 事件累加（不复用主 lane 的 `stats`）。
- 同批改 `SECURITY.md` 的措辞（「子 lane 消耗不计入会话统计」→「费用计入，上下文占用不计」）。
- ⚠️ **别顺手改给模型看的文本**：`browser_read` 的 `formatConsole` / `formatNetwork` 与本次无关。

---

## 8. 工具定义（`worker/lib/subagent.ts`）

- **命名** `subagent`（与 `memory_search` / `ask_user` 同风格）。
- **入参**（typebox，照 `memory-tool.ts` 的写法）：
  `agent: string`（必填）、`task: string`（必填）、`title?: string`（④ 卡与此刻段显示用；缺省取 `task` 首行）。
  **v1 不暴露 `context`**（决策二 D3）。
- **`description` 是本仓唯一的引导落点**（内核 `AgentTool` **没有** `promptSnippet` / `promptGuidelines`，
  见 `ARCHITECTURE.md` §四）。**两件事必须教**：
  1. **`task` 要自包含**——背景（相关路径 / 已知事实）、目标、交付物、约束。
     `fresh` 子代理看不见主对话，写不清就必然空转（决策二：`task` 是唯一的上下文通道）。
  2. **何时该委派**——只在任务能整包交出去、且隔离有收益时；简单任务自己做完更快。
- **`execute`**：`bridge` 不需要——它在本进程内直接操作 harness（不是宿主能力）。
  返回 `{ content: [{ type: "text", text }] }`，`text` = 子代理的结论 +
  **诚实的过程收据**（用了哪些工具 / 看了哪些文件 / 改动几处 / 是否被中止）——
  否则委托方分不清「真做完了」和「放弃了随便答一句」，只会重试，重试就是钱。
- **校验失败走 `throw`**，不是回一条「失败文本」（内核 `AgentToolResult` 没有 `isError`，
  返回文本会被当成「工具成功返回了一段话」）。失败文案必须给出**正确写法**。
- **不进 `READONLY_TOOLS`**（决策四 D6），改为在 `before_tool` / `after_tool` 里**显式**处理。

---

## 9. 渲染层

| 位置 | 内容 | 复用 |
|---|---|---|
| ④ | `subagent` 工具卡**特化**：`子代理 · <name>` + 任务一行 + 状态点 + 耗时；展开 = **有界预览**（最近 N 步）；「在右栏查看完整过程」 | 工具卡骨架 |
| ⑦「任务摘要」**此刻段** | 运行中的子代理作为一行（名称 + 任务 + 当前动作 + 计时 + **中止**） | `FollowPanel.tsx` 既有段一；**必须先让 `parseToolArgs` 认得 `{agent, task}`** |
| ⑦ 下钻 | 子代理的**完整流**（面包屑 + ESC，复用下钻栈；下钻目标从「文件内容」多一种到「子代理流」） | 既有下钻语言 |
| 阻塞卡 | 标题加「来自 `<子代理名>`」chip | `ApprovalCard` / `QuestionCard` |

- **数据来源**：`view.subagents`（**零新事件**）；完整流走 `session.subagentTranscript`（按需）。
- **不做** ⑦-F 自动切页签 / 自动展开（决策三）；**不改** `DockKind`；**不进**「+」菜单。
- **冒烟钩子**：`data-subagent-*`（名称 / 状态 / 步骤数），**不要用 class 断言**。
- ⚠️ **下游两处不同步就静默失效**：`lib/stable-view.ts`（**逐字段覆盖契约**，漏一个就
  「后台变了、界面纹丝不动」，有 `tests/stable-view.test.ts` 的逐字段扰动守着）+ `view-cache.ts`。

---

## 10. 分批实施

> ⚠️ **体量闸**：`worker/entry.ts` 与 `main/session-manager.ts` 是**已知大户**（上限=建闸那天行数，
> 零余量）。动手前按 `AGENTS.md` §1.4 **先量净增、先决定搬哪块**，别等闸红了再拆。
> 本设计已把新逻辑压进四个新文件，大户只留一行接线——这是刻意的。

| 批 | 内容 | 为什么这个顺序 |
|---|---|---|
| **P0 地基** | ① **只读探针**验证分支树 lane 污染（含 TIDY）；② `lane-ownership.ts` + `projectBranches` 排除 + `navigate` 守卫；③ 契约加 `subagents` / `ViewSubagent`；④ `telemetry.ts` 拆两个判据（+ 改 4 条既有断言与 `SECURITY.md` 措辞） | 不先修分支树，子代理一落地就把左栏搞乱；契约与计量是后面所有阶段的地基 |
| **P1 能力** | `agent-defs.ts` + `subagent.ts`（lane / watch / abort / timeout / depth）+ 目录块注入（**无 UI**） | 这条链路最贵的失败模式是**静默**，先在没有界面干扰时把「工具 → lane → 视图」验掉（同 `ask-user` 的排期理由） |
| **P2 呈现** | ④ 卡特化（含 `parseToolArgs` 认得子代理）+ 此刻段 + 下钻 + 阻塞卡来源 + 单子代理中止 | 用户看得见（§3.6 / `PRINCIPLES` #1） |
| **P3 总览收口** | `session.subagentTranscript` 按需拉 + 下钻内容层 + `subagent` 冒烟模式 | 与 P2 可合，但分两批更好定位 |
| **P4 可选** | 子代理消耗落库按归属分组、用户手动 `/subagent`、**（不排期）**`fork` 上下文模式 | 复杂度高、收益边际 |

**与 `todo` 的排期耦合**：两者都改 `FollowPanel.tsx`（todo 加**第一段「计划」**，本设计加**第二段「此刻」**
的内容），且都受 v1.48 **「正在处理」→「任务摘要」更名**影响。谁都不要把对方的段落删掉；
更名若先做，本设计直接按新名写。

---

## 11. 验收

### 单测（纯函数优先）

- `agent-defs`：frontmatter 解析（正常 / 缺 `description` / 坏 frontmatter / 非法 `tools`）、
  **同名遮蔽**（项目级胜出且被遮蔽名如实报出）、目录块组装**有界截断**。
- `lane-ownership`：`fresh` 子链整条被排除；**主对话条目一条都不误伤**；多子代理并存；
  TIDY 与子代理同时存在。
- `subagent-view`：`LaneSnapshot → ViewSubagent` 投影、尾部截断**如实给总步数**、终态映射。
- `telemetry`：**改现有 4 条断言**（非主 lane 从「丢弃」改成「计入且带归属」）+ 新增
  「`contextUsed` 仍只算主 lane」。
- **判据落在最终产物上**：断言组装后的**系统提示词字符串**里有 `<available_subagents>` 清单（§5）。

### 冒烟（不打模型）：新开 `COLT_SMOKE_MODE=subagent`

优先新开，不往 `dock.ts` 里塞（它已经很大）。范式抄 `ask-user.ts`（推受控视图 + 主进程打桩计数）：

1. 受控视图带 `subagents` → ④ 出现子代理卡、展开看到有界预览；
2. 「任务摘要」**此刻段**出现该子代理行；**已结束的从此刻段消失、但 ④ 的卡仍在**；
3. 点此刻段那一行 / 点 ④ 卡 → 下钻到子代理流（面包屑 + ESC 逐层回退）；
4. **分支树里没有子代理条目**；**导航到子代理条目被拒**（决策六 D10 的硬判据）；
5. `subagent` 调用**不弹卡**、子代理内部的 `write` **弹卡**（决策四 D6 的安全语义——
   在 `sessionManager` 上**打桩计数**，只记账、不转发）；
6. 主会话 `abort` → 在跑的子代理状态全部转 `aborted`（打桩计数）；
7. ⚠️ 断言小目标入口要**命中测试**（`document.elementFromPoint(中心)`），别只查「在不在 DOM 里」。

### 打模型的端到端：**已建已实测** `COLT_SMOKE_MODE=subagent-e2e`（2026-09-19，22/22 全绿）

做法同 `ask-user-e2e`：**worker 的生死交给渲染层**（`upsertProject(夹具)` + `window.reload()`
等它自动打开会话就绪），**不要**直连 `session.open` 去抢 worker（`AGENTS.md` §五末条）。
运行手册（命令 / 断言清单 / 已实测记录）在 `NEXT-PHASE.md` §5 **3-f**；判据一律取自主进程
（待审队列 / 视图 / 子代理 transcript），批准确走真实 UI（「允许一次」+ 命中测试）。

上面计划清单的落实情况：① 模型真调用了 `subagent` 且按名命中 demo ✅；② `fresh` 真的隔离
（主对话随机密语缺席子代理 transcript，判据是「缺席」）✅；③ 结果作为工具结果回主 lane ✅；
⑤ 费用归属有 stats 字段 ✅（本地 Ollama 不计费，未验计费通道本身）。**④ 递归被拒的
模型侧 e2e 仍未建**（白名单不含 `subagent` + 提示词明写 + depth 守卫只有单测与代码审查）。
另实测记录：小模型（0.6b）服从是概率事件——「发 prompt → 等内部 write」整条可重试至多
3 次，主 lane 绕过委派直接 write 会被拒掉并在理由里指路，断言不放水。

### 明确不覆盖（写明，免得被当成验过了）

- **`fresh` + `task` 单一通道的「任务描述能力上限」**：这条只能靠 `subagent-e2e` 实测
  （模型写不写得清、子代理跑不跑得动），**不是设计阶段能拍掉的**——如实写明是「靠 e2e 观察」，
  不是「已保证」。
- **内核的工具并发策略**（并行子代理是否真并行）：设计不依赖，未实测。
- **worker 意外崩溃那一支的收尾**：与 `ask-user` 的同类缺口一样，只有恢复循环覆盖，
  没有专门用例（`DESIGN-todo.md` §11 的诚实口径照搬）。
- **分支树污染**：P0 的探针若证伪，本节修法降级为「预防」，**如实记录结论而不是假装验过**。

---

## 12. 明确不做

- **`fork` 上下文模式**（继承主对话历史）——决策二：与隔离目的冲突，且传递方式（隐式整份复制）
  劣于显式 `task`。要重开需先证明「委托方写不清任务」这个前提
- **`repo.fork` 新 session + 第二个 harness**——决策一：多进程/多会话行，资源账更贵
- **递归子代理（depth > 1）**——决策八 D7：自我复制 + 费用失控
- **扩展宿主层 / `promptSnippet` / `renderCall` / TUI overlay**——本仓没有对应物，
  见 `ARCHITECTURE.md` §四 与 `NEXT-PHASE.md` §3.2
- **新增右栏「子代理」页签**——决策三：与「任务摘要」此刻段重复列同一批运行中动作（双入口）
- **子代理启动自动展开 / 自动切右栏**——决策三：违反 ⑦-D 不抢焦；「被看到」已由 ④ 卡保证
- **子代理的流混进主 `messages`**——会把两条 lane 的消息错并成同一轮（`groupTurns` 只认 role）
- **子代理内联完整流到 ④**——决策三：④ 是叙述，嵌套叙述会淹没主线，且要另写一套渲染
- **为 `fork` 预写通用过滤算法**——决策二：那是「为不存在的需求修路」
- **给模型的错误文本 / 内核错误字符串当判据**——`AGENTS.md`：别断言内核给出的错误字符串
- **子代理清单 / 多会话监控 / 整项目树**（与 `DESIGN-todo.md` 同一条）

---

## 13. 决策台账

| # | 决策 | 状态 |
|---|---|---|
| D1 | 触发方 = 模型自主委派（用户手动留 P4） | ✅ |
| D2 | 执行模型 = 同会话多 lane（进程内），不用 `repo.fork` | ✅ |
| D3 | **只有 `fresh`；`fork` 否决**，v1 不暴露 `context` 参数 | ✅ |
| D4 | 身份 = lane 名 `sub:${agent}:${shortId}` | ✅ |
| D5 | 呈现 = ④ 活卡 +「任务摘要」此刻段 + 下钻；无新页签、不自动展开 | ✅ |
| D6 | `subagent` 自身豁免闸门、内部工具照拦（无绕过路径） | ✅ |
| D7 | 禁止递归（depth = 1） | ✅ |
| D8 | 费用计入（带归属）、上下文占用只算主 lane | ✅ |
| D9 | 视图只带有界尾部，完整流按需拉 | ✅ |
| D10 | 分支树排除子 lane 条目 + 禁止导航到它们（P0 先验证） | ✅ |

**待补的文档动作**（实施时同批做，别留中间态）：
`GLOSSARY.md` 补「子代理 / lane / fresh」词条（现在只有 `harness / lane`，且 `ARCHITECTURE.md` 里的
「不 fork」是**不 fork 内核仓库**，与本设计的「会话 fork」**同词异义**——必须在词条里写清，防下一个人混淆）；
`SECURITY.md` 改计量措辞并补子代理的边界论证；`NEXT-PHASE.md` §3.2 能力表 ⑤ 的状态改为
「设计已完成、未实施」并指向本文件。
