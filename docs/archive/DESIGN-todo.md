# todo 设计（任务清单）

> **状态**：**已实施**（2026-09-19）。界面归属见 `UI-REGIONS.md` **v1.48**（⑦ 默认视图更名**任务摘要**，清单是它的**第一段**；② 不加常驻入口）。
> **落地落点**：契约 `shared/todo.ts` / 状态机 `main/todo-store.ts` / 工具 `worker/lib/todo-tool.ts` / 表 `todos`（`main/db/`，schema v10）/ 界面 `FollowPanel.tsx` 第一段。
> **验收**：单测 `tests/todo-store.test.ts`（63 条）+ `tests/migration.test.ts` 的 v10；冒烟 `todo`（26 条，**免模型**）。
> **未覆盖（别当成验过了）**：镜像 → `transform_context` 的每请求注入只有 `todo-e2e`（打模型、尚未建）能覆盖；worker 意外崩溃那一支的收尾。
> **一句话**：给模型一个「先拆清单、再逐条推进、随时能查到进行到哪」的账本——清单**落 SQLite**、由**主进程独占写入**、界面搭 `session.view` 顺风车显示，模型侧靠**每请求注入**持续看得见。
> **配套**：动手前读 `docs/ARCHITECTURE.md`、`docs/PRINCIPLES.md`（#1 #8）、`docs/SECURITY.md`、`docs/ERRORS.md`、`AGENTS.md` §1.4 §3.6 §四。
> **参考实现**：`rpiv-todo@2.10.1`（MIT，本仓**未收录**源码）——**只抄状态机语义与显示口径**；它的扩展宿主层（`promptSnippet` / `renderCall` / `setWidget` / `pi.on`）在本仓没有对应物，理由见 `ARCHITECTURE.md` §四。

---

## 1. 关键事实（代码实测，不是推测）

- 内核**只导出 4 个工具**（`bash` / `edit` / `read` / `write`），**没有** `createTodoTool`。
- `READONLY_TOOLS` 里**已经写着** `"todo"`，但**全仓没有任何实现**——⚠️ 白名单里的名字不会自动变成工具（「只有定义、没有调用」同族坑，`AGENTS.md` §四）。
- 自研工具范式：薄封装 + `HostBridge.call(capability, action, params)`；宿主能力标识当前只有三个（`"browser" | "computer" | "memory"`），分发 switch 在 `main/host/index.ts`。
- 工具**不需要自带 sessionId**：RPC 的 sessionId 由主进程按 entry 补（`main/host/tool-rpc.ts`）；往返上限 `HOST_RPC_TIMEOUT_MS = 90s`（**不需要新常量**）。
- 视图必经出口是 `#withDbChanges`（DB 为真源、按会话缓存、写入点失效）；渲染层拿视图只有 `session.view` 一条通道。
- `ConversationView` 无 `todos`；投影是纯函数，且有「升级哨兵」逼你处理新内容块类型。
- `ready` 是给（重）启动的 worker 补发命令的**唯一时点**；DB `SCHEMA_VERSION = 9`，迁移是幂等数组；DAO 全在 `repo.ts`。

## 2. 关键决策（四条）

**决策一：状态落 SQLite，主进程是唯一写入方。** 不学参考实现的「不落盘、靠工具结果 `details` 从会话分支重放」，三条理由：① worker 会被**空闲回收重启**，重启后进程内存归零；② 主进程要能在**没有 worker 时**也出视图（`#withDbChanges` 存在的全部理由，`fileChanges` 已这么做）；③ 压缩后那条 toolResult 是否还在分支里，我们**没验证过**。代价：一张表 + 一个 store + 一个 DAO。

**决策二：免审批（靠 `READONLY_TOOLS`），但白名单语义要收紧。** 与 `ask_user` **相反**：提问走审批会在 `auto` / `full-access` 下被**静默批准**（审批默认是放行，而提问默认必须是「没答案」）；todo 是模型自己的账本，没有可裁决的对象。⚠️ 但 `todo` **会写库**，故白名单口径从「不产生副作用」改为「**不对用户工作区产生副作用**」——判据看的是**用户的文件**，不是我们自己的 SQLite。`SECURITY.md` §二 有完整边界论证（入参里没有路径 / 写的是应用自有的库 / 会话隔离由主进程强制 / 整个 `TodoStore` 无 fs 调用）。

**决策三：不加 IPC 通道，清单搭 `session.view` 顺风车。** 流式期间每 ~50ms 的全量视图推送会带上清单——清单很小，而 `fileChanges` 早就在付同样的账。

**决策四：模型侧可见性靠「每请求注入」，不是靠工具返回值。** 长会话与压缩会让模型忘记清单，而**它忘没忘，用户看不出来**。注入走既有 `transform_context`（与 AGENTS.md / 记忆同一条路，每请求重读、**不写进 transcript**）。⚠️ 内核只接受 create-time 的 `systemPrompt`（`AgentHarness.create`），**不会**帮我们每请求重算——判据要落在**最终产物**（组装后的提示词字符串）上。为此需要一条「主进程 → worker 的镜像推送」（`todoSnapshot`），`transform_context` 才是**同步可读**的。

## 3. 契约（`shared/worker-protocol.ts` + `shared/todo.ts`）

```ts
export type HostCapability = "browser" | "computer" | "memory" | "todo";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface ViewTodo {
  id: string;                 // 跨进程稳定（写入方生成，重启后不变）
  subject: string;            // 祈使句
  activeForm: string;         // 进行中时的动名词
  status: TodoStatus;
  blockedBy: string[];        // 被依赖项未完成时本项不可标为 in_progress
  updatedAt: number;
}
export interface ConversationView { /* …既有字段… */ todos: ViewTodo[]; }

// 主进程 → worker：清单镜像（worker 用于每请求注入；重启后由 `ready` 补发）
| { type: "todoSnapshot"; todos: ViewTodo[] }
```

工具调用**复用既有 `toolRpc`**：`capability: "todo"`、`action: create | update | list | delete | clear`。

常量放 `shared/todo.ts`（工具 `description` 与主进程校验共用，避免漂移），**不放** `limits.ts`——那里的准入判据是「两侧不同值会**静默**出错」，这里的漂移是**可见的报错**。

⚠️ 两份「视图」要分清：主进程 `getView()` 是主进程那份，渲染层手里那份是**推过去**的；`#withDbChanges` 回填的是**后者**。

## 4. 状态机与校验（`main/todo-store.ts`，纯逻辑 + 单测）

照 `question-store.ts` 的体例：状态机在一个文件里读完，副作用交给宿主（`TodoStoreHost.changed` / `TodoStoreHost.push`）。约束按顺序：

1. 每个动作是一个**同步函数**：校验 → 写入 → 返回整份快照，**中间不 `await`**（主进程单线程，读-改-写天然不被并发交错）。
2. 状态转移只允许 `pending → in_progress → completed`；`completed → pending`（重开）允许；**`completed → in_progress` 拒绝**（必须显式重开）。同状态重复转移是 no-op（重试不该失败）。
3. 同一会话同一时刻只允许**一条** `in_progress`（新的一条开始 → 上一条自动回 `pending`，并在返回文本里**说明**）。
4. 依赖校验**先于任何写入**：悬空 id / 自依赖 / 被依赖项未完成就开工 / 成环——一律拒绝，且**整次调用不落任何一行**。
5. 删除一条时，把所有指向它的 `blockedBy` 一并清掉（否则留悬空引用）。
6. 上限：条数、`subject` / `activeForm` 长度、单条 `blockedBy` 数量（具体值放 `shared/todo.ts`）。
7. 空清单即空：`clear` 删光所有行；无清单时视图里是 `[]`。

工具返回**整份快照**（不是增量），这也让「模型跑偏后自查」成为可能。

## 5. 工具定义（`worker/lib/todo-tool.ts`）

- 命名 `todo`（**已在白名单里**）；动作 `create` / `update` / `list` / `delete` / `clear`（**不做**参考实现的 `get`——`list` 就是全量）。
- 入参 typebox（照 `memory-tool.ts`）：`action` enum + 可选 `subject` / `activeForm` / `id` / `status` / `blockedBy` / `ids`。
- **`description` 是本仓唯一的引导落点**（内核 `AgentTool` **没有** `promptSnippet` / `promptGuidelines`）：复杂任务（≥3 步）才开清单；开工前把第一条标 `in_progress`；**完成一条立即标，不要批量补标**；有测试还在红 / 有未解决报错时**不许标完成**；只保留一条 `in_progress`。
- `execute` → `bridge.call("todo", action, params)`，返回 `{ content, details: 整份快照 }`。⚠️ `details` 按内核注释是「for logs or UI rendering」，**不是持久化格式**，别把它当第二真源。
- **校验失败走 `throw`，不是回一条「失败文本」**（内核 `AgentToolResult` **没有** `isError`，返回文本会被当成工具成功）；失败文案必须给出**正确写法**（对齐 `@shared/skill-error`）。
- **不进审批闸门**：名字已在 `READONLY_TOOLS` → `policy.ts` 自动放行、`after_tool` 的纵深防御自动豁免，**无需**在 `before_tool` 写特例（这是它与 `ask_user` 相反之处）。

## 6. 主进程链路

```
worker: todo 工具 ──toolRpc(capability:"todo")──▶ host/index.ts:case "todo"
  └─▶ main/todo-store.ts（同步：校验→写库→取快照）
       ├─▶ DB(todos 表) + 缓存失效 ─▶ #emitView → session.view（含 todos）─▶ FollowPanel 第一段
       └─▶ push: command `todoSnapshot` → worker 镜像 → transform_context 每请求注入
```

- **能力分发**：`host/index.ts` 加 `case "todo"`；`disposeSession` 加清理（只清缓存，**不需要** `cancelAll`——todo 没有等待方）。
- **DB**：新表（形制照 `file_changes`）+ 索引 `(session_id, ord)`；`SCHEMA_VERSION` **9 → 10**，`MIGRATIONS` 追加一条幂等 `CREATE TABLE IF NOT EXISTS`。⚠️ 用**行删除**表达删一条，**不学**参考实现的墓碑状态（真源是库）。
- **DAO**（进 `repo.ts`）：`listSessionTodos` / `upsertTodos` / `deleteTodo` / `clearSessionTodos`。
- **视图回填**：`#withDbChanges` 增加 `todos`（按会话缓存，**写入点失效**）。
- **`ready` 补发**：worker（重）启动时把当前清单推给它——**这是「重启后模型仍看得见清单」的唯一保证**。
- **缓存与回收**：`#todosCache` 与 worker 同寿命，清理点照 `#fileChangesCache` 的**三处**——**漏一处就会返回陈旧清单**。

## 7. worker 侧：镜像 + 每请求注入

- **镜像**：模块级变量，收到 `todoSnapshot` 命令即整份覆盖。⚠️ 它**只是缓存**，主进程那份（DB）才是真源。
- **注入**：在既有的第二个 `transform_context`（主对话 lane）里，与 AGENTS.md / 记忆块**同一处**追加。⚠️ **必须先保持 `TIDY_LANE` 分流原样**（整理 lane 用专用提示词，清单对它没有意义）。走 `systemPrompt`（稳定上下文，不是一次性提醒）。
- **渲染预算**：只铺开 `in_progress` + `pending`，`completed` 折成一行「已完成 N 项」；超预算时**先丢已完成、最后才截断未完成**，并**如实写出**还剩多少；**空清单不注入任何东西**。
- **判据落在最终产物上**：断言**组装后的提示词字符串**里真的含有清单，而不是「`todoSnapshot` 被收到了」。

## 8. 渲染层（⑦ 任务摘要的第一段）

界面归属与三段顺序**已定在** `UI-REGIONS.md` v1.48，这里只写实现面：

- **数据来源** `view.todos`（**无新通道**）。标题行 `计划 3/7`；每条为 `subject`，**进行中那条显示 `activeForm`**；`blockedBy` 未满足的条目要**看得出来**；已完成折成一行「已完成 N 项」、点开才铺开。
- **空态**两层：① **没有清单**（模型还没拆解）→ 这一段整段不渲染、不占位；② 有清单但此刻空闲 → 计划段照常显示。
- **冒烟钩子** `data-todo-*`，**不要用 class 断言**。**不做** ⑦-F 自动切页签；**不改** `DockKind`（仍是 `follow`）；**不进**「+」菜单。

## 9. 验收

- **单测**：状态转移（含**拒绝** `completed → in_progress`、同状态 no-op）、只允许一条 `in_progress`（自动退回 + 文本说明）、依赖校验（**整次不落任何一行**）、删除清悬空引用、上限、`clear` 后为 `[]`；DAO 按会话隔离 / 幂等 upsert；注入渲染（预算截断**先丢已完成**、截断后**如实计数**、空清单**不产出文本**）。
- **冒烟 `todo`**（免模型；不往 `dock.ts` 塞）：走**产品同一条路**（`hostBridge.handle({capability:"todo"})`）+ 主进程打桩读回。三份都要看（DB / `getView()` / `session.view` 推出来的那份——只读主进程那份会得出「数据明明是好的」这种必然误导的结论）；界面（清单出现、`N/M` 计数、`activeForm`、已完成折行）；空态两层；**worker 被回收重启后清单仍在**；v1.48 改名（页签 `activeLabel === "任务摘要"`、面包屑同名）。⚠️ 小目标入口要**命中测试**（`elementFromPoint`）。
- **打模型 e2e（可选、计费）** `todo-e2e`：模型真调用 `todo`、清单随过程推进、断言**组装后的提示词里含清单**（决策四的判据）。
- **明确不覆盖**：压缩后清单是否仍能重建（本设计不依赖 transcript，**如实写明是「无关」而不是「验过」**）；并发调用（靠「同步、不 await」在**结构上**排除，没有用例制造并发）。

## 10. 明确不做

- **不落盘 / 从 transcript 重放**（决策一）；**扩展宿主层 / `promptSnippet` / `renderCall` / TUI overlay / `pi.on`**（本仓没有对应物，见 `ARCHITECTURE.md` §四）。
- **分支独立的清单**：v1 按**会话**（与 `fileChanges` 一致）——代价如实记下：fork 出来的分支与父分支**共享**同一份清单。
- 清单改动史 / 审计表（行删除即真相，不留墓碑）；用户手工编辑清单（模型是唯一写入方）；计划项下钻（**改动**下钻已存在，别混）。
- ② 的常驻进度入口（`UI-REGIONS` v1.48 已否决）；进「+」菜单（默认视图不可关闭）；子代理清单 / 多会话监控 / 整项目树。
