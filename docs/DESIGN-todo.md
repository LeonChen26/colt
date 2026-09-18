# todo 设计草案

> **状态**：**已实施**（2026-09-19）。界面归属见 `UI-REGIONS.md` **v1.48**
> （⑦ 默认视图更名**任务摘要**，清单是它的**第一段**；② 不加常驻入口）。
> **落地落点**：契约 `shared/todo.ts` / 状态机 `main/todo-store.ts` / 工具 `worker/lib/todo-tool.ts` /
> 表 `todos`（`main/db/`，schema v10）/ 界面 `FollowPanel.tsx` 第一段。
> **验收**：单测 `tests/todo-store.test.ts`（63 条）+ `tests/migration.test.ts` 的 v10；
> 冒烟 `COLT_SMOKE_MODE=todo`（26 条，**免模型**）。
> **未覆盖**（别当成验过了）：镜像 → `transform_context` 的每请求注入只有 `todo-e2e`（打模型）能覆盖（见 `NEXT-PHASE.md` §3.2）；worker 意外崩溃那一支的收尾。
> **一句话**：给模型一个「先把复杂任务拆成清单、再逐条推进、随时能查到进行到哪」的账本——
> 清单**落 SQLite**、由**主进程独占写入**、界面搭 `session.view` 顺风车显示在 ⑦ 的默认视图里，
> 模型侧靠**每请求注入**持续看得见。
> **配套**：动手前读 `docs/ARCHITECTURE.md`（加 IPC 通道 / worker 命令 / 宿主能力的流程）、
> `docs/PRINCIPLES.md`（#1 #8）、`docs/SECURITY.md`（免审批边界）、`docs/ERRORS.md`（失败怎么讲）、
> `AGENTS.md` §1.4（体量闸）§3.6（死控件）。
> **参考实现**：`rpiv-todo@2.10.1`（MIT，源码在 `.workbuddy/pi-ext-review/`）——
> **只抄它的状态机语义与显示口径**；它的扩展宿主层（`promptSnippet` / `renderCall` / `setWidget` /
> `pi.on`）在本仓**没有对应物**，理由见 `ARCHITECTURE.md` §四「Pi 生态的扩展宿主给了什么、我们为什么不用」。

---

## 1. 依据

| 来源 | 约束 |
|---|---|
| `PRINCIPLES.md` #1 永远有心跳、永远能看出在不在动 | 清单要回答「进行到哪」，且空闲/空清单也要**看得出来**（不能靠猜） |
| `PRINCIPLES.md` #8 自动行为不抢焦 | **不做**「模型建清单就自动切到 ⑦」——清单不是 agent 操作的「对象」，自动抢切违反 ⑦-D |
| `UI-REGIONS.md` v1.48 | 界面归属：⑦「任务摘要」的**第一段**（顺序：计划 → 此刻 → 改动总账）；② **不加**常驻入口 |
| `UI-REGIONS.md` ⑦-G / ⑦-H | 「同一类对象只在一处渲染」；附属内容**给结论不给流水** → 已完成折成一行 |
| `SECURITY.md` | 免审批的边界必须**论证**，不是靠名字白名单（见 §3 决策二） |
| `AGENTS.md` §1.4 | `session-manager.ts` 与 `worker/entry.ts` 是**有体量闸的大户**：动手前先量净增、先决定搬哪块 |
| `AGENTS.md` §3.6 | 入口只列真的存在的能力——清单**不进**「+」菜单（默认视图不可关闭、不进菜单清单） |
| `AGENTS.md` §四 | 「参数传了、行为却由库决定」的接线，要断言**最终产物**（这里是注入后的提示词字符串） |

---

## 2. 现状（代码实测，不是推测）

| 事实 | 位置 |
|---|---|
| 内核**只导出 4 个工具**（`bash` / `edit` / `read` / `write`），**没有** `createTodoTool` | `@earendil-works/pi-agent-core/dist/harness/tools/index.d.ts` |
| 本仓 worker 注册 12 个工具（`read/write/edit/bash` + `browser×3` + `computer×2` + `memory_search` + `ask_user`），**无 todo** | `worker/entry.ts:368-377` |
| `READONLY_TOOLS` 里**已经写着** `"todo"`，但**全仓没有任何实现** | `shared/readonly-tools.ts:14` |
| ⚠️ **白名单里的名字不会自动变成工具**——「只有定义、没有调用」是同族坑 | 见 `AGENTS.md` §四 |
| 自研工具的范式是「薄封装 + `HostBridge.call(capability, action, params)`」 | `worker/lib/memory-tool.ts`、`worker/lib/host-bridge.ts:60` |
| 宿主能力标识目前只有三个 | `shared/worker-protocol.ts:193`（`"browser" \| "computer" \| "memory"`） |
| 能力分发的唯一 switch | `main/host/index.ts:77-88` |
| **工具不需要自带 sessionId**：RPC 的 sessionId 由主进程按 entry 补 | `main/host/tool-rpc.ts:24-29` |
| 工具往返一次的上限是 `HOST_RPC_TIMEOUT_MS = 90s`（够用，**不需要新常量**） | `worker/lib/host-bridge.ts:24` |
| 视图的**必经出口**是 `#withDbChanges`，DB 为真源、按会话缓存、写入点失效 | `main/session-manager.ts:519-543`、`#emitView` `:546-551` |
| `ConversationView` 已有 `fileChanges` / `skills` 等，**无 `todos`** | `shared/worker-protocol.ts:118-172` |
| 投影是**纯函数**，且有「升级哨兵」逼你处理新类型 | `worker/lib/project.ts:222-372`、`COVERED_BLOCK_TYPES` `:34-39` |
| `ready` 是给（重）启动的 worker 补发命令的**唯一时点** | `main/session-manager.ts:660-671`（`pendingCommands` 补发 + `readyDeferred`） |
| DB：`SCHEMA_VERSION = 9`，迁移是幂等数组；`file_changes` 表可直接照形制 | `main/db/index.ts:144,177`、`:87-103` |
| DAO 全在 `repo.ts`（`listSessionFileChanges` 是同类范式） | `main/db/repo.ts:321` |
| 渲染层拿视图**只有一条通道**：`session.view` | `main/session-manager.ts:550,680` |
| `question-store.ts` 是「状态机在一个文件里读完、副作用留给宿主」的范式 | `main/question-store.ts`（含 `QuestionStoreHost`） |

---

## 3. 关键决策

四条结构性决定，逐条对应代码事实。

### 决策一：**状态落 SQLite，主进程是唯一写入方**

不学参考实现的「不落盘、靠工具结果自带的 `details` 从会话分支重放」。三条理由：

1. **worker 会被空闲回收重启**（`session-manager` 有 reaper）——重启后进程内存归零，
   靠 transcript 重放要求「最后一条快照还在分支里」；参考实现是 TUI 常驻进程，**没有这个问题**。
2. **主进程要在没有 worker 时也能出视图**：`#withDbChanges` 存在的全部理由就是这个
   （`fileChanges` 已经是这么做的），todo 走同一条路，**零新机制**。
3. **压缩的保留策略我们没有验证过**：`session_compact` 之后分支里那条 toolResult 是否还在，
   是参考实现方案的前提，也是它的**单点**。落库把这个前提整个去掉。

代价：一张表 + 一个 store + 一个 DAO。相比上面三条，值得。

### 决策二：**免审批（靠 `READONLY_TOOLS`），但要把白名单的语义说准**

与 `ask_user` **相反**：提问是「向人要信息」，走审批通道会在 `auto` / `full-access` 下被**静默批准**
（审批的默认是「放行」，而提问的默认必须是「没答案」）；而 todo 是**模型自己的账本**，没有可裁决的对象。

⚠️ **但 `todo` 会写库**，所以白名单的注释口径必须改：

- 现在写的是「名单内的工具**不产生副作用**」——这句话对 `todo` **不成立**。
- 应改成「**不对用户工作区产生副作用**」（这也是免审批边界的真正判据：越界与否看的是
  用户的文件，不是我们自己的 SQLite）。
- 同时在 `SECURITY.md` 补一条边界论证：工具参数里**没有任何路径**，写入目标是应用自有的库，
  会话隔离由主进程按 `entry.sessionId` 强制——模型无法用它在用户工作区里落任何东西。
- 加一条测试钉住这个口径（反过来照 `ask_user` 那条「不许顺手并进白名单」的测试思路）。

### 决策三：**不加 IPC 通道，清单搭 `session.view` 顺风车**

`ask_user` 需要新通道，是因为待答卡片有自己的生命周期（入队 → 作答 → 出队，与视图无关）。
todo 不同：清单**本来就是视图的一部分**（v1.48 定的），`ConversationView.todos` 就够。
→ **零新 IPC 通道、零新事件**。

代价：流式期间每 ~50ms 的全量视图推送会带上清单。清单很小，而 `fileChanges` 早就在付同样的账——
这不是新增成本，是同一笔。

### 决策四：**模型侧的可见性靠「每请求注入」，不是靠工具返回值**

工具返回值只在下一次请求前"新鲜"；长会话与压缩会让模型忘记清单——而**它忘没忘，用户看不出来**
（清单在界面上好好的，模型却在重复做第 3 步）。注入走既有的 `transform_context`，
与 `AGENTS.md` / 记忆块**同一条路**（每请求重读、**不写进 transcript**，见 `entry.ts:441-455`）。

⚠️ **这是本设计里最容易踩的坑**：内核只接受 create-time 的 `systemPrompt`
（`AgentHarness.create`），**它不会**帮我们每请求重算——把清单拼进 create-time 提示词，
中途更新就永远不会生效（`AGENTS.md` §四「把库提供了函数当成库会调用它」的同族）。
判据要落在**最终产物**上：断言组装后的提示词字符串里真的出现了清单。

为此需要一个**主进程 → worker 的镜像推送**（见 §4 `todoSnapshot`）：worker 手里有缓存，
`transform_context` 才是**同步可读**的；否则要在模型请求的热路径上做一次 RPC（延迟 + 失败模式都更差）。

---

## 4. 契约变更（`shared/worker-protocol.ts` + `shared/todo.ts`）

```ts
// ① 宿主能力多一个
export type HostCapability = "browser" | "computer" | "memory" | "todo";

// ② 视图多一段（渲染层与 worker 共用）
export interface ViewTodo {
  id: string;                 // 跨进程稳定（写入方生成，重启后不变）
  subject: string;            // 祈使句：「给 session-manager 加体量闸守卫」
  activeForm: string;         // 进行中时的动名词：「正在加体量闸守卫」
  status: TodoStatus;
  /** 依赖的其它任务 id；被依赖项未完成时本项**不可**被标为 in_progress */
  blockedBy: string[];
  updatedAt: number;
}
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface ConversationView {
  /* …既有字段… */
  todos: ViewTodo[];
}

// ③ 主进程 → worker：清单镜像（worker 用于每请求注入；重启后由 `ready` 补发）
| { type: "todoSnapshot"; todos: ViewTodo[] }
```

工具调用**复用既有 `toolRpc`**：`capability: "todo"`、`action: create | update | list | delete | clear`。

⚠️ **两份「视图」要分清**（`AGENTS.md` 记过这个坑）：主进程 `sessionManager.getView()` 是主进程那份状态，
渲染层手里那份是**推过去**的；`#withDbChanges` 回填的是**后者**。

### 常量放哪：`shared/todo.ts`，**不放** `limits.ts`

上限（条数 / 字段长度）会出现在**两处**：工具 `description`（告诉模型边界）与主进程校验。
放同一个模块里 import，避免漂移。

⚠️ 但它**不符合** `limits.ts` 的准入判据——那里的准入条件是「两侧不同值就会**静默**出错」（挂半路、
界面停住没有失败信号）；这里的漂移是**可见的报错**（模型收到校验失败）。所以不进 `limits.ts`，
**但要解释为什么不进**，免得下一个人照「两侧共享的常量」一律往里塞。

---

## 5. 状态机与校验（`main/todo-store.ts`，纯逻辑 + 单测）

照 `question-store.ts` 的体例：**状态机在一个文件里读完，副作用交给宿主**。

```ts
export interface TodoStoreHost {
  /** 写入后：失效该会话缓存，并让 session-manager 重推视图（搭 session.view 顺风车） */
  changed: (sessionId: string) => void;
  /** 写入后：把整份清单推给 worker 做镜像（工具执行完 → 模型下一请求就能看到） */
  push: (sessionId: string, todos: ViewTodo[]) => void;
}
```

**关键约束（按顺序）**：

1. **每个动作是一个同步函数：校验 → 写入 → 返回整份快照，中间不 `await`。**
   主进程 JS 是单线程，这样「读-改-写」天然不会被两个并发 RPC 交错；
   也正因为如此，`update` 的「自动把上一条 `in_progress` 置回 `pending`」不需要显式事务。
2. **状态转移只允许**：`pending → in_progress → completed`；`completed → pending`（重开）允许；
   `completed → in_progress` 拒绝（必须显式重开，避免「跳回在做」让进度看起来倒退得莫名其妙）。
   同状态重复转移是 no-op（成功返回，不报错——重试不该失败）。
3. **同一会话同一时刻只允许一条 `in_progress`**（新的一条开始 → 上一条自动回 `pending`，
   并在返回文本里**说明**这件事，模型才不会以为自己写错了）。
4. **依赖校验先于任何写入**：`blockedBy` 指向不存在的 id、指向自身、被依赖项未完成就想开工、
   引入环——一律拒绝，且**整次调用不落任何一行**（要么全成、要么全不动）。
5. **删除一条时**，把所有指向它的 `blockedBy` 一并清掉（否则留下悬空引用，之后的校验会莫名失败）。
6. **上限**：条数、`subject` / `activeForm` 长度、单条 `blockedBy` 数量（具体数值放 `shared/todo.ts`）。
7. **空清单即空**：`clear` 删光所有行；没有清单时视图里是 `[]`，**不是**「全是 pending 的幽灵清单」。

工具返回**整份快照**（不是增量）：模型每次都能看到全貌，不需要自己拼接——这也让「模型跑偏后自查」
变得可能。

---

## 6. 工具定义（`worker/lib/todo-tool.ts`）

- **命名** `todo`（与 `memory_search` / `ask_user` 同一 snake_case；**这个名字已经在白名单里**）
- **动作**：`create` / `update` / `list` / `delete` / `clear`
  —— **不做**参考实现的 `get`（`list` 就是全量，清单很小，两个动作是重复的入口）
- **入参**（typebox，照 `memory-tool.ts` 的写法）：`action` enum + 可选字段
  （`subject` / `activeForm` / `id` / `status` / `blockedBy` / `ids`）
- **`description` 是本仓唯一的引导落点**（内核 `AgentTool` **没有** `promptSnippet` / `promptGuidelines`
  字段，实测）——把参考实现那 8 条 guideline 的**实质**写进去：
  复杂任务（≥3 步）才开清单，简单任务不要开；开工前把第一条标 `in_progress`；
  **完成一条立即标，不要批量补标**；有测试还在红、或有未解决的报错时**不许标完成**；
  只保留一条 `in_progress`。写不下就拆到 §8 的注入块里（那里每请求都在，比 description 更持久）。
- **`execute`**：`bridge.call("todo", action, params)` → `{ content: [{ type: "text", text }], details: 整份快照 }`
  - `details` 的定位按内核注释是「for logs or UI rendering」，**不是持久化格式**——
    我们另有 DB，别把 `details` 当第二真源（见 §3 决策一）。
- **校验失败走 `throw`，不是回一条「失败文本」**：内核的 `AgentToolResult` **没有** `isError`，
  返回文本会被当成「工具成功返回了一段话」，模型不知道自己发错了参数，也就不会改对重发
  （这一条是 `ask-user-tool.ts` 实施时踩出来的，直接沿用）。
  失败文案必须把**正确写法**说清楚（对齐 `@shared/skill-error` 的口径：打错时必须给回正确写法）。
- **不进审批闸门**：名字已在 `READONLY_TOOLS` 里 → `policy.ts` 自动放行，
  `after_tool` 的「未经闸门即执行」纵深防御也自动豁免。**无需**在 `before_tool` 里写特例
  （这是它与 `ask_user` 相反的地方：`ask_user` 必须显式跳过，因为名字**不在**白名单里）。

---

## 7. 主进程链路

```
worker: todo 工具 ──toolRpc(capability:"todo")──▶ host/index.ts:case "todo"
                                                      │ entry.sessionId 由 tool-rpc 补
                                                      ▼
                                            main/todo-store.ts（同步：校验→写库→取快照）
                                                      │
                              ┌───────────────────────┴───────────────────────┐
                              ▼                                               ▼
                    DB(todos 表) + 缓存失效                    push：command `todoSnapshot` → worker 镜像
                              │                                               │
                              ▼                                               ▼
              #emitView → session.view（含 todos）               transform_context 每请求注入
                              │
                              ▼
                   渲染层 FollowPanel 第一段
```

1. **能力分发**：`main/host/index.ts` 加 `case "todo"`；`disposeSession` 里加清理（只清缓存，
   **不需要** `cancelAll`——todo 没有等待方，这是它与 `QuestionStore` 最省事的一处不同）。
2. **DB**：新表（形制照 `file_changes`）+ 索引 `(session_id, ord)`；`SCHEMA_VERSION` **9 → 10**，
   `MIGRATIONS` 追加一条 `CREATE TABLE IF NOT EXISTS`（幂等）。
   ⚠️ 用**行删除**表达「删掉一条」，**不学**参考实现的 `deleted` 墓碑状态——它的墓碑是
   「从 transcript 重放时要把删除也重放出来」用的；我们的真源是库，删掉就是删掉（§3 决策一）。
3. **DAO**（进 `repo.ts`）：`listSessionTodos` / `upsertTodos` / `deleteTodo` / `clearSessionTodos`。
4. **视图回填**：`#withDbChanges` 增加 `todos: this.#todos(sessionId)`；`#todos` 照 `#fileChanges`
   按会话缓存，**写入点失效**（store 的 `changed` 回调）。
5. **`ready` 补发**：worker（重）启动时把当前清单推给它——**这是「重启后模型仍看得见清单」的唯一保证**
   （`session-manager.ts:660` 那个 case 里，与 `pendingCommands` 补发同一处）。
6. **缓存与回收**：`#todosCache` 与 worker 同寿命（照 `#fileChangesCache` 的三处清理点：
   `setModel` 分支 / `close` / `dispose`——**三处都要删，漏一处就会返回陈旧清单**）。

---

## 8. worker 侧：镜像 + 每请求注入

- **镜像**：`entry.ts` 内一个模块级变量，收到 `todoSnapshot` 命令即整份覆盖。
  ⚠️ 它**只是缓存**，不是真源——主进程那份（DB）才是。
- **注入**：在既有的第二个 `transform_context`（`entry.ts:445-455`，主对话 lane）里，
  与 AGENTS.md / 记忆块**同一处**追加。⚠️ **必须先把 `TIDY_LANE` 分流保持原样**——
  整理 lane 用专用提示词，清单对它没有意义（那条注释已经明说「必须在这里返回」）。
- **注入到哪**：走 `systemPrompt`（与记忆注入一致），因为清单是**稳定上下文**而不是一次性提醒；
  代价是清单每次变化会让提示词缓存失效一次——变化不频繁，可接受。
  （另一条路是像「临时提醒」那样注入成一条 user message；那会让它看起来像用户说的话，不取。）
- **渲染预算**（抄参考实现的口径，别自己发明）：
  - 只铺开 **`in_progress` + `pending`**，`completed` 折成一行「已完成 N 项」；
  - 超出行数预算时**先丢已完成、最后才截断未完成**，并**如实写出**还剩多少
    （对齐 `ERRORS.md`：不许静默裁掉）；
  - **空清单不注入任何东西**（宁可少一段，也不要一段「（无待办）」的噪声）。
- **判据落在最终产物上**：断言的是**组装后的提示词字符串**里真的含有清单，
  而不是「`todoSnapshot` 被收到了」——见 §11。

---

## 9. 渲染层：任务摘要的第一段

界面归属与三段顺序**已经定在** `UI-REGIONS.md` v1.48，这里只写实现面：

- **数据来源**：`view.todos`（**无新通道**）；`FollowPanel` 现在是两段，新增**第一段**。
- **显示口径**（对齐 ⑦-H）：
  - 标题行：`计划 3/7`
  - 每条：字形 + `subject`；**进行中那条显示 `activeForm`**（这是 `activeForm` 存在的唯一理由）
  - `blockedBy` 未满足的条目要**看得出来**（它是在等，不是被忘了）
  - 已完成：折成一行「已完成 N 项」，**点开才铺开**
- **空态**（⑦-E 要求「必须能显示空」）：分两层写清楚——
  ① **没有清单**（模型还没拆解）→ 这一段整段不渲染，不占位；
  ② **有清单但此刻空闲** → 计划段照常显示，② 段显示「空闲」，总账若无改动则不显示。
- **冒烟钩子**：`data-todo-*`（编号 / 字形 / 状态），**不要用 class 断言**（同
  `data-conv-attach-notice` / `data-dock-tab` 的用法）。
- **不做** ⑦-F 自动切页签；**不改** `DockKind`（仍是 `follow`）；**不进**「+」菜单。

---

## 10. 分批实施

> ⚠️ **体量闸**：`worker/entry.ts` 与 `main/session-manager.ts` 都是**已知大户**，
> 上限 = 建闸那天的实测行数（**零余量**）。动手前按 `AGENTS.md` §1.4 先量净增行数、先决定搬哪块，
> **别等闸红了再拆**。本设计已经把新逻辑压到三个新文件里（`todo-tool.ts` / `todo-store.ts` / DAO），
> 大户只留一行接线——这是刻意的。

1. **契约 + DB + store + 单测**（无 UI、无大户）：`shared/todo.ts`、`shared/worker-protocol.ts`、
   `db/index.ts` 迁移、`repo.ts` DAO、`main/todo-store.ts` + `tests/todo-store.test.ts`
2. **往返链路**：`worker/lib/todo-tool.ts`、`host/index.ts` 的 `case "todo"`、
   `#withDbChanges` 回填、`ready` 补发、`todoSnapshot` 镜像（**无 UI**）
3. **界面**：`FollowPanel` 第一段 + **v1.48 的连带改名清单**（页签标签、`ChangeDrilldown` 面包屑
   与「返回」文案、`dock` 冒烟断言、相关注释）——改名与加段**同批做**，不留中间态
4. **引导与注入**：工具 `description` + 每请求注入 + 预算截断
5. **（可选）`todo-e2e`**（**打模型、计费**）：验「模型真的会自己拆解并按清单推进」——
   做法同 `ask-user-e2e`：**worker 的生死交给渲染层**（`upsertProject(夹具)` + `window.reload()`
   等它自动打开会话就绪），**不要**直连 `session.open` 去抢 worker

> **为什么第 1、2 批不碰 UI**：这条链路最贵的失败模式是**静默**（清单落不了库、模型看不见清单），
> 先在没有界面干扰时把「工具 → 库 → 视图」验掉，比一次做完更容易定位。与 `ask-user` 同一条理由。

---

## 11. 验收

### 单测
`tests/todo-store.test.ts`：状态转移合法性（含**拒绝** `completed → in_progress`、同状态重复是 no-op）、
**只允许一条 `in_progress`**（新开工自动把上一条退回 `pending` 且在文本里说明）、
依赖校验（悬空 id / 自依赖 / 未完成就开始 / 成环 → **整次调用不落任何一行**）、
删除时清悬空引用、上限、`clear` 后视图为 `[]`。
DAO：按会话隔离、幂等 upsert、`clear` 只清本会话。
**注入渲染**（纯函数）：预算截断**先丢已完成**、截断后**如实计数**、空清单**不产出任何文本**。

### 冒烟（不打模型）
优先**新开 `COLT_SMOKE_MODE=todo`**，不往 `dock.ts` 里塞（它已经很大；todo 与右栏布局只有
「显示在哪」这一处交集）。断言走**产品同一条路**（`hostBridge.handle({capability:"todo"})`，
就是 worker 发来 `toolRpc` 时主进程调用的那个函数）+ 主进程打桩读回，不去猜渲染层发了什么：

- 写入后 **DB 里有**、`getView()` 里有、`session.view` 推出来的那份里也有（**三份都要看**：
  只读主进程那份会得出「数据明明是好的」这种必然误导的结论）
- 界面：清单出现、`计划 N/M` 计数正确、进行中那条显示 `activeForm`、已完成折成一行
- 空态两层都对：没清单时这一段不占位；有清单但空闲时 ② 段显示「空闲」
- **worker 被回收 / 重启后清单仍在**（`ready` 补发那条唯一的保证）
- v1.48 的改名：页签 `activeLabel === "任务摘要"`、下钻面包屑与「返回」文案同名
- ⚠️ 断言小目标入口要**命中测试**（`elementFromPoint`），别只查「在不在 DOM 里」

### 打模型的端到端（可选，计费）
`COLT_SMOKE_MODE=todo-e2e`：给一个明确多步的任务，断言
① 模型**真的调用了 `todo`**（且清单内容与 prompt 点名的一致）；
② 清单**随过程推进**（出现 `in_progress`，最终多条 `completed`）；
③ 断言的是**组装后的提示词里含清单**（§3 决策四的判据），不是「镜像被收到了」。

### 明确不覆盖（写明，免得被当成验过了）
- **压缩后清单是否仍能重建**：本设计不依赖 transcript，理论上无关——**如实写明是「无关」而不是「验过」**。
- 并发调用：靠「同步函数、不 await」在**结构上**排除，没有用例去制造并发。

---

## 12. 明确不做

- **不落盘 / 从 transcript 重放**（参考实现的做法）——理由见 §3 决策一
- **扩展宿主层、`promptSnippet`、`renderCall`、TUI overlay、`pi.on`**——本仓没有对应物，
  见 `ARCHITECTURE.md` §四
- **分支独立的清单**：v1 按**会话**（与 `fileChanges` 一致）。代价如实记下：fork 出来的分支
  与父分支**共享**同一份清单。要改的话，真源得从会话级改成「分支级」，那是另一件事
- **清单改动史 / 审计表**（谁在何时改了哪条）——行删除即真相，不留墓碑
- **用户手工编辑清单**：模型是唯一写入方，用户要改就让模型改（界面是显示层）
- **计划项下钻**（点一条计划看它对应的文件改动）——过度设计；**改动**下钻已经存在，别混在一起
- **② 的常驻进度入口**——`UI-REGIONS` v1.48 已否决
- **进「+」菜单**：默认视图不可关闭，不进菜单清单（`AGENTS.md` §3.6 的死控件纪律）
- **子代理清单 / 多会话监控 / 整项目树**
