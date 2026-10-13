# Colt 架构抽象设计评审（纯源码分析）

> 本报告仅依据 `src/` 与内核 `node_modules/@earendil-works/pi-agent-core/dist/` 的源码得出，
> 未参考任何 md 文档。分析时间：2026-10-11。代码规模：`src/` 下 181 个 ts/tsx 文件。

---

## 一、进程拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer（React 19，sandbox 无 Node，渲染 agent 产出的 Markdown） │
│  App.tsx(1545行) ── features/Conversation/index.tsx(1780行,42 hooks)│
└──────────────▲────────────────────────────────┬─────────────────┘
               │ events（10 个推送通道）          │ invoke（66 个调用通道）
┌──────────────┴────────────────────────────────▼─────────────────┐
│  Preload（41 行）：唯一桥，双白名单（通道 + 事件），编译期键对齐断言   │
└──────────────▲────────────────────────────────┬─────────────────┘
               │                                │
┌──────────────┴────────────────────────────────▼─────────────────┐
│  Main（Electron 主进程，server host 角色）                          │
│  index.ts      启动 / 单实例锁 / 窗口 / 导航拦截                    │
│  ipc/index.ts  66 个通道的路由与信任边界（912 行）                  │
│  session-manager.ts  会话进程池 + 视图漏斗 + 审批接线（1675 行）    │
│  approval/     store(内存队列) · policy(启发式) · analyzer(LLM复核) │
│  host/         HostBridge → browser / computer / memory / terminal │
│  db/           colt.db（node:sqlite WAL）+ memory.db（派生索引）    │
│  secrets.ts    safeStorage 加密的 secrets.json                    │
└──────────────▲──────────────────────────────────────────────────┘
               │ utilityProcess.postMessage（WorkerCommand / WorkerMessage）
┌──────────────┴──────────────────────────────────────────────────┐
│  Worker × N（每会话一个 utilityProcess，池上限 6，空闲 30min 回收） │
│  entry.ts(1069行)：harness 装配 + 4 类 hooks + 24 种命令分发        │
│  lib/ ×35：skills · memory · subagent · mcp · diagnose · baseline… │
└──────────────▲──────────────────────────────────────────────────┘
               │
┌──────────────┴──────────────────────────────────────────────────┐
│  内核 pi-agent-core：AgentHarness / Lane / Hooks / JsonlSessionRepo│
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、分层抽象

### L0 · 契约层（`src/shared/`，单一真源）

- `protocol.ts`（1314 行）：渲染↔主进程契约。`IpcInvokeMap` 是类型真源，`IPC_CHANNELS` 是运行时白名单，二者由编译期 `ChannelParityChecked` 双向对齐断言锁死；事件同理。
- `worker-protocol.ts`（718 行）：主↔worker 契约。`WorkerCommand`（24 种）/`WorkerMessage`（20 种）两个判别联合 + `ConversationView`（渲染层唯一数据结构）。
- 其余为纯函数小模块（model-ref、thinking-level、mcp-config、todo、limits……），三方共用。

### L1 · 主进程（`src/main/`）——信任锚点

| 模块 | 职责 |
|---|---|
| `ipc/index.ts` | 通道路由；`resolveSessionRoot` 只按 sessionId→项目反查根目录，**绝不接受渲染层给的路径** |
| `session-manager.ts` | worker 池（上限 6 + 30min 空闲回收 + 图钉）、视图漏斗（DB 覆盖 + 推送）、审批超时与通知、提问队列接线 |
| `approval/` | `store`（内存待审队列 + 会话级规则/模式）→ `policy`（只读白名单 + 越界判定 + 风险分档）→ `analyzer`（auto 模式下另起一次 LLM 复核，fail-closed） |
| `host/` | `HostBridge` 统一分发 4 种宿主能力：browser（WebContentsView + 观测缓冲）、computer、memory（检索）、todo |
| `db/` | colt.db：projects / sessions / usage / tool_calls / file_changes / file_baselines / todos / session_events / approval_audit / providers / settings |
| `secrets.ts` | safeStorage 加密落盘，原子写 |

### L2 · Worker（`src/worker/`）——每会话一个进程

`entry.ts` 一次 init 完成全部装配：

```
模型注册 → JsonlSessionRepo 续接 → 诊断控制器 → 技能装载（3 层目录）
→ 子代理定义 → AGENTS.md → 双级记忆 → MCP 连接 → AgentHarness.create
→ 注册 4 类 hooks：
   before_tool       审批闸门（阻塞等主进程答复）+ 改动前抓基线
   transform_context ×2  临时提醒注入 / 每请求重拼系统提示词
   after_tool        ×3  纵深防御告警 / 写后诊断 / 文件改动记账
→ lane 愈合（模型 / 思考等级 / 工具清单三处持久化值对齐）
→ watch 快照 → 50ms 节流 + SHA-256 去重 → 推送 ConversationView
```

### L3 · 渲染层（`src/renderer/`）

- `App.tsx`：侧栏（空间/任务两栏、搜索、归档、图钉）、全局事件监听（view/status/approval/question）、主区三视图（chat/changes/settings）。
- `Conversation/index.tsx`：消息流 + 输入区 + Live Bar + 右侧 Dock 页签（浏览器/文件/终端/统计/规则…），`key={sessionId}` 重挂载 + `view-cache.ts`（模块级 LRU 30 份）消灭切回白屏。
- 无状态框架（无 redux/zustand），状态 = React hooks + IPC 事件订阅。

### 持久化三分

| 存储 | 内容 | 真源归属 |
|---|---|---|
| JSONL（内核管） | 会话消息本体，seq 严格递增 | 内核，双写即毁（单实例锁的根因） |
| colt.db | 元数据 + 派生（改动/用量/基线/待办/审计） | 主进程唯一写入 |
| memory.md ×2 + memory.db | 记忆文件是**真源**，memory.db 是派生检索索引 | worker 写文件，主进程维护索引 |

---

## 三、三条核心链路

### 链路 1：发消息到看到流式回复

```
Renderer.invoke("session.prompt")
  → ipc: materializeDraft（草稿此刻才落库）→ reviveIfArchived
  → sessionManager.promptOrReconnect（worker 被回收则透明重建）
  → worker: lane.prompt → 内核流式事件 → watch 快照 → scheduleFlush(50ms)
  → pushView：图片落盘 → project() 投影 → SHA-256 去重 → 发 "view"
  → main: #withDbChanges 用 DB 覆盖 fileChanges/todos/contextUsed → 转发
  → renderer: setView → useStableView 稳定化 → 渲染
```

### 链路 2：工具审批（安全命脉）

```
worker before_tool（lane 阻塞）
  → approvalRequest → main ApprovalStore.evaluate
     ├─ precheck（用户已接管浏览器则直接否）
     ├─ policy：只读白名单 → allow；越界/危险 → ask；moderate → 看模式
     ├─ auto 模式 → analyzer 另起一次 LLM 复核（15s 超时，fail-closed，
     │              审计无条件落库，用量独立记账）
     └─ ask → 待审卡片 + 任务栏闪烁 + 系统通知 + 5min 超时兜底
  → approvalResult → worker 解除阻塞 / block
```

### 链路 3：宿主能力 RPC

```
worker 工具（browser_act 等）→ HostBridge.callHost → "toolRpc"
  → main tool-rpc.ts → HostBridge.handle → 具体 Host 执行
  → "toolRpcResult" → worker settle（回发前再校验 entry 仍是当前进程）
```

---

## 四、不合理设计（按严重度排序）

### ✅ 1. 明文 API Key 经环境变量泄漏给 agent 的 bash 工具 —— **已闭环（2026-10-11）**

**证据链**：
- `session-manager.ts:802-808`：fork worker 时 `env: { ...process.env, DEEPSEEK_API_KEY: providerKey, COLT_PROVIDER_KEY: providerKey }`。
- 内核 `harness/tools/bash.js:33`：`inheritEnv: true`。
- 内核 `harness/env/nodejs.js:193-201` `getShellEnv`：`{ ...process.env, ...baseEnv, ...extraEnv }`——**worker 的全部环境变量原样铺进每次 bash 执行**。

**后果**：模型只需 `bash: echo $COLT_PROVIDER_KEY` 就能拿到明文密钥。`secrets.ts` 文件头宣称「明文只在内存与 worker 进程环境变量中存在」，但环境变量对 worker 派生的**每个子进程**都可见——「在环境变量里」并不等于「模型够不到」。而且 `...process.env` 把用户 shell 的**全部**环境变量（可能含其它服务的 token）一并带进了这条链。

**修法**：worker env 只透传白名单变量（PATH、SYSTEMROOT 等必需品）；密钥改为 worker 启动后经 `init` 命令的消息体传入并只存内存，或派生一个不含密钥的 scrubbed env 专供 NodeExecutionEnv。

**落地情况（按上条修法逐条对齐）**：
- worker env 改白名单投影：`main/lib/worker-env.ts` 的 `buildWorkerEnv`（含 Windows 定位 Git Bash 与代理变量；显式排除 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE` / 宿主私有变量），`session-manager` fork 处不再有 `...process.env`。
- 密钥改经 **`init` 消息体的 `apiKey` 字段**传入（`shared/worker-protocol.ts`）；`setModel` 同样带 `apiKey`（跨 provider 切换要现装）。`provider-factory.ts` 不再有 `envApiKeyAuth`，改闭包内存密钥 `memoryApiKeyAuth`——**任何环境变量都读不回密钥**（`tests/provider-factory.test.ts` 有对抗用例）。
- 回归钉子：`tests/worker-env.test.ts`（白名单 / 缺键不产 `undefined` / 控制变量塞密钥名直接抛错）。

### ✅ 2. `git.status` 破坏统一的信任边界 —— **已闭环（2026-10-11 晚）**

**证据**：`ipc/index.ts:821` —— `handle("git.status", (request) => readGitStatus(request.cwd))`，cwd **直接来自渲染层**。

同文件里 `resolveSessionRoot`（80-88 行）明确写着「绝不接受渲染层传入——渲染层会渲染 agent 生成的 Markdown，是不可信来源」，且 `file.read` / `git.committed` / `terminal.open` 全都遵守；唯独 `git.status` 让渲染层自己报路径。虽然 git status 只读、直接危害小，但它破坏了「根只能由主进程反查」这条不变量——下一个照抄这条通道写法的人未必只读。

**落地情况**：请求形状改为 `{ sessionId }`（`shared/protocol.ts`），主进程按 `resolveSessionRootOrDraft` 反查——渲染层不再提供任何路径。

⚠️ **原文说的「改成 `resolveSessionRoot(request.sessionId)` 即可」低估了改动面**，实施时发现两件事：
1. **契约里没有 sessionId**（只有 `cwd`），所以要动三处：契约请求形状 / ipc handler / 渲染层调用点（`Conversation/index.tsx`）；
2. **草稿会话必须单独处理**：会话要等首条消息才落库（`materializeDraft`），而「新建后还没发消息」恰是最想看「我在哪个仓库」的时刻——直接用 `resolveSessionRoot` 会抛「会话不存在」，git 分支 chip 在草稿态**静默消失**。故新增 `resolveSessionRootOrDraft`：查库落空时按草稿的 `projectId` 取项目根（与渲染层对草稿显示的 `cwd` 是**同一个值**），两者都没有才答「不是仓库」。

**顺带排掉一个坑**：不能把空串/`undefined` 丢给 `readGitStatus` 当哨兵——`resolve("")` 是**主进程自己的 cwd**，开发态下会向上找到本仓的 `.git`，于是一个「未知会话」会显示成与用户毫不相干的分支。故 `git.ts` 导出 `NOT_A_REPO_STATUS` 常量，调用方复用它。

**回归钉子**：`tests/contract.test.ts` 的「信任边界：文件系统根只由主进程反查」——三条断言（契约请求无路径字段 / handler 不收 `request.cwd` 且草稿感知真的读 `drafts` / 渲染层只传 sessionId）。已按本仓惯例验证过它**有牙**（把 `cwd` 放回契约即变红）。

### 🟠 3. 体量闸已退化为纯台账，god 对象无人看守

**证据**（`tests/size-guard.test.ts` + 实测）：

| 文件 | 现状 | 闸的状态 |
|---|---|---|
| `Conversation/index.tsx` | 1780 行 / **42 hooks**（上限 50，一度 81） | 棘轮已删，只剩通用 2200 |
| `session-manager.ts` | 1675 行 | 同上 |
| `worker/entry.ts` | 1069 行 | 同上 |
| `host/browser-host.ts` | 1026 行 | 同上 |
| **`App.tsx`** | **1545 行，未登记进 `KNOWN_LARGE_FILES`** | 连台账都没有 |

2026-09-20 四条棘轮统一到 2200 后与通用上限同值，「许降不许升」的约束力实际归零——从 1780 涨到 2200 有 420 行的无人区。`App.tsx` 1545 行（侧栏状态机 + 搜索 + 归档 + 图钉 + 双队列跟踪全在一个组件里）却不在大户名单上，是登记盲区。

### 🟠 4. 同一份状态存三份，镜像链脆弱

待办清单的流向：`todos` 表（真源）→ 主进程 `#todosCache` → 视图推渲染层 → **同时**整份镜像 `todoSnapshot` 推给 worker 的 `todoMirror`（供 `transform_context` 同步注入）。fileChanges 同理（DB + `#fileChangesCache` + 视图覆盖）。

这不是错误——worker 注入必须同步、渲染层必须有缓存——但三段缓存各自有独立的失效纪律（写入点失效 / ready 补发 / 视图覆盖），任何一处漏掉都是「界面有、模型忘了」的静默错。本质上是在为「transform_context 必须同步」这一个内核约束付出三份一致性成本。更省的做法：worker 注入改走「启动时拉一次 + 工具结果里回显增量」，砍掉常驻镜像。

### 🟡 5. 全量快照 + SHA-256 去重：省的是 IPC，序列化成本照付

`worker/entry.ts:271-280`：每次 flush 先 `JSON.stringify` **整份** ConversationView 再算 SHA-256，相同才跳过。注释说「2937 条消息的会话不能把整份序列化结果常驻内存」——但**每次 flush 仍然全量序列化了一遍**（算摘要是必须的输入）。流式期间每 50ms 对数千条消息做一次全量 stringify + hash，这正是想省掉的 CPU。省掉的只是「相同内容跨进程搬运」，序列化本身一次没少。增量协议（或至少对 messages 尾部做局部指纹）才是正解；当前形态在超长会话 + 高频流式下会烧在 worker 主线程上。

### 🟡 6. 会话标题在两处各算一遍

- `session-manager.ts:874-876`：view 到达时取首条 user 消息前 30 字 `touchSession` 落库；
- `App.tsx:316-336`：`session.view` 监听里用**同一条规则**再算一遍更新侧栏缓存。

同一个派生规则写在两个进程里，改一处忘另一处就是界面与侧栏标题不一致。标题计算应收在投影层（worker `project()`）或主进程一处，渲染层只消费。

### 🟡 7. FIFO 队列配对无关联键，四类查询两种设计

`pendingBranches` / `pendingMcp` / `pendingSkills` 用「FIFO 最早的等待方吃掉回复」配对，**回复消息里没有请求 ID**；而 `pendingTranscripts` 却是按 `id` 精确配对。同一个 entry 上两种范式并存，且前者隐含「worker 严格按序回复且不多回」的假设——这个假设写在了注释里而不是类型里。统一成带 requestId 的配对（transcripts 已经是范本）可以删掉一整类时序隐患。

### ✅ 8. 审批分析器与被审对象同源 —— **已闭环（2026-10-11）**

`analyzer.ts` 用**会话同一个 provider、同一个模型**复核该模型自己发起的工具调用。注释已承认「分析结论可能被入参里的提示注入影响」并靠审计落库兜底，但同模型复核同模型的方案，对「模型被注入后自我放行」没有防御纵深。可考虑：分析器固定用一个便宜的独立模型（可配置），或至少允许用户为分析器指定不同 provider。

**落地情况**：设置项 `approval.analyzerModelRef`（`main/approval/config.ts`）+ IPC `approval.analyzerModel.get/set`；解析见 `main/approval/analyzer-model.ts`（缺省 = 会话模型；指向的服务/模型已失效则**回落到会话模型并如实提示**，不静默）。密钥由主进程从 secrets 直接取，不经 worker。费用按**实际用的那一家**记账（否则「哪个服务在花钱」永远答不准）。设置界面按计划**未做**（本包只做存储 + IPC + 消费），留待单独排期。

### 🟢 9. 小项

- `MAX_WORKERS = 6` / `IDLE_TIMEOUT_MS = 30min` / `view-cache MAX_ENTRIES = 30` 等全部硬编码，无设置面。
- `worker-pool.ts` 已把回收决策抽成纯函数（好），但 `evictionVictim` 返回 `undefined` 时由调用方抛错——决策与错误文案分离，两处要保持同步。
- 渲染层 `view-cache` 常驻 30 份全量视图快照，长会话单份可达数 MB，无总量上限（只有份数上限）。

---

## 五、做得对、值得保留的设计

- **契约单一真源 + 编译期双向对齐断言**（protocol.ts 的 `ChannelParityChecked`）——白名单与类型不可能漂移。
- **信任边界集中在主进程**：路径根一律由 sessionId 反查（🔴2 闭环后**已无例外**）；图片/文件读盘按 id 推导路径，渲染层无从指定。这条不变量现在有守卫：`tests/contract.test.ts` 的「信任边界：文件系统根只由主进程反查」。
- **审批链 fail-closed**：worker hook 抛错即 block、分析器失败转人工、双端独立超时、审计无条件落库。
- **草稿延迟落库**、单实例锁防 JSONL 双写、dispose 宽限后强杀——都是从事故里长出来的正确形态。
- **「如实呈现」原则在数据层有落点**：净值算不出写 NULL 而不是 0、MCP/技能的 `live: false` 区分「没开」与「没有」。

---

## 六、复核记录（2026-10-11 深夜）

🔴1 与 🟡8 闭环的当天，把**其余每一条**重新拿代码证了一遍（不是照抄原判断）。

**复核为「仍未解决」**（每条都重新看过代码，不是照抄原判断；🔴2 已在这次复核之后闭环，见其小节）：

| 项 | 复核证据 |
|---|---|
| ~~🔴2 `git.status`~~ | ✅ **已闭环（同日更晚）**：契约改收 `sessionId`，主进程按 `resolveSessionRootOrDraft` 反查（含草稿态）；见 §四-2 的落地情况与钉子 |
| 🟠3 体量闸退化为台账 | `App.tsx`（1545 行）原先**不在** `KNOWN_LARGE_FILES`——**同日已补登记**；棘轮仍是「与通用上限同值 2200」 |
| 🟠4 待办三份镜像 | `entry.ts:254/555/846` 的 `todoMirror` 仍在（主进程推送整份 → worker 常驻注入） |
| 🟡5 全量快照 + SHA-256 | `entry.ts:279`：`createHash("sha256").update(JSON.stringify(view))`——**每次 flush 仍全量序列化**，省掉的只是跨进程搬运 |
| 🟡6 标题两处各算一遍 | ✅ **已闭环（同日更晚）**：收归 `@shared/session-title` 的 `deriveSessionTitle`，两处都调它（`session-title.test.ts` 有「不许再内联」的守卫）。**顺带修掉一个同源的显示缺陷**：技能调用（内核替用户发的）正文是原始标记 `<skill name=...>`，而标题直接取 text → 从 `/` 菜单选技能开一个会话，侧栏标题就是一串 XML。会话目录与分支树早就统一用 `skillInvocationLabel` 显示成「技能 pdf」，标题这处是漏的——现已三处同源。这是**行为变更**（标题内容变了），单独记一笔 |
| 🟡7 FIFO 配对无关联键 | `pendingBranches` / `pendingMcp` / `pendingSkills` 仍是 FIFO；同 entry 上 `pendingTranscripts` 仍按 id 精确配对——两种范式并存 |

**🟠3 的台账数字已过期**（当天两批交付合计改动了其中几个文件，复核时实测）：

| 文件 | 报告快照 | 复核实测 |
|---|---|---|
| `Conversation/index.tsx` | 1780 行 / 42 hooks | 1784 行 / 47 hooks（计数口径见 `size-guard.test.ts` 注释） |
| `session-manager.ts` | 1675 行 | **1755 行**（+80：三缺口 53 + 压缩设置 27） |
| `worker/entry.ts` | 1069 行 | **1120 行**（+51：三缺口 35 + 压缩设置 16） |
| `host/browser-host.ts` | 1026 行 | 1027 行 |
| `App.tsx` | 1545 行 | 1548 行（标题派生收拢，+3）——**已登记进 `KNOWN_LARGE_FILES`** |
| `features/Settings.tsx` | （原报告未列） | **1443 行**（压缩设置一节 +131）——也在向大户靠，值得盯 |

> 快照本身不算错，但**这些数字被当作「净增行数」的基准在用**（`AGENTS.md` §1.4 要求碰大户前先算），
> 所以标注出增量比保持旧数字更诚实。

**顺带修掉的一处自相矛盾**：`docs/SECURITY.md` 与 `src/main/secrets.ts` 里「明文密钥存在于 worker 进程环境变量」的旧表述，已在 🔴1 闭环那一轮改掉；
但**本文件 🔴1 的「修法」段保留着原文**——读的人容易只看那一段就以为密钥还在 env 里。以它下面的 `落地情况` 为准。
