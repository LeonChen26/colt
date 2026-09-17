# 代码审查：一致性 / 架构腐化 / 坏味道

> **审查日期**：2026-09-17
> **范围**：`src/` 81 个 ts/tsx（24,283 行）+ `tests/` 31 个文件（7,202 行）+ `docs/` 12 份文档 + `README.md` / `AGENTS.md`
> **方法**：全量静态解析 import 图、精确统计（非估算）、逐条核对文档声明与代码、实跑 `typecheck` 与 `npm test`
> **实测基线**：三个 tsconfig 类型检查**全绿**；`npm test` **664 条 / 663 通过 / 0 失败 / 1 跳过**（跳过的是 `file-read.test.ts` 的软链接用例，Windows 需开发者模式）

---

## 一句话结论

**这个仓库的工程质量显著高于同类个人项目**——分层零违规、`any`/`ts-ignore`/`TODO` 全部为 0、安全文档里的数字全部与代码一致。

腐化**不在**代码本身，而在两个地方：

1. **「契约只有一个真源」只落到了类型上，没落到覆盖上**——于是长出 3 个死通道 + 1 个死事件，而没有任何测试能发现；
2. **两个 god 对象**（`smoke.ts` 4452 行、`Conversation()` 单函数 1425 行）已经吸收了整层的复杂度，且**随每次提交继续漂移的「进度数字」类文档正在系统性说谎**。

---

## 摘要：按严重度

| # | 级别 | 问题 | 位置 | 一句话影响 |
|---|---|---|---|---|
| 1 | **P0** | 契约无覆盖守卫 → 3 死通道 + 1 死事件 | `protocol.ts:228,242,252,784` | 声明了却没人用/没人发，类型断言查不出 |
| 2 | **P0** | `smoke.ts` 4452 行（main 层 38%） | `src/main/smoke.ts` | 测试装置住在生产源码树，横跨 8 个模块 |
| 3 | **P0** | `Conversation()` 单函数 1425 行 / 81 个 hook | `Conversation/index.tsx:111-1535` | 无状态库，服务端态与 UI 态同层混放 |
| 4 | **P0** | 4 个超长函数（348 / 306 / 204 / 136 行） | `entry.ts:427,822`、`session-manager.ts:584` | 单函数承担整条链路的全部分支 |
| 5 | **P1** | 竞态：`.catch(() => …)` 静默吞拒绝 21 处 | 见 §3.1 | 撞本项目自己的「失败必须可见」铁律 |
| 6 | **P1** | 密钥存储静默降级 + 非原子写入 | `secrets.ts:25-28,55-58,32` | 写坏一次，全部密钥**静默消失** |
| 7 | **P1** | 路径越界判断两份实现、语义不同 | `policy.ts:214` vs `file-read.ts:46` | 安全闸门用弱的那份，且无软链接防护 |
| 8 | **P1** | 全部「进度类」文档数字漂移 | `README.md:41`、`ARCHITECTURE.md:73`、`NEXT-PHASE.md:50` | 599 vs 664、48 vs 49、207 vs 211 |
| 9 | **P1** | `shared/` 被运行期依赖污染 + 静态环 | `provider-factory.ts:12-14` | 号称纯契约层，却 import pi SDK |
| 10 | **P2** | 枚举 / 常量 / 格式化重复真源 | 见 §1.4、§3.3 | 同目录里两种做法并存 |
| 11 | **P2** | 文档引用了不存在的文件与被删函数 | `NEXT-PHASE.md:417`、`session-stats.ts:4` | `file-tree.ts` 已并入 `change-list.ts` |
| 12 | **P2** | 无 lint、无 CI、strict 缺三项 | 仓库根 | 全靠人守，没有机器兜底 |
| 13 | **P2** | 纯逻辑被困在组件内，不可单测 | `Conversation/index.tsx:85,341` | 违反本项目自定的 `lib/` 原则 |

---

## 一、一致性检查

### 1.1 【P0】「契约只有一个真源」只保证了类型对齐，没保证覆盖

`docs/ARCHITECTURE.md` §三 的这个提法在**类型层面**是成立的，而且做得比多数项目好：

- `protocol.ts:772-776` 与 `:810-814` 有**双向编译期断言**（多一个少一个都编不过）；
- `preload/index.ts:6-15` 直接 import 常量做白名单，**没有第二份手写清单**。

但它保证不了「声明的东西真的有人用」。实测：

| 类型 | 名称 | 状态 |
|---|---|---|
| 死通道 | `app.info` | `protocol.ts:228` 声明、`ipc/index.ts:172` 注册、**全仓 0 处调用** |
| 死通道 | `secrets.status` | `protocol.ts:242` 声明、`ipc/index.ts:336` 注册、**全仓 0 处调用** |
| 死通道 | `session.steer` | `protocol.ts:252` 声明、`ipc/index.ts:461` 注册、**全仓 0 处调用** |
| 死事件 | `file.changed` | `protocol.ts:784` 声明、`:800` 有类型、**主进程从不 `send`、渲染层从不 `on`** |

> 注：`session.steer` 是否「死」取决于语义——worker 侧有 `steer` 命令，但**渲染层没有任何入口触发它**（UI 上无插话按钮）。要么补入口，要么删通道。

49 个通道**全部**有 handler、**全部**有类型，无悬挂、无未注册——所以问题不是「对不上」，而是**没有任何机制防止将来对不上**：

```
$ grep -rln "IPC_CHANNELS\|IPC_EVENTS" tests/
（无输出）
```

**tests/ 里 0 处引用契约常量**。这就是这 4 个死项能长期存活的全部原因。

**建议（本报告最高 ROI 的一条）**：加一个 `tests/contract.test.ts`，用正则扫 `src/main/ipc/index.ts` 的 `handle("xxx"` 与 `session-manager.ts` 的 `#emit("xxx"`，断言与 `IPC_CHANNELS` / `IPC_EVENTS` **集合相等**。二十行代码，永久防住这一整类漂移。

### 1.2 【P1】「进度类」数字系统性漂移

这一类有一个清晰的分界线，值得单独指出：

**安全 / 上限类数字——全部准确**（逐条实测）：

| 文档声明 | 位置 | 实测 |
|---|---|---|
| 危险命令清单 15 条 | `SECURITY.md:51` | ✅ 15 |
| 敏感文件清单 6 条 | `SECURITY.md:70` | ✅ 6 |
| 观测缓冲上限 300 条 | `SECURITY.md:183` | ✅ `CAPTURE_LIMIT = 300` |
| 文本 1MB / 图片 8MB | `SECURITY.md:173` | ✅ `FILE_TEXT_LIMIT` / `FILE_IMAGE_LIMIT` |
| 截图 TTL 2 分钟 | `SECURITY.md:194` | ✅ `SCREENSHOT_TTL_MS` |
| 审批超时 5 分钟 | `SECURITY.md:86` | ✅ `entry.ts:114` |
| 技能不进审批闸门 | `SECURITY.md:92` | ✅ 与 `policy.ts` 判定一致 |

**进度类数字——普遍漂移**：

| 文档声明 | 位置 | 实测 | 偏差 |
|---|---|---|---|
| 单测 **599**（598 通过 / 1 跳过） | `README.md:41` | **664 / 663 / 1** | −65 |
| 同上 | `ARCHITECTURE.md:121`、`NEXT-PHASE.md:50,629`、`UI-REGIONS.md:1174` | 同上 | **5 处同错** |
| `IPC_CHANNELS` **48 条** | `ARCHITECTURE.md:73` | **49 条** | −1 |
| `dock` 断言 **207/207** | `NEXT-PHASE.md:50` | **211**（同文档 `:138`、`:246`、`:709` 都写 211） | 文档**自相矛盾** |

**诊断**：这不是「文档没人维护」——安全数字维护得很好。真正的问题是**这类数字需要人工同步，而同步动作没有被任何流程强制**。两者差别很大：前者要教育，后者只需一个守卫。

**建议**：`README.md:41` 的测试条数改为不写死（「见 `npm test` 输出」），或在 smoke / test 里输出一行提示当前数字，供人复制。

### 1.3 【P1】路径越界判断：同一语义，两份实现，两种语义

这是唯一一处**同时**属于「一致性」和「安全」的问题。

| | 审批闸门（写路径） | 文件读取（读路径） |
|---|---|---|
| 实现 | `policy.ts:214 isInside()` | `file-read.ts:46 isWithin()` |
| 手法 | 手写归一化 + 折叠 `..` + **按段字符串比较** | `node:path.relative()` |
| 大小写 | **敏感**（Windows 上 `C:/proj` vs `c:/proj` 判为**外部**） | **不敏感**（`relative` 一并处理盘符大小写） |
| 软链接 | **无防护** | ✅ `realpathSync` 后再判一次（`:68-74`） |
| 调用点 | `policy.ts:556`（write/edit）、`:581`（上传） | `file-read.ts:80` |

`SECURITY.md:49` 承诺「写项目**外**的文件 → `dangerous`」，而**写路径这一侧靠的正是弱的那一份**：
纯字符串判断挡不住「项目内软链接指向项目外」，而 `auto` 模式下 `moderate` 是**自动放行**、且**可被会话记忆降噪**（`SECURITY.md:77-84`）。

**必须公正地说**：`README.md:22` 明确声明「**不是沙箱**……无法对抗刻意构造的绕过」，所以这**不是**一个违背承诺的漏洞。它的问题在于**严宽不对称**——读路径认真做了三道校验（含软链接），写路径只做了一道字符串比较，而**写比读危险**；并且两个同义函数之间没有任何注释互相指认。

**建议**：把包含性判断抽到 `shared/`（例如 `shared/path-boundary.ts`），读、写两侧共用；软链接与否作为显式参数。同时 `SECURITY.md` §一 补一句「写路径的包含性判断与 §三 共用同一实现」。

### 1.4 【P2】重复真源

| 语义 | 副本 A | 副本 B | 备注 |
|---|---|---|---|
| `ApprovalMode` | `protocol.ts:822` | `policy.ts:48`（**内联重写**） | 同目录的 `store.ts:14` 却正确 import —— 两种做法并存 |
| 风险档位 | `protocol.ts:825 ApprovalRisk` | `policy.ts:18 RiskLevel` | 同值异名 |
| 分支节点 | `protocol.ts:697 BranchNode` | `worker-protocol.ts:306 WorkerBranchNode` | 字段完全相同，两份手写 |
| 宿主 action 字符串 | `browser-tool.ts:13-35` / `computer-tool.ts` | `browser-host.ts:888-983` / `computer-host.ts:110-115` | 无共享常量（**当前两侧一致**，但靠人同步） |
| `formatBytes` | `browser-observe.ts:434` | `renderer/lib/format.ts:16` | 两份独立实现 |
| JSON 入参解析样板 | `format.ts:23`、`approval/store.ts:361`、`analyzer.ts:124`、`FollowPanel.tsx:37`、`telemetry.ts:88` | — | 5 份 |

**对照组**：`shared/readonly-tools.ts` 是**正面样板**——单一 `Set`、跨进程两处消费、头注明确写了「两份列表一旦漂移」的后果。**同一个仓库里既有正确做法，也有 6 处错误做法**，说明缺的不是认知，是统一约定。

### 1.5 【P2】死字段：类型注释在撒谎

```ts
// protocol.ts:506-510
"session.setThinkingLevel": {
  /** cwd 用于 worker 已被空闲回收时自愈重建（同 session.setModel） */
  request: { sessionId: string; level: ThinkingLevel; cwd?: string };
```

而 `ipc/index.ts:466-477` **完全不读** `request.cwd`，`:474` 的注释更明确写着「worker 不在池中时**只落库（不重建）**」。渲染层却仍在传（`Conversation/index.tsx:833`）。

于是：类型注释承诺的能力**不存在**。这类「注释描述了一个已撤销的设计」比缺失更贵——`AGENTS.md` §四 里那条「按字段名猜语义」的铁律，正是指向这一类。

### 1.6 【P2】文档引用了不存在的东西

| 文档位置 | 引用 | 实际 |
|---|---|---|
| `NEXT-PHASE.md:417` | `src/renderer/src/lib/file-tree.ts`（折树纯函数） | **文件不存在**——逻辑已并入 `lib/change-list.ts:88 buildChangeList()` |
| `session-stats.ts:4` | 注释称「沿用 `runStateOf` / `buildFileTree` 的先例」 | `buildFileTree` **全仓已无定义**，只有这处注释还在引用 |

`docs/*.md` 之间的交叉引用**全部有效**（0 处失效）；失效的只是指向源码的引用。

---

## 二、架构腐化

### 2.1 边界执行情况：合格，且是这份报告里最好的一项

全量解析 81 个文件的静态 + 动态 import，跨层边**只有 X → shared 一个方向**：

| 检查项 | 结果 |
|---|---|
| renderer → main / worker | ✅ 0 处 |
| worker → main | ✅ 0 处 |
| main → worker 内部（绕过协议） | ✅ 0 处 |
| shared → main / worker | ✅ 0 处（**依赖方向正确**） |
| `electron` 出现在 renderer / worker / shared | ✅ 0 处 |
| `node:*` 出现在 renderer / shared | ✅ 0 处 |
| preload 白名单第二份手写清单 | ✅ 无，直接 import 常量 |

`README.md`「代码地图」一节声明四条边界，其中**三条被严格执行**。剩下一条见 §2.4。

### 2.2 【P0】`smoke.ts`：测试装置住在生产源码树里

- **4452 行**，占 main 层（11,652 行）的 **38%**，占全仓源码的 **18%**。
- 内含 16 套独立装置：`runBasic:213`、`runModelSelect:275`、`runModelFallback:419`、`runModelSwitchDuringOpen:529`、`runModelKeyless:603`、`runModelNoUsable:709`、`runSessionDraft:822`、`runFixture:935`、`runDock:1128`、`runAdvanced:3353`、`runCrash:3490`、`runMemory:3535`、`runMemoryE2e:3700`、`runReenter:3977`、`runApproval:4070`、`runHost:4236`。
- 依赖宽度：`smoke.ts:34-47` 直连 `db/repo`、`host`、`session-manager`、`db/index`、`db/memory-index`、`providers`、`secrets`、`first-run` + `electron` + `scripts/fixture-server.mjs`。
- **它会真实改动用户状态**：`setSecret:453,551`、`writeFileSync:101`（README 已如实标注计费与副作用，这点做得好）。

**守卫是真的**（我核对过）：`main/index.ts:65` 用 `import.meta.env.DEV` 包住，`:77` 走**动态** `import("./smoke")`，生产构建能整段树摇——不是「打包后仍有一个可被环境变量激活的入口」。

**代价仍然存在，而且是结构性的**：
1. 主进程源码树里有 1/5 的代码**只有一个引用方**（`main/index.ts:77`），却横跨 8 个模块——**它的任何一处改动都会牵动 main 层**；
2. `AGENTS.md` 与 `NEXT-PHASE.md:138` 都记载「`dock` 已 211 条，而 N3/N4 还要往里加」——**它被预期继续变大**；
3. 它验证的恰恰是「截图看不见的状态」（原生视图矩形、页签数、IPC 落点），所以**不能删**，只能搬家。

**建议**：移到 `src/dev/smoke/`（或 `smoke/` 顶层目录），按模式拆成 16 个文件 + 一个注册表；`main/index.ts:77` 的导入路径改一行即可，`import.meta.env.DEV` 守卫不变。**这是纯搬运，零行为改动**。

### 2.3 【P0】两个 god 对象

**`Conversation/index.tsx`（1649 行）**——`Conversation()` 单函数占 `:111-1535`，即 **1425 行**：

| hook | 数量 |
|---|---|
| `useState` | 27 |
| `useEffect` | 11 |
| `useLayoutEffect` | 2 |
| `useCallback` | 25 |
| `useRef` | 12 |
| `useMemo` | 4 |
| **合计** | **81** |

它同时承担：会话流渲染 + 右栏 dock 增删/拖拽/宽度记忆 + 内嵌浏览器 + 附件 + 斜杠命令 + 审批卡 + Live Bar + 观测抽屉。

**`App.tsx`（806 行）**：顶层组件 17 个 `useState` + 8 个 `useEffect`（`:80,86,92,121,132,170,187,251` **全部是手写的 IPC 订阅/刷新**）+ 7 个 `useCallback`。

**`session-manager.ts`（1238 行）**：一个类干 6 件事——worker 池（`#spawnWorker:584`、`#evictIfNeeded:1188`、`#disposeWorker:1159`）、审批中枢（`resolveApproval:252`、`#armApprovalTimer:405`）、DB 落库（`#withDbChanges:529`）、系统通知（`#notifyApproval:217`）、宿主 RPC（`#handleToolRpc:459`）、记忆索引（`#handleMemoryIndex:492`）。

**腐化信号很明确**：服务端状态（`view:135`、`approvals:167`、`git:171`、`browser:180`）与 UI 状态（`input:136`、`dockWidthUser:184`、`dockCollapsed:188`、`awayFromBottom:573`）**存在同一个组件里**，没有 reducer、没有状态库；两者的生命周期完全不是一回事，却靠 11 个 `useEffect` 手工编排。

**建议（分两步，不必一次到位）**：
1. 先抽**自定义 hook**（`useSessionView` / `useApprovals` / `useDockLayout` / `useBrowserState`）——这是机械重构，不改行为，立刻把 1425 行打散；
2. 再把「服务端态」收进一个 reducer（本项目已经有 `protocol.ts` 作为唯一数据契约，正好适合）。

### 2.4 【P0/P1】4 个超长函数

| 函数 | 位置 | 行数 |
|---|---|---|
| `init()` | `worker/entry.ts:427` | **348** |
| `#spawnWorker()` | `main/session-manager.ts:584` | **306** |
| `handle()` | `worker/entry.ts:822` | **204** |
| `#viewFor()` | `main/host/browser-host.ts:699` | **136** |
| `handle()` | `main/host/browser-host.ts:882` | 106 |

`entry.ts` 的 348 行 `init()` 是**整个 worker 的构造过程**——装 provider、装技能、装记忆、装工具、注册闸门、恢复历史，全在一个函数体里，任何一处出错都只能读到「init 失败」。

`entry.ts:822` 的 `handle()` 覆盖全部 15 种命令，**且没有 `default` 分支**——新增命令漏写 case 会被静默忽略。当前 15 种已穷尽（我逐条核对过），属**潜在风险而非现存故障**，但补一个 `default` 抛错是零成本的。

### 2.5 【P1】`shared/` 的纯度被破坏，并形成一个静态环

`shared/` 号称「跨进程契约与**纯逻辑**」，实测 9 个文件里 0 处 `node:*`、0 处 `process.env`、0 处顶层副作用——**大体是干净的**。但有一处越界：

```ts
// shared/provider-factory.ts:12-14
import { createProvider, envApiKeyAuth, lazyApi } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { LEGACY_MAX_TOKENS } from "./model-option";
```

于是形成**全仓唯一一个静态环**（4 个文件）：

```
protocol.ts:6 ──type──▶ worker-protocol.ts:6 ──type──▶ provider-factory.ts:14 ──value──▶ model-option.ts:13 ──type──▶ protocol.ts
```

**运行期不成环**（3 条是 `import type`，会被擦除；唯一的值引用是 `provider-factory → model-option`）。所以这**不是**一个当前故障，而是一个**结构信号**：契约层被夹进了一个「带 SDK 运行期依赖」的文件旁边，环会随下一次 import 变成真的。

**建议**：把 `ProviderBuildConfig` 这类**纯类型**从 `provider-factory.ts` 挪进 `protocol.ts`（或独立的 `shared/provider-config.ts`），让 `provider-factory.ts` 只被 main / worker 直接引用，契约层恢复单向。

### 2.6 【P1】README 的绝对化措辞与实现不符

`README.md:108`：**「内核在 worker 里，主进程不直接调模型。」**

实测反例：`main/approval/analyzer.ts:201` 在主进程内 `models.complete()`。该模块头注（`:16-17`）**主动解释了为什么**——审批要面向用户配置的任意 endpoint，走 pi-ai 的 API 层吸收各家差异，主进程只需一次性文本回复。

`ARCHITECTURE.md:101` 承认这是已知用法。**所以实现是对的，README 的措辞太绝对**。

**建议**：把 `README.md:108` 改成「**会话内核**在 worker 里，主进程不跑内核、不流式调模型；唯一的例外是审批分析器的一次性 `complete()`（见 `approval/analyzer.ts`）」。

### 2.7 【P1】纯逻辑被困，不可单测

本项目自定原则是「纯逻辑抽进 `lib/`，因为它们可单测」。实测有 3 处违反：

| 位置 | 内容 |
|---|---|
| `Conversation/index.tsx:341-382` | `clampDockWidth` + 拖拽钳制数学——**纯数学**，未导出 |
| `Conversation/index.tsx:85` | `formatTokens`——纯格式化，未导出 |
| `App.tsx:605` | 自造 `formatAgo`，与 `lib/format.ts:76` **同名**但语义完全不同（日期 vs 相对时间） |

第三项最危险：**同名异义**。`lib/format.ts:76` 的 `formatAgo` 返回「3s 前 / 5m 前」，被 `FollowPanel.tsx:147`、`ChangeDrilldown.tsx:446,501,572` 三处 import 使用；`App.tsx:605` 的同名函数返回「14:32 / 昨天 / 9月15日」。将来有人「统一一下」把 App.tsx 的换成 import 版本，会**静默改掉侧栏的时间显示口径**。

另：`lib/theme.ts:15-37` 的 `loadTheme` / `applyTheme` / `saveTheme` 直接读写 `localStorage` 与 `document`，破坏 `lib/` 的纯函数定位（同文件 `:40 nextTheme` 才是纯的）。

`Conversation/index.tsx:341-382` 的拖拽数学值得**优先抽出去并加单测**——`AGENTS.md` §3.3 记录过这个位置的一次真实翻车（取负取错了对象），当时的结论正是「必须用具体数值代入验证」。**它至今仍不可单测**。

### 2.8 其它：有一处重复实现是**有意的**

`renderer/lib/session-stats.ts:12-18` 主动说明：它**不读** `usage.totals`，而是自己按 records 累加一遍，为的是保证「KPI 总额 == 各模型行之和」——用户在同一屏看到两处对不上的数字，是最伤信任的一种呈现。

这是一个**有理有据的取舍**，不算坏味道；唯一风险是它靠注释维系，将来 `repo.ts#listSessionUsage` 改了算法，两边会悄悄分叉。**建议**：补一条断言「自己算的总额 == 协议里的 totals」入单测（目前 `tests/lib.test.ts` 只各测一边）。

---

## 三、代码坏味道

### 3.1 【P1】错误处理：数量少，但恰好在最不该静默的地方

先说总数（精确统计）：`catch` 共 **86** 个，其中 **真正空 `catch {}` = 0 个**、仅注释 **16**、仅 `console.*` **3**。**绝大多数的 catch 都有显式 fallback 与注释**——这比多数项目好得多。

问题在**静默降级的具体位置**：

**① `.catch(() => …)` 吞掉 Promise 拒绝 —— 21 处**

`Conversation/index.tsx:291,304,316,454,554`、`WorkspaceDock.tsx:376,384,402`、`ObserveDrawer.tsx:102`、`entry.ts:807,1016,1017` …

多数是「刷新失败就保持旧视图」的合理 fire-and-forget，但**没有任何一处留下痕迹**——用户看到的是「点了没反应」。

**② 密钥存储的三重静默**（`src/main/secrets.ts`）

```ts
function readStore(): SecretStoreFile {
  try { return JSON.parse(readFileSync(file, "utf8")) as SecretStoreFile; }
  catch { return {}; }                                    // ← :27-28 文件损坏 = 没有任何密钥
}

export function getSecret(key: SecretKey): string | undefined {
  try { return safeStorage.decryptString(Buffer.from(encoded, "base64")); }
  catch { return undefined; }                             // ← :57-58 解密失败 = 等同于没配
}
```

`writeStore` 用的是**非原子** `writeFileSync`（`:32`）。三处叠加的后果链：

> 一次写盘中崩溃 → `secrets.json` 截断 → 下次 `readStore` 静默返回 `{}` → **所有 provider 密钥无声消失** → 用户看到「模型服务未配置」，而**没有任何一行日志说明发生过什么**。

而 `PRINCIPLES.md` 末尾专门写了一条：**「失败必须可见。任何后台操作失败，用户都必须能看见——静默失败比报错更伤信任。」** `ERRORS.md` §一 是同一条的展开。

**这是本报告中唯一「违反项目自己写下的最高原则」的问题**，且触发概率不低（写盘崩溃）。

**建议**：
1. `writeStore` 改为**原子写**（写 `secrets.json.tmp` → `renameSync`）——改 3 行，消掉整条链的起因；
2. 两处 catch 至少 `console.error` + 落一条可见信号（`readStore` 返回 `{ store, corrupted: true }`，让 `hasSecret` 能区分「没配」与「读不出来」）。

**③ 另外两处**：`git.ts:48`、`telemetry.ts:93` 同样是静默降级。

### 3.2 【正面】类型逃逸：0

这一项必须单独说，因为它罕见地干净：

| 项 | 数量 |
|---|---|
| `: any` / `as any` | **0** |
| `@ts-ignore` / `@ts-expect-error` | **0** |
| `as unknown as` | 22（**全部**在 `db/repo.ts`、`db/index.ts`、`providers.ts:76` 的**行反序列化**边界，属必要） |
| `!` 非空断言 | 16（`ipc/index.ts:95,247,298,454`、`App.tsx:107`、`format.ts:105` 等，部分可改判空） |

**0 个 `any`** 在一个 2.4 万行、大量解析外部 JSON / DB 行的项目里，是相当克制的纪律。

### 3.3 【P2】重复与魔法数字

- `formatBytes` 两份实现（`browser-observe.ts:434` / `renderer/lib/format.ts:16`）；
- JSON 入参解析样板 5 份（§1.4 表）；
- `"full-access"` 字符串字面量 **16 处**——其中 `policy.ts:48` 与 `protocol.ts:822` 是**类型级重写**（§1.4）；
- 未命名的时间常量：复制提示 `1500ms` 3 处（`App.tsx:716`、`Markdown.tsx:35`、`ObserveDrawer.tsx:275`）、时钟 `1000ms` 3 处、轮询 `250ms` 2 处（`browser-observe.ts:240,250`）。

**对照**：超时 / 上限类**大多已命名**（`APPROVAL_TIMEOUT_MS`、`NAV_TIMEOUT_MS`、`CAPTURE_LIMIT`、`MAX_MATRIX`、`MAX_DOWNLOAD_BYTES`），说明命名习惯是好的，只是没覆盖到交互延迟这一层。渲染层硬编码色值 **0** 处（全走 CSS 令牌）——这一项做得很好。

### 3.4 【P2】工程化缺口

| 项 | 状态 |
|---|---|
| lint（eslint / prettier / biome） | **完全没有配置** |
| CI（`.github/`） | **不存在** |
| `strict` | ✅ 开 |
| `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch` | ✅ 开 |
| `noUncheckedIndexedAccess` | ❌ 未开 |
| `exactOptionalPropertyTypes` | ❌ 未开 |
| `noImplicitOverride` | ❌ 未开 |

`noUncheckedIndexedAccess` 的缺失最值得补：这个项目**大量**解析 DB 行、JSON 入参、`process.env`、数组下标——这正是那 22 处 `as unknown as` 存在的土壤。开了它，反序列化边界会被强制写成真的校验，而不是类型断言。

无 lint 的代价在于**风格一致性只能靠人**：本报告里 §1.4 的「同目录两种做法并存」（`store.ts` 正确 import vs `policy.ts` 内联重写）就是这类问题。

### 3.5 【正面】注释与残留：0

| 项 | 数量 |
|---|---|
| `TODO` / `FIXME` / `XXX` / `HACK` | **0** |
| 被注释掉的死代码块 | **0** |
| 生产路径裸 `console.log` | 0（全部由 `COLT_APPROVAL_DEBUG` 门控：`session-manager.ts:261,317,766`、`approval/store.ts:178`） |
| `document.title=` 之类的临时探针 | **0** |

`smoke.ts` 里的 console 输出按约定是**装置输出**，不计残留。

配合 `AGENTS.md` §1.3「交付前必须清理调试残留」来看，这条纪律**被执行住了**。

### 3.6 【P2】测试

31 个文件 / 7202 行，测试:源码 ≈ **0.30**，664 条用例。

- **超大文件**：`lib.test.ts` **1066** 行、`approval-store.test.ts` **849** 行、`approval.test.ts` **745** 行——三个文件占了测试总量的 37%，`lib.test.ts` 从名字看不出测什么，该按主题拆。
- **样板偏散**：全仓仅 **5** 处 `beforeEach`，无共享 setup 模块。
- **跳过项**：`file-read.test.ts:48`（非 Windows 反斜杠）、`:101`（软链接需权限）——动态跳过，**不是**被遗忘的 `.skip()`，且 README 如实标注了「1 跳过」。
- **断言质量**：多数针对**行为**（例如「越界判断先于任何 fs 访问」），少数断言实现常量（如 `FILE_TEXT_LIMIT`）。整体是健康的。

---

## 四、建议的修复顺序

按「投入产出比」排序，**前三条各自都只需要几十行改动**：

| 顺序 | 动作 | 成本 | 收益 |
|---|---|---|---|
| **1** | 加 `tests/contract.test.ts`：断言 `IPC_CHANNELS` ↔ `handle()` 注册集合、`IPC_EVENTS` ↔ 实际发送点集合**相等** | ~20 行 | 永久防住死通道 / 死事件一整类漂移；顺带逼你处置现在这 4 个 |
| **2** | `secrets.ts` 改原子写 + 两处 catch 留痕 | ~15 行 | 消除「密钥静默全失」这条链；补齐唯一违反本项目最高原则的地方 |
| **3** | `smoke.ts` 从 `src/main/` 搬到 `src/dev/smoke/`，按 16 个模式拆文件 | 纯搬运 | main 层立刻瘦 38%，且 `dock` 还在长大 |
| **4** | 把路径包含性判断抽到 `shared/`，读、写共用；`SECURITY.md` §一 补一句互指 | ~80 行 + 文档 | 消除「读写严宽不一」与「两份同义实现」 |
| **5** | 抽 `Conversation` 的自定义 hook（`useSessionView` / `useDockLayout` / `useApprovals` / `useBrowserState`） | 机械重构 | 1425 行 → 数个 200 行以内的 hook，不改行为 |
| **6** | 把 `clampDockWidth` / 拖拽数学从组件里导出并**补单测** | ~30 行 | `AGENTS.md` §3.3 那次翻车的位置，至今不可测 |
| **7** | 统一 `ApprovalMode` / 风险档位 / `formatBytes` / JSON 解析样板到单一真源 | ~120 行 | 消掉 §1.4 的 6 处重复；照 `readonly-tools.ts` 的样板做 |
| **8** | 文档数字去手工化：`README.md:41` 不写死测试条数；修 `ARCHITECTURE.md:73`（48→49）、`NEXT-PHASE.md:50`（207→211 / 599→664）、`NEXT-PHASE.md:417`（`file-tree.ts` → `change-list.ts`）、`session-stats.ts:4` 注释 | ~10 行 | 让文档停止系统性地漂移 |
| **9** | 开 `noUncheckedIndexedAccess` | 中（会引来一批报错） | 把 22 处反序列化断言逼成真的校验 |
| **10** | 引入 lint + 最小 CI（typecheck + test） | 低 | 风格一致性从「靠人」变成「靠机器」 |

---

## 五、附：本次核对过但**未发现问题**的项目

为免误以为「没提就是没查」，列出已逐条核对、结论为**合格**的项：

- 三个 tsconfig 类型检查全绿（node / web / test）；
- `npm test` 664 条，0 失败；
- 49 个 IPC 通道**全部**有 handler、**全部**有类型；7 个事件**全部**有类型定义；
- 15 种 `WorkerCommand` **全部**在 `entry.ts` 被处理；13 种 `WorkerMessage` **全部**在 `session-manager.ts` 被消费；
- 21 个宿主 action（browser 15 / computer 5 / memory 1）在 worker 侧与宿主侧**完全一致**，两侧都有 `default` 抛错兜底；
- `preload` 白名单与协议常量**同源**，无第二份手写清单；双向编译期断言存在；
- 分层依赖方向**零违规**（§2.1 表）；
- `SECURITY.md` 里 7 项安全 / 上限数字**全部与代码一致**；
- `docs/` 之间的交叉引用**全部有效**；
- `as any` / `@ts-ignore` / `TODO` / `FIXME` / 注释掉的死代码 **全部为 0**；
- 渲染层硬编码色值 **0** 处，全走 CSS 令牌；
- `shared/readonly-tools.ts` 是单真源的**正面样板**，被 main 与 worker 正确共用。

---

## 六、核对范围说明（未覆盖的部分）

诚实标注边界，避免这份报告被当成「全量审计」：

- **未运行** `npm run build` / `npm run dist`，**未运行**任何 smoke 模式（`fixture` / `dock` / `memory` 等）——smoke 断言数（211 vs 207）的**实际值**未验证，只核实了文档之间自相矛盾；
- **未逐字段**验证各 response 构造器是否始终填满 `ConversationView` 与各 DTO 的全部字段；
- **未审计** `smoke.ts` 4452 行内部 16 套装置的**语义正确性**（只统计了结构与依赖宽度）；
- **未审计** `tests/` 7202 行的**用例语义正确性**（只统计了结构、跳过项、断言风格）；
- **未审计** `docs/UI-REGIONS.md`（125KB）与 `docs/NEXT-PHASE.md`（89KB）的**全文**内容与界面的逐条一致性——这两份体量过大，仅核对了其中的数字、路径引用与它们内部的自相矛盾；
- `AGENTS.md` 里记载的历史事故（⑦-F 死控件、`faulted` 永久灰条、技能装载静默失败等）**未逐条回溯验证现状是否已修**。
