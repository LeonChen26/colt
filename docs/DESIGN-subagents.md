# 子代理（subagent）设计

> **状态**：**已实施**（2026-09-19，P0–P3；决策 D1–D10 逐条落地，见 §3、§12）。
> **落地位置**：worker 侧 `src/worker/lib/{subagent,agent-defs,subagent-view,lane-ownership,tool-bookkeeping,approval-bridge}.ts`；界面侧 `SubagentPreview.tsx` / `panels/SubagentStream.tsx` / `FollowPanel.tsx` / `MessageList.tsx` / `ChangeDrilldown.tsx`；冒烟 `subagent`（免模型）；单测 `tests/{subagent,lane-ownership,agent-defs,subagent-view,stable-view,telemetry,project}.test.ts`。
> **P4 未做**（按计划）：按子代理归属分组统计、`/subagent` 命令。~~计费 e2e~~ **`subagent-e2e` 已建已实测**（2026-09-19，15/15 全绿，见 §8 与 `NEXT-PHASE.md` §5）。
> **一句话**：给模型一个「把一件事整包交给另一个 agent 去做」的工具——子代理跑在**同会话的独立 lane** 上（进程内、独立 transcript、独立工具白名单），**开局只有委托方写的那段任务描述**（`fresh`，刻意不继承主对话历史），产出一段结论回到主对话；界面上它是 ④ 的一张**活卡**，完整过程点进去看。
> **配套**：动手前读 `ARCHITECTURE.md`（§四 内核边界、§E 加一个工具）、`PRINCIPLES.md`（#1 #8）、`SECURITY.md`（免审批边界 / 子 lane 口径）、`ERRORS.md`、`UI-REGIONS.md`（⑦-A 现场 vs 叙述、⑦-G 总账与下钻）、`AGENTS.md` §1.4 §3.5 §3.6 §四。
> **兄弟设计**：`DESIGN-todo.md`（它进「任务摘要」**第一段**，本设计进**第二段「此刻」**，两者改的是同一个 `FollowPanel.tsx`——排期时注意别互相踩）。
> **参考实现**：`pi-subagents@0.68.0`（MIT，本仓**未收录**源码）——**只抄两样**：①「fork 是真实会话分叉、不是摘要注入」的事实认定；② 结果回传的**诚实口径**（进程状态 ≠ 任务完成）。⚠️ **不要抄它的执行模型**（早期「每子代理一个 CLI 子进程」，上游 0.65.0 起已改成进程内会话）；它的扩展宿主层（`promptSnippet` / `renderCall` / `setWidget`）在本仓没有对应物，理由见 `ARCHITECTURE.md` §四。

---

## 1. 依据

| 来源 | 约束 |
|---|---|
| `NEXT-PHASE.md` §3.2 能力表 ⑤ | 子代理「未开工（先设计 fork 语义）」；**多 lane 有 `TIDY_LANE` 先例** |
| `NEXT-PHASE.md` §3.2 扩展宿主层 | **不自建扩展宿主**；能力**内建**进 `AgentHarness.create({ tools })`，每个都过审批闸门 |
| `ARCHITECTURE.md` §四 | 内核 `AgentTool` 只有 `name / label / description / parameters / execute`——**没有** `promptSnippet` / `promptGuidelines`，引导只能写进 `description` 或 `composeSystemPrompt` |
| `PRINCIPLES.md` #1 / #8、`UI-REGIONS.md` ⑦-D | 子代理存活状态必须**界面上看得见**；自动行为**不抢焦**（启动不自动切 / 展开右栏） |
| `UI-REGIONS.md` ⑦-A / ⑦-G / ⑦-H | ④ 是「叙述」、⑦ 是「现场」，不可互相替代；「同一类对象只在一处渲染」；下钻是既有语言 |
| `SECURITY.md` §技能 / 整理面 | 子 lane 的既有口径：工具白名单**按 lane 持久化**、审批 HookRegistry **全 harness 共享不豁免**、子 lane **对界面不可见**（故必须有显式出口） |
| `AGENTS.md` §1.4 / §3.6 / §四 | 大户有体量闸（新逻辑必须压进新文件）；不许死入口；「库提供了函数」≠「库会调用它」（让模型看见清单必须应用自己拼提示词） |

## 2. 关键事实（代码实测，不是推测）

- 内核**原生支持同会话多 lane**（`harness.lane(name, {createAt}, context)`）；忙判定 **per-lane**；`lane.watch()` **按 lane 名过滤事件**——主 lane 的订阅**天生看不到子 lane**。
- `createAt` 是一条**条目 id 或 null**。内核**没有** subagent / task / spawn / delegate 工具，也**没有 lane 级 fork**；只有**会话级** `SessionRepo.fork`（产生新 session）。
- 所有 hook 入参都带 `{ lane, runId }` → 可按 lane 分流；`watchSession()` 类型在、运行时 `throw SliceNotImplemented`。
- 本仓 worker 注册 14 个工具（`read/write/edit/bash` + `browser×3` + `computer×2` + `memory_search` + `ask_user`），**无 subagent**。
- **唯一的子 lane 先例**：`/memory-tidy` → `harness.lane(TIDY_LANE)`（**不传 `createAt`** ⇒ 起点 `null`、自成一条链）。子 lane 的四条既有语义可直接继承：独立 transcript、`setActiveTools` 按 lane 持久化、审批共享、崩溃恢复按 lane 名重开。
- `transform_context` 是**唯一**能做「按 lane 换系统提示词」的地方；视图唯一出口 `pushView()`（流式期间每 50ms 全量重推）。
- `ConversationView` **无任何 lane 维度**；`streamingText` / `thought` 是单值、`running` 单布尔、`runningTools` 扁平（**多 lane 并行在契约上不可表达**）；遥测**只采主 lane**。
- 审批 / 提问队列键是 `sessionId + toolCallId`（**都无 lane 字段**）；`READONLY_TOOLS` 是免审批唯一真源，`ask_user` **不在**名单里、故必须在 `before_tool` **显式跳过**。
- ④ 子代理卡的副标题走 `describeTool` 的 `subagent` 分支（认 `title` / `task`），**不靠** `command` / `path`。

## 3. 关键决策（D1–D10）

### 决策一（D2）：执行模型 = **同会话多 lane，进程内**

不学「`repo.fork` 新 session + 第二个 harness」：① `TIDY_LANE` 已把「独立 transcript / 按 lane 白名单 / 审批共享 / 按名恢复」跑通，**零新机制**；② `repo.fork` 产出**新 session**（多一行会话记录、多一个 worker 进程、资源账要重算）；③ **并行是白拿的**（模型一条消息里发多个 `subagent` → 内核并发执行）。
代价如实记下：**所有 lane 共用一份 JSONL、共用一个进程**——worker 崩溃会带走所有在跑的子代理（不影响正确性：恢复循环按 lane 名重开）。

### 决策二（D3）：fork 语义 = **只有 `fresh`；`fork` 明确否决**

| | `fresh`（`createAt: null`） | `fork`（`createAt: 主 lane 当前 tip`） |
|---|---|---|
| 子代理看得见 | **只有 `task` 那段话** + agent 系统提示词 | 主对话**到该点为止的全部历史** + `task` |
| 本质 / 成本 | 一座空岛（TIDY 就是这种）；便宜 | 真实会话分叉点；每次委派**重放一遍主上下文** |

**否决 `fork` 的理由（不是「晚点做」，是「与目的冲突」）**：子代理存在的意义就是**隔离上下文**；`fork` 是**隐式整份复制**，把主对话的噪声与错误假设一起搬过去，还每次付一遍重放的钱。`fresh` 逼出来的是**显式、有损、由委托方决定什么重要**的交接。**落地口径**：v1 **连 `context` 参数都不暴露**。⚠️ 故 `lane-ownership.ts` 的过滤算法**只写 `fresh` 那一种**（整条链排除），**不要**预先写通用算法。

### 决策三（D5）：呈现 = **④ 活卡（含「中止」）+ 下钻；不新增页签、不自动展开**

被推翻的初版是「④ 工具卡 + 右栏**新增『子代理』页签**」——那是**同一件事两个入口**。**关键事实**：一次 `subagent` 调用在整个运行期都是一个 running tool，而 ④ 的运行中工具卡就是按 `runningTools` 渲染的，`ViewSubagent` 按 `toolCallId` 认领后把那张卡**特化**——承载已经存在。

| 场景 | 承载 | 数据 |
|---|---|---|
| 运行中 | ④ 的子代理卡（有界预览 + 运行态 + 卡面「中止」） | `view.subagents[]` 中 `status === "running"` |
| 已结束 | ④ 的卡（随 transcript 持久，运行态转完成、中止消失） | `view.subagents[]` + 工具卡 |
| 想看内部过程 | 点 ④ 卡「在右栏查看完整过程」→ ⑦ **下钻到子代理流**（面包屑 + ESC） | 按需拉完整 transcript |
| 审批 / 提问 | **仍在 ④ 主流**，加「来自 X」chip | 队列键不变（`toolCallId` 天然唯一） |

**不做「④ 内联完整流」**：④ 是叙述，嵌套叙述会淹没主线，且 ④ 的 turn 分组 / 消息窗口 / `TurnRail` 都假设一条线性流。**不自动展开右栏**（对齐 ⑦-D）：⑦-F 那次自动展开是给「外部对象」的，子代理是**模型自己发起**的、routine 起来会反复撑开用户右栏；「必须被看到」已由 ④ 的卡保证。

### 决策四（D6）：`subagent` **自身豁免闸门**，但它内部的工具**照拦**

否则同一件事弹两次卡（委派一次 + 内部工具各一次），用户会去关审批。**安全性不降**：`subagent` 的副作用**全部落在子代理的工具调用上**，那里照样过 `before_tool`——读是免审批的（`READONLY_TOOLS`），写 / 执行会弹卡 ⇒「免审批地委派一个只读调研」安全，「委派一个删目录的动作」会在子代理那层被拦下，**没有绕过路径**。**实现口径**（与 `ask_user` 同一处理，因其名字**不在** `READONLY_TOOLS`）：`before_tool` 显式跳过 + `after_tool` 的纵深防御显式豁免，**两处都要写**，漏一处就刷假告警。

### 决策五（D8）：计量拆成**两个判据**（费用计入、上下文占用不计）

现状一刀切：telemetry 把非主 lane 的 usage / toolCall **全部丢弃**——对 TIDY 没问题，对子代理就**变成静默**（用户付了钱却看不到）。

| 量 | 口径 | 理由 |
|---|---|---|
| `contextUsed`（上下文占用条） | **仍只算主 lane** | 子代理占用不该顶满**主**上下文条 |
| `usage` / `costUsd`（费用） | **全 lane 上报**，带归属 | 用户真的付了这笔钱，藏起来是静默（`ERRORS.md`） |

⚠️ 这是**对既有定调的推翻**（`SECURITY.md` 现有措辞是「子 lane 消耗不计入会话统计」），要同批改文档。DB 按子代理分组统计留 P4。

### 决策六（D10）：子代理条目**从分支树投影里排除**，且**禁止导航到它们**

lane 在持久化里**就是命名分支**；`fresh` 子 lane 起点是 `null` ⇒ 它的条目**自成一条根链**，会作为独立根节点出现在分支树投影里、且可点——一点就 `navigate` **把主 lane 指针挪到子 lane 节点上**（⚠️ 这条是读代码推断的，**P0 先只读验证**）。**修法**（纯函数 `lane-ownership.ts`）：子 lane 的条目 = 从 `tip_sub` 沿 `parentId` 上溯的那条链，从分支树排除；**纵深防御**：`navigate` 收到落在该集合里的 `targetId` 时拒绝并回可见错误。⚠️ v1.66 起分支树界面已删（规则见 `UI-REGIONS.md` ④-K），但 `session.navigate` 这条路**仍然连通**，风险**没消失**——决策本身（拒绝子 lane 节点、先挪指针后重拍快照、异常不吞）落在 `worker/lib/navigate.ts` 的 `applyNavigate`，由 `tests/navigate.test.ts` 覆盖。

### 决策七（D9）：视图只带**尾部**，完整流**按需拉**

视图每 50ms 全量重推，N 个子代理的**全文**会按推送次数乘上去（同「截图不进视图、落盘按需读回」）。故 `ViewSubagent.tail` = 流式文本 / 思考 / running 工具 / **最近 N 步**（带真实总步数）；完整 transcript 走**按需拉**的新通道 `session.subagentTranscript`（范式抄 `session.branches`：主进程 `pendingXxx` 队列 + 超时）。

### 决策八（D1 / D4 / D7）

| # | 决定 | 理由 |
|---|---|---|
| **D1 触发方** | **模型自主委派**（`subagent` 工具）；用户手动 `/subagent` 留 P4 | 隔离的价值主要在「模型自己判断该拆分时」 |
| **D4 身份** | lane 名 = `sub:${agentName}:${shortId}`，名字即持久身份 | 内核按 lane 名持久化配置与恢复，崩溃恢复白拿 |
| **D7 递归** | v1 **禁止 depth > 1**：白名单不含 `subagent` + 工具描述明写 + worker 守卫 | 递归 spawn 最容易失控（自我复制 + 费用失控） |

## 4. 契约变更（`shared/worker-protocol.ts`）

```ts
export interface ViewSubagent {
  id: string;                 // lane 名 = 稳定持久身份（D4）
  toolCallId: string;         // 主对话里那次 subagent 调用；④ 子代理卡的锚点
  name: string;               // agent 定义名
  title: string;              // 一句话任务摘要（④ 卡显示）
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: number; endedAt?: number;
  error?: string;             // 仅 failed 时有值
  tail: {                     // 运行中的**有界**尾部快照（视图每 50ms 全量重推，故必须有界）
    streamingText: string | null; thought: string | null;
    runningTools: ViewRunningTool[];
    recentSteps: ViewMessage[]; stepCount: number;  // 截断时如实给总步数
  };
  stats: { inputTokens: number; outputTokens: number; costUsd: number };  // D8
}
export interface ConversationView { /* …既有字段… */ subagents: ViewSubagent[]; }

// WorkerCommand
| { type: "subagentAbort"; id: string }        // 单子代理中止（P2）
| { type: "subagentTranscript"; id: string }   // 拉完整流（按需）
// 阻塞卡带上来源（P2）——队列键不变
| { type: "approvalRequest"; /* … */; subagent?: { id: string; name: string } }
| { type: "askUserRequest"; /* … */; subagent?: { id: string; name: string } }
```

⚠️ **不改 `ViewMessage`**：子代理的流**不混进主 `messages`**（否则 `groupTurns` 只认 role、会把两条 lane 的消息错并成同一轮）——隔离靠**独立承载**。
**新 IPC 通道** `session.subagentTranscript`：五处联动（`IPC_CHANNELS` / `IpcInvokeMap` / `IPC_EVENTS` / `IpcEventMap` / preload）；**视图本身搭 `session.view` 顺风车，零新事件**。
**常量放 `worker/lib/subagent.ts`，不放 `shared/limits.ts`**：`limits.ts` 的准入判据是「两侧不同值会**静默**出错」，本设计的上限**只有 worker 用**——但要**解释为什么不进**，免得下一个人照「两侧共享的常量」一律往里塞。

## 5. worker 侧编排

新增文件（全部有单测）：`worker/lib/subagent.ts`（工具工厂 + 编排 + 常量，入口薄）、`worker/lib/agent-defs.ts`（`.agents/agents/*.md` 发现 / 解析 / 同名取舍 + 目录块组装，**纯函数 + IO 分离**，对标 `skills.ts`）、`worker/lib/subagent-view.ts`（`LaneSnapshot → ViewSubagent` 投影 + 尾部截断，**纯函数**）、`worker/lib/lane-ownership.ts`（「哪些条目属于子 lane」，**纯函数**）。⚠️ **体量闸**：以上全落新文件，`entry.ts` 只留**装配一行 + `case` 一行委托**。

**一次 `subagent` 调用的生命周期**：`before_tool` 豁免闸门（D6）→ `execute()`：① 解析 agent 定义（名字不存在 → `throw` 并给出可用名，对标 `@shared/skill-error`）；② 守卫：depth（本 lane 不能再开）、并发上限、主 lane 是否已在跑；③ lane 名 `sub:${agent}:${shortId}`，`harness.lane(name, { createAt: null }, context)`（fresh）；④ `lane.setActiveTools(agentTools)`（硬白名单）；⑤ `lane.watch`；⑥ 注册进 subagents 表 + `pushView()`（④ 卡立刻可见）；⑦ `await lane.prompt(task, undefined, context)`；⑧ 终态 → `pushView()`、退订、返回工具结果（结论文本 + 诚实 details）。

⚠️ **失败有两条路径，缺一不可查**（`Result.err` 的 `LaneBusy` / `Closed` / accept 被拒；以及 `Result.ok` 但 `record.status` 为 `failed` / `aborted`）——`compact` / `memoryTidy` 已踩过两次，不查就是「点了没反应」。

**系统提示词归属**（`transform_context` 加**第三个**分流）：main = 基础提示词 + 技能清单 + AGENTS.md + 记忆（现状）；`memory-tidy` = `memoryTidySystemPrompt`；**`sub:*` = agent 定义正文 + AGENTS.md 块，不注入记忆、不注入技能清单**（记忆是主对话的沉淀优势，注入等于把父的上下文偷渡给子代理；技能清单会暗示「你可以调技能」而子代理工具面是硬白名单 ⇒ **死入口**）。

**让模型看见子代理（必须显式做）**：内核**不会**自动往提示词里放 agent 目录（同 `formatSkillsForSystemPrompt` 的教训：**只导出、不调用**）。故在主 lane 的 `transform_context` 里拼一个 `<available_subagents>` 块：有界（`MAX_AGENT_CATALOG_CHARS`）、**只在主 lane 注入**；**判据必须落在最终产物上**（断言组装后的提示词字符串里真的出现了清单）。

**agent 定义**（声明式，对标 skills）：`<cwd>/.agents/agents/<name>.md`（项目级优先）+ `~/.agents/agents/<name>.md`（用户级），frontmatter 含 `description`（必填）+ `tools`（逗号分隔），正文 = 该子代理的系统提示词。名字取**文件名**；同名取舍与遮蔽**如实告知**。内建兜底两个：`researcher`（只读白名单）、`general`（默认工具集）。⚠️ **实现前先确认内核是否导出 frontmatter 解析器**；没有就写**极简解析**（只认 `key: value` 与逗号数组）并注明「不是完整 YAML」，**不要为此引新依赖**。

**超时与「总结交接」**（2026-09）：墙钟上限 **30 分钟**（原 10 分钟——「读十几个文件 + 跑几轮测试」的调研在 10 分钟里常被砍在半路，而 cut 掉的那次连结论都拿不到；上限真正的作用是兜住跑飞的那一路，不是压着它快点干完）。
到点**不立刻杀**，而是先 `lane.steer(handoffInstruction())` 要一份**总结交接**（结论与依据 / 已做的改动与状态 / 没做完的与卡点 / 接手的人下一步），给 **2 分钟**收笔窗口；窗口内写完了，run 正常结算，只是结果文本与卡面都**如实改名**（结果文本「时间上限后收笔…任务不一定做完」、④ 卡「已交接（到时间上限）」、颜色琥珀而非绿）；窗口也过了才 `abort`，中止后仍不返回再等 30s 就停止等待（把并发额度还回去）。
三段时序抽在 `worker/lib/subagent-handoff.ts`（**注入定时器、可单测**）——30 分钟的墙钟不可能在冒烟里等，而这是最容易写错的一段；`tests/subagent-handoff.test.ts` 用假时钟逐拍验「到点只 steer 不 abort」「窗口过了才 abort」「写完了 cancel 之后彻底安静」。
**如实口径**：`ViewSubagent.handedOff` 是「为什么结束」的补充，**不是第五种状态**（`status` 仍是 running / completed / failed / aborted）。把一份半途的交接显示成「完成」，就是让调用方把它当交付物——那是本仓最贵的一类错误（持续撒谎，见 `ERRORS.md`）。

## 6. 分支树与导航（D10 的落地）

- **P0 先验证**：只读探针跑一次 `/memory-tidy`，前后 dump `session.branches`，看是否多出根节点（**验证先于修复**）。探针若证明无此问题，修法降级为「预防子代理引入」。
- **过滤**：`lane-ownership.ts` 导出 `ownedEntries(tipId, entries)`（`fresh` 专用），`projectBranches` 在交给 `projectBranchNodes` **之前**把子 lane 的条目剔除。
- **导航守卫**：收到落在该集合里的 `targetId` → 拒绝 + 可见错误。**TIDY 同批处理**（它同样 `createAt: null`）。

## 7. 计量（D8 的落地）

`telemetry.ts` 拆两个判据：`contextUsedFromUsage` 保留 `MAIN_LANE` 过滤；`buildUsageUpload` / `ToolCallTracker.end` **去掉** lane 过滤并**带上归属**。`WorkerMessage.usage` 增 `subagentId: string | null`（主 lane 为 `null`）；`ViewSubagent.stats` 由子 lane 自己的 usage 事件累加。同批改 `SECURITY.md` 措辞（「子 lane 消耗不计入会话统计」→「费用计入，上下文占用不计」）。

## 8. 工具定义（`worker/lib/subagent.ts`）

- **命名** `subagent`；**入参**（typebox，照 `memory-tool.ts`）`agent: string`（必填）、`task: string`（必填）、`title?: string`（缺省取 `task` 首行）；**v1 不暴露 `context`**（D3）。
- **`description` 是本仓唯一的引导落点**，两件事必须教：① **`task` 要自包含**（背景 / 目标 / 交付物 / 约束——`fresh` 看不见主对话，写不清必然空转）；② **何时该委派**（只在任务能整包交出、且隔离有收益时）。
- **`execute`**：**不需要 `bridge`**（本进程内直接操作 harness）。返回结论文本 + **诚实的过程收据**（用了哪些工具 / 看了哪些文件 / 改动几处 / 是否被中止）——否则委托方分不清「真做完了」和「放弃了随便答一句」，只会重试，重试就是钱。
- **校验失败走 `throw`**（`AgentToolResult` 没有 `isError`，返回文本会被当成工具成功）；失败文案必须给**正确写法**。
- **不进 `READONLY_TOOLS`**（D6），改为在 `before_tool` / `after_tool` 里**显式**处理。

## 9. 渲染层

| 位置 | 内容 | 复用 |
|---|---|---|
| ④ | `subagent` 工具卡**特化**：`子代理 · <name>` + 任务一行 + 状态点 + 耗时 + **运行中时的「中止」**；展开 = **有界预览**（最近 N 步）；「在右栏查看完整过程」 | 工具卡骨架 |
| ~~⑦「任务摘要」此刻段~~ | **v1.53 已移除**（与 ④ 的运行中工具卡重复列；「中止」随之挪到 ④ 卡上） | — |
| ⑦ 下钻 | 子代理的**完整流**（面包屑 + ESC，复用下钻栈） | 既有下钻语言 |
| 阻塞卡 | 标题加「来自 `<子代理名>`」chip | `ApprovalCard` / `QuestionCard` |

**数据来源** `view.subagents`（**零新事件**）；完整流走 `session.subagentTranscript`（按需）。**不做** ⑦-F 自动切页签 / 自动展开；**不改** `DockKind`；**不进**「+」菜单。**冒烟钩子** `data-subagent-*`，**不要用 class 断言**。⚠️ **下游两处不同步就静默失效**：`lib/stable-view.ts`（**逐字段覆盖契约**，漏一个就「后台变了、界面纹丝不动」，由 `tests/stable-view.test.ts` 守着）+ `view-cache.ts`。

## 10. 分批实施

| 批 | 内容 |
|---|---|
| **P0 地基** | ① 只读探针验证分支树 lane 污染（含 TIDY）；② `lane-ownership.ts` + `projectBranches` 排除 + `navigate` 守卫；③ 契约加 `subagents` / `ViewSubagent`；④ `telemetry.ts` 拆两个判据（+ 改 4 条既有断言与 `SECURITY.md` 措辞） |
| **P1 能力** | `agent-defs.ts` + `subagent.ts`（lane / watch / abort / timeout / depth）+ 目录块注入（**无 UI**）——先在没有界面干扰时把「工具 → lane → 视图」验掉 |
| **P2 呈现** | ④ 卡特化 + 卡面「中止」+ 下钻 + 阻塞卡来源 |
| **P3 总览收口** | `session.subagentTranscript` 按需拉 + 下钻内容层 + `subagent` 冒烟模式 |
| **P4 可选** | 归属分组统计、用户手动 `/subagent`、**（不排期）**`fork` 上下文模式 |

⚠️ **体量闸**：`worker/entry.ts` 与 `main/session-manager.ts` 是已知大户——动手前按 `AGENTS.md` §1.4 先量净增、先决定搬哪块。**与 `todo` 的排期耦合**：两者都改 `FollowPanel.tsx`，谁都不要把对方的段落删掉。

## 11. 验收

- **单测**：`agent-defs`（frontmatter 解析 / 同名遮蔽 / 目录块有界截断）、`lane-ownership`（`fresh` 子链整条排除、主对话一条不误伤、多子代理并存、TIDY 与子代理同时存在）、`subagent-view`（投影 / 尾部截断**如实给总步数** / 终态映射）、`telemetry`（**改现有 4 条断言** + 新增「`contextUsed` 仍只算主 lane」）；**判据落在最终产物上**（系统提示词字符串里有 `<available_subagents>`）。
- **冒烟 `subagent`（免模型）**：受控视图带 `subagents` → ④ 出现子代理卡、展开看到有界预览；**此刻动作只在 ④**；**「中止」在 ④ 卡面**且真的落在可视区；已结束后不再给「中止」但卡仍在；点 ④ 卡出口 → 下钻子代理流（面包屑 + ESC）；**分支树里没有子代理条目**、**导航到子代理条目被拒**（D10 硬判据）；`subagent` 调用**不弹卡**、内部 `write` **弹卡**（在 `sessionManager` 上**打桩计数**，只记账、不转发）；主会话 `abort` → 在跑的子代理全部转 `aborted`。⚠️ 断言小目标入口要**命中测试**。
- **打模型 e2e `subagent-e2e`**（**已建已实测** 15/15）：做法同 `ask-user-e2e`（**worker 生死交渲染层**，**不要**直连 `session.open` 抢 worker）。落实：① 模型真按名调 `subagent` ✅；② `fresh` 真隔离（主对话密语**缺席**子代理 transcript）✅；③ 结果作为工具结果回主 lane ✅；④ 递归被拒的**模型侧 e2e 仍未建**（白名单 + 提示词 + depth 守卫只有单测与代码审查）；⑤ 费用归属有 stats 字段（本地 Ollama 不计费，未验计费通道本身）。⚠️ 小模型（0.6b）服从是概率事件——「发 prompt → 等内部 write」整条可重试至多 3 次，主 lane 绕过委派直接 write 会被拒并指路，断言不放水。
- **明确不覆盖**：`fresh` + `task` 单一通道的「任务描述能力上限」（只能靠 e2e 观察，**不是设计阶段能拍掉的**）；内核的工具并发策略（设计不依赖，未实测）；worker 意外崩溃那一支的收尾；分支树污染（P0 探针若证伪则降级为「预防」，**如实记录结论**）。

## 12. 明确不做

- **`fork` 上下文模式**（D3：与隔离目的冲突）；**`repo.fork` 新 session + 第二个 harness**（D2：资源账更贵）；**递归子代理（depth > 1）**（D7）。
- **扩展宿主层 / `promptSnippet` / `renderCall` / TUI overlay**（本仓没有对应物，见 `ARCHITECTURE.md` §四）。
- **新增右栏「子代理」页签**（D5：与 ④ 重复列）；**子代理启动自动展开 / 自动切右栏**（违反 ⑦-D，且「被看到」已由 ④ 卡保证）。
- **子代理的流混进主 `messages`**（会把两条 lane 的消息错并成同一轮）；**子代理内联完整流到 ④**（要另写一套渲染）。
- **为 `fork` 预写通用过滤算法**（D3：为不存在的需求修路）；**给模型的错误文本 / 内核错误字符串当判据**。
- **子代理清单 / 多会话监控 / 整项目树**（与 `DESIGN-todo.md` 同一条）。

## 13. 决策台账

| # | 决策 | 状态 |
|---|---|---|
| D1 | 触发方 = 模型自主委派（用户手动留 P4） | ✅ |
| D2 | 执行模型 = 同会话多 lane（进程内），不用 `repo.fork` | ✅ |
| D3 | **只有 `fresh`；`fork` 否决**，v1 不暴露 `context` 参数 | ✅ |
| D4 | 身份 = lane 名 `sub:${agent}:${shortId}` | ✅ |
| D5 | 呈现 = ④ 活卡（含卡面「中止」）+ 下钻；无新页签、不自动展开 | ✅ |
| D6 | `subagent` 自身豁免闸门、内部工具照拦（无绕过路径） | ✅ |
| D7 | 禁止递归（depth = 1） | ✅ |
| D8 | 费用计入（带归属）、上下文占用只算主 lane | ✅ |
| D9 | 视图只带有界尾部，完整流按需拉 | ✅ |
| D10 | 分支树排除子 lane 条目 + 禁止导航到它们 | ✅ |

**已完成的文档动作**：`GLOSSARY.md` 已补「子代理 / fresh」词条（并标明与 `ARCHITECTURE.md` 的「不 fork **内核仓库**」是**同词异义**）；`SECURITY.md` 已改计量措辞并补子代理边界论证；`NEXT-PHASE.md` §3.2 能力表 ⑤ 已标「已实施」并指向本文件。
