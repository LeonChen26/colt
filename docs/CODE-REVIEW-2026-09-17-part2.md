# 代码审查·第二轮：回溯验证与深挖上一轮未覆盖的部分

> 同日第一轮产出 `docs/CODE-REVIEW-2026-09-17.md`（三维度全量扫描）。
> 那份报告在 §六 明确标注了**未覆盖**的范围，本轮专攻那些，不重复已核对的结论。
>
> **本轮要回答的一个问题**：这个仓库最贵的资产是 `AGENTS.md` 里记下的真实事故。
> 但如果**记录与代码脱节**，它就从资产变成误导（后来者会以为某个坑已经堵上了）。
> 所以本轮第一件事就是**逐条回溯验证**。

---

## 一句话结论

**`AGENTS.md` 经得起回溯——8 条历史事故里 7 条已真正守住，唯一没守住的那条恰好是它自己记过的「纯逻辑被困、不可单测」。**

体量之外的真问题是**「同一份真相存了两份」**：渲染层找到 4 处镜像状态（2 处会真漂移）、3 处同语义函数的双份实现；测试套件里 49/92 个源文件没有任何测试引用，而唯一被跳过的那条守的是**安全不变量**。

---

## 一、回溯验证：`AGENTS.md` 记录的事故，现状如何

判定依据一律是**代码行为**，不是注释或文档自述（这个仓库的历史教训正是「参数传进去了但行为没发生」）。

| # | 记的事故 | 现状 | 证据 |
|---|---|---|---|
| 1 | ⑦-F 折叠态视图图标「点了没反应」（44px 里看不出变化） | **已修** | `WorkspaceDock.tsx:430-433`：折叠分支 `pick = onActivate(id) + onToggleCollapse()`，点图标必同时展开 |
| 2 | `faulted` 只置位不复位 → 差点做成**永久灰条** | **已修** | 渲染层改用 `lastRun.status`（`lib/format.ts:47-51` `runStateOf`，`Conversation/index.tsx:1476`）；全仓 `faulted` 仅存在于定义与投影，**渲染层零读取** |
| 3 | 技能装载**静默失败**（内核只导出不调用） | **已修** | 真调用点 `worker/entry.ts:523`；`tests/skills.test.ts:169-183` 断言组装产物含 `<available_skills>` / `<name>pdf</name>` |
| 4 | 「贴心」补出的**第二个停止入口** | **已修** | 全仓唯一 `title="停止"` 在 `Conversation/index.tsx:1392`，`title="中断当前运行"` 已无 |
| 5 | 漏做 Live Bar（设计稿标 P0） | **已存在** | `Conversation/index.tsx:1419-1490` 内联实现（非独立组件） |
| 6 | 拖拽「取负取错对象」→ 被钳到下限 | **公式已修，但诉求未达成** | `Conversation/index.tsx:366` `next = startWidth - (clientX - startX)`；代入 300 宽左拖 20 → 320（对）。**但它仍是组件内的 `useCallback`，`tests/` 零引用——`AGENTS.md` §3.3 要求「代入数值验证」，而这段数学至今不可单测** |
| 7 | A3-3 死菜单项（画了不存在的三种视图） | **已修** | 菜单由 `closable` 推导（`WorkspaceDock.tsx:119`）= `browser / usage / rules`，三个渲染点 `:543 :721 :722` 都真实存在 |
| 8 | 调试残留（`document.title=`、`OVERFLOW_TEST`、自检 IIFE） | **已清** | 全仓仅命中文档；`browser-host.ts:139` 是**读**页面标题，`CodeView.tsx:43` 是错误日志 |

**另外三项 —— 记录自身的陈旧（本轮已修）**：

- `AGENTS.md:272` 写 `dock` 是 **207** 条，实测 **211**（第一轮就把 NEXT-PHASE 改了，漏了这里）；
- `AGENTS.md:347 / :354` 引用 `smoke.ts` 与 `smokeView()` —— 前者路径已迁走、后者**函数名已不存在**（现为 `src/dev/smoke/modes/dock.ts` 的 `viewBase`）；
- `AGENTS.md:110` 有**第二个** `## 三、产品判断纪律` 标题；§四 标题写着「尚未造成事故」，而节内 `:210` 的技能静默失败自述「**已经进过仓库**」——标题与内容自相矛盾；
- `docs/GLOSSARY.md` 的冒烟模式表**漏了 `memory` 与 `memory-e2e` 两个真实模式**（`src/dev/smoke/index.ts:139`），且 `dock` 数字停在 207。

> **规律**：代码侧的教训守得很好，**文档侧的自身维护反而最弱**。这与第一轮「进度类数字全面漂移」是同一个病根——数字靠人同步，而人不会记得同步文档里描述自己的那一段。

---

## 二、死导出扫描（新维度）

呼应 `AGENTS.md` 记的那次最贵事故（「把库提供了函数当成库会调用它」——`formatSkillsForSystemPrompt` **只有定义、没有调用点**）。把同一个问题**从依赖内部推广到本仓库自身**：有没有「导出了但全仓没人用」的符号？

扫查 93 个源文件、400 个导出，**完全零引用**的只有 4 个：

| 符号 | 位置 | 判定 |
|---|---|---|
| `nextTheme` | `src/renderer/src/lib/theme.ts:40` | **真死代码** |
| `IconSize` | `src/renderer/src/lib/icon.ts` | 类型零引用，无害 |
| `ChannelParityChecked` | `src/shared/protocol.ts:757` | **假阳性**（见下） |
| `EventParityChecked` | `src/shared/protocol.ts:792` | **假阳性** |

`nextTheme`（循环切到下一个主题）是真的没人调用：主题切换 UI 已经改成**三选一菜单**（`App.tsx:369` `setTheme(item.value)`），这个函数是那次改动的遗留。它无害，但**会误导**——读代码的人会以为存在「点一下循环切主题」的入口。

> **一处交叉修正**：上一轮的测试审计建议「给 `theme.ts` 的纯逻辑补单测」，把 `nextTheme` 也算作待测。实际上它**该删不该测**。两个维度的结论在这里汇合才看清。

另有一批「导出但只在本文件内使用」的值（`resolveBash`、`FILE_IMAGE_LIMIT`、`clearUserData`、`ICON_STROKE`、`ANALYZE_TIMEOUT_MS`、`MIN/MAX_VIEWPORT_HEIGHT` 等）——`export` 关键字多余，但不构成问题。

---

## 三、证明「编译期断言」非空转（补上第一轮缺失的一步）

第一轮把「`IPC_CHANNELS` 与契约表的**双向编译期断言**」列为**合格项**，但只核对了它**存在**，没验证它**会红**。按本仓库自己的纪律（「守卫必须证明自己非空转」），这一步不能省。

做法：临时往 `IPC_CHANNELS` 插一个 `parity.probe.temporary`，然后跑 `tsc`：

```
src/shared/protocol.ts(760,15): error TS2344:
  Type '"parity.probe.temporary"' does not satisfy the constraint 'never'.
```

**结论：断言有效，且直接指名出错的通道名**——与文档声称的行为一致。探针已撤回，grep 确认 0 残留。

---

## 四、DTO 字段完整性（第一轮明确未覆盖）

第一轮的未覆盖项写的是「未逐字段验证各 response 构造器是否始终填满 DTO 的全部字段」。核完的答案是：**这项不需要人工逐个核**，因为它是**类型系统强制**的——

- `ConversationView`（`shared/worker-protocol.ts:98`）的字段**全部必填**（无 `?`）；
- 全仓唯一构造点是 `src/dev/smoke/modes/dock.ts:733`，写法是**类型标注** `const viewBase: ConversationView = {` 而非 `as` 断言 → **少字段编译就不过**（这正是 `AGENTS.md` 记的「夹具缺字段」事故的修复成果，注释还留在原地）。

**但反过来查出一个真问题：3 个字段推给渲染层后零读取。**

| 字段 | 渲染层读取次数 | 判断 |
|---|---|---|
| `faulted` | **0** | 已知死字段（第一轮 §1.5）；正确信号是 `lastRun.status` |
| `lane` | **0** | 推了不用 |
| `cwd` | **0** | 推了不用（渲染层连 `.cwd` 这个写法都没有） |

`lane` / `cwd` 无害，但属于「传输了没人看」——真要瘦身 `ConversationView`，这三个是候选。

> ⚠️ 这一项的统计数据我**第一遍全查成了 0**——见 §八，那是个假阴性，值得单独记。

---

## 五、测试套件语义审计（第一轮明确未覆盖）

**先说结论：纪律很好，没有「假绿」。** 但「只验非空」的弱断言和「测源码形状」的测试各有约 8 处 / 4 处。

| 维度 | 结论 |
|---|---|
| 空转 / 恒真断言 | **0** —— 无自反断言、无「断言自己刚造的值」；**20 处 `try` 全部配 `finally`，无一处 catch 包裹断言**（呼应仓库最重视的「不静默失败」） |
| try/catch 吞断言 | **0** |
| 只验「存在 / 非空」 | **约 8 处**（见下） |
| 读源码文本做断言 | **4 个文件**（见下） |
| 用例密度 | 无极端：单用例断言最多约 10 条，无 >15 条的 |

**只验非空（实现改成任意值仍会绿）的代表**：

- `tests/approval-analyzer.test.ts:45-57`：用例标题写着「给默认文案」，实际只断言 `reason.length > 0`——**文案内容完全没被检查**；
- `tests/provider-factory.test.ts:69`：只断言 `getModels().length > 0`，不校验是哪些内置模型；
- `tests/net-change.test.ts:78`、`tests/memory.test.ts:101`、`tests/approval-store.test.ts:589` 同类。

**测实现形状而非行为（改写法即假红，而行为没变）**：

- `tests/memory-index.test.ts:128-131` 断言源码里存在 `case "memoryIndex"` 与 `#handleMemoryIndex`——纯标识符，换成分发表就红；
- `tests/set-model.test.ts:19-53` 用 `indexOf` + 正则切方法体，断言调用先后；
- `tests/session-draft.test.ts:16-24`、`tests/contract.test.ts:26-66` 同法。

**这里要诚实指出：`tests/contract.test.ts` 是第一轮我新加的契约守卫，它也在这份名单里。** 它读源码文本（因为 `ipc/index.ts` 依赖 electron，node 测试起不来），断言的是「源码里注册了哪些 handle」，不是运行时行为。**这个折衷是正当的，但它的定位应当写明是「防漂移回退」而非「行为覆盖」**——否则将来一次无害的重构（比如改成分发表）会让它假红，而维护者可能因此削弱它。建议在文件头注释里点明。

**覆盖缺口**：92 个源文件中 **49 个没有任何测试引用**。要分成两类看：

- **有理由不测**：`src/dev/smoke/**`(12)、`src/preload/**`(2)、29 个渲染层组件、`host/browser-host.ts`、`host/computer-host.ts`、`main/index.ts`、`worker/entry.ts`、`secrets.ts`；
- **该测却没测（纯逻辑、且已有抽取先例）**：`src/main/env-check.ts:36` 的 `resolveBash`（纯 fs/env 判定）、`src/main/approval/config.ts:17-35` 的脏数据回落、`src/main/providers.ts:53-70` 的 `toConfig`、`src/renderer/src/lib/icon.ts`。

**被跳过的那 1 条，代价被低估了**：`tests/file-read.test.ts:99-105`（Windows 无开发者模式时 `t.skip`）。它不是一条普通用例——它守的是 `src/main/file-read.ts:74-75` 的 **`realpath` 二次边界校验**，那是个**安全不变量**（软链接逃逸）。在开发者的 Windows 机器上，**这条防线永久不被验证，回归了也没人知道**。建议改成注入式 `realpath` 或补一条不依赖建链的用例。

**其它**：

- **共享可变状态**：`tests/net-change.test.ts:16-31` 用模块级 `root`（非 `beforeEach`），注释里自认「上一例把文件改坏了」——用例依赖前序执行结果；
- **样板重复**：12 个测试文件各自建临时目录，其中 8 个重复同款 `before/after` 生命周期（`db.test.ts:17-27`、`baseline.test.ts:16-27`、`file-read.test.ts:15-37`、`net-change.test.ts:16-31` 等）→ 建议抽 `tests/helpers/temp.ts`。

---

## 六、渲染层腐化（体量之外）

第一轮已统计过体量（`Conversation()` 1425 行 / 81 hook、`App.tsx` 806 行、0 处硬编码色值）。这轮查的是**「即使把文件拆小了也依然存在」的问题**。

### 6.1 多重真源 —— 本轮最该修的一类

同一个状态存在**两份**，其中两处会真实漂移：

| 状态 | 两份在哪 | 会怎样漂移 |
|---|---|---|
| **运行起始时刻** | `App.tsx:157-164`（`runningSessions.set(id, Date.now())`）vs `Conversation/index.tsx:390-392`（`runStartedAtRef`） | Conversation 后挂载（切走再切回）时起点更晚 → 侧栏 `formatElapsed`（`App.tsx:628`）与会话内 `elapsedLabel`（`index.tsx:918`）**对不上** |
| **会话标题 / 消息数** | `App.tsx:133-155` 从 `session.view` 更新，但**带一个 `continue` 守卫**（`:138`）：列表里没有该会话就跳过 | 草稿会话由本地插入（`App.tsx:294-298`），若事件早于插入 → 侧栏**永远停在「新会话」**，而会话区是实时更新的 |
| ToolCard 展开态 | `MessageList.tsx:231-237` 本地 state + 外部 `openState` Map，只在挂载时取一次 | 流式区与完成态两个实例同时挂载时，改一个另一个不同步 |
| 下钻当前层 | `WorkspaceDock.tsx:299` 持 `drillEntry`，`ChangeDrilldown.tsx:237-243` 复制进本地 `layer/path` 并用 effect 同步；层内 `goList`（`:268`）只改本地不回写 | 两者对「当前层」可分叉 |

第一处和第二处**不是理论风险**——都是「用户看得见的数字/文字对不上」。

### 6.2 订阅与依赖

- **无订阅泄漏**：5 处 `window.colt.on(...)` 全部成对退订（`App.tsx:133/171/187`、`BranchTree.tsx:93`、`Conversation/index.tsx:456` + `:546-551` 四个 `off`）；
- 但 **`session.view` 被三个组件各订一份**（`App.tsx:133`、`BranchTree.tsx:93`、`Conversation/index.tsx:484`）——不是泄漏，但一次事件跑三份逻辑，这也是 6.1 里「两份真相」的温床；
- **`ChangeDrilldown.tsx:303` 的 ESC 监听没有依赖数组**——每次渲染都 remove + add。后果不是 stale 闭包（每次重注册反而让闭包始终新鲜），而是**每次渲染都做一次 DOM 事件增删**；
- `Conversation/index.tsx:476` 依赖数组是 `[sessionId, cwd]`，却用了未列出的 `sessionModelRef`（`:516`）——因为该 effect 只在切会话时跑，**暂不构成实时 bug**，但属埋雷。

### 6.3 被困住的纯逻辑：6 处，其中 3 处是**双份实现**

单份被困：

- `BranchTree.tsx:21 layout`（纯布局计算，可直接移出）；
- `FollowPanel.tsx:37 parseToolArgs`（与 `lib/` 的 `parseArgsJson` 语义重叠）；
- `Conversation/index.tsx:341 clampDockWidth`（`AGENTS.md` §3.3 的翻车点）——它**只依赖入参**，唯一障碍是读了 `rootRef.current.clientWidth`，**改成传入 `space` 即可单测**。

**同语义两份**（比"困住"更值得先修，因为会不一致）：

| 语义 | 第一份 | 第二份 | 差异 |
|---|---|---|---|
| 相对时间 | `App.tsx:605 formatAgo`（昨天 / 月日） | `lib/format.ts:76 formatAgo`（Ns 前） | **同名不同义**——将来「统一一下」会静默改掉时间显示 |
| token 数 | `Conversation/index.tsx:85 formatTokens` | `lib/session-stats.ts:197 formatTokenCount` | 999.95 升档逻辑各写一遍 |
| mm:ss | `App.tsx:628 formatElapsed` | `Conversation/index.tsx:919 elapsedLabel`（内联模板） | 格式规则两份 |

### 6.4 其它

- **prop drilling**：`WorkspaceDock` 收 **15 个 prop**（`:238-285`）；`highlightPath` 与 `openState` 在中间层**只转手不用**（`WorkspaceDock.tsx:241`、`MessageList.tsx:61`）。这决定了「拆 hook」的收益上限——状态若是靠 prop 传的，拆 hook 只是换个地方堆。
- **键盘可达性缺口**：右栏分隔条（`Conversation/index.tsx:1519-1529`）有 `role="separator"` 与 `aria-*`，但**只有 `onMouseDown` / `onDoubleClick`，没有 `tabIndex` / `onKeyDown`** → 键盘用户**无法调整右栏宽度**。这与 `AGENTS.md` 记的「『在 DOM 里』不等于『用户点得到』」是同一族问题。
- **性能**：**全仓 0 处 `React.memo`**。输入框 state 提到了 `Conversation`，于是**每次击键**都会重渲全部消息与工具卡（`index.tsx:1100-1110` 的 `messages.map`，每条重跑 `matchChangeByPath` 与 `parseArgsJson`）；运行期还有 **1 秒心跳**（`:384`）每秒再渲一遍。`changes = view?.fileChanges ?? []`（`:865`）在 view 为 null 时每次产生新数组。
- **`render 期写 ref`**（`Conversation/index.tsx:400` `runningRef.current = ...`）：这是 React 反模式，但**代码里有自述理由**——避开 `compact` / `submit` 对 `running` 的依赖倒挂。**属有意权衡，不是疏忽**，如实记录，别当问题修掉。

---

## 七、修复优先级（第二轮）

按投入产出比：

| 顺序 | 动作 | 成本 | 收益 |
|---|---|---|---|
| **1** | 修 6.1 的**前两处多重真源**（运行起始时刻、草稿会话标题） | 小 | 直接消掉「计时器对不上」「侧栏卡在新会话」两个用户可见 bug |
| **2** | `file-read` 软链接用例改为不依赖建链（§5） | 小 | 让一条**安全不变量**在 Windows 上也被验证，而不是永久跳过 |
| **3** | 把 `clampDockWidth` 的 `space` 改成入参并导出 + 补单测（§1-#6 / §6.3） | 小 | 补上 `AGENTS.md` §3.3 唯一没守住的那条诉求 |
| **4** | 删除 `nextTheme`（§2） | 极小 | 少一处误导；顺手把「同名异义」的 `formatAgo` 改名 |
| **5** | `tests/helpers/temp.ts` 抽走 8 处重复生命周期（§5） | 小 | 测试变短；顺带把 `net-change` 的模块级共享状态改掉 |
| **6** | 给 `contract.test.ts` 加定位注释；把 8 处「只验非空」改成断言具体值（§5） | 小 | 让「全绿」不再包含弱断言 |
| **7** | 拆 6.1 的镜像状态为单一真源（可能需要抽 `useSessionView`），再谈拆 hook | 中 | 拆 hook 排在后面——先统一真相，再谈拆分 |
| **8** | 补 `env-check.resolveBash` / `approval/config` 脏数据回落 / `icon.ts` 的单测（§5） | 小 | 纯逻辑，成本低 |
| **9** | `ConversationView` 去掉 `lane` / `cwd` / `faulted`（§4） | 小 | 契约变诚实；但**牵动夹具与投影**，要做就一次做净 |

**执行状态（2026-09-17，九项已按上表顺序全部落地）**：

| # | 落点 |
|---|---|
| 1 | 运行起始时刻收敛为单一真源（抽 `lib/session.ts`，`tests/session-list.test.ts`）；草稿会话不再被 `continue` 守卫丢掉（`mergePersistedWithDrafts`） |
| 2 | 越界用例改用目录联接（junction）——本机 `symlinkSync` 静默失败，故原用例一直永久跳过；现 0 skipped |
| 3 | `clampDockWidth` / `dockWidthFromDrag` 抽到 `lib/dock.ts`；`tests/dock.test.ts` 含 §3.3 翻车的回归守卫 |
| 4 | 删 `nextTheme`；`App.tsx` 的日期戳改名 `formatSessionStamp`（同名异义消除） |
| 5 | `tests/helpers/temp.ts` 收走 12 个文件的临时目录生命周期（含异步版）；`net-change` 改为每例一棵新树，越界用例改为**真指向根外的存在文件** |
| 6 | `contract.test.ts` 加「防漂移回退、非行为覆盖」定位注释；8 处「只验非空」改为断言具体值 |
| 7 | ToolCard 展开态收敛为唯一真源（去掉实例本地镜像）；下钻请求带 `nonce`，不再依赖「对象身份」这个隐式依赖 |
| 8 | 新增 `tests/env-check.test.ts` / `tests/approval-config.test.ts` / `tests/icon.test.ts`；**顺带修一个真 bug**：`approval/config.ts` 把「能解析但非数组」的脏数据当成「用户清空白名单」，静默关掉自动放行 |
| 9 | `ConversationView` 删掉 `lane` / `cwd` / `faulted`（连动 worker 投影与冒烟夹具），契约里留注记防回加；`ERRORS.md` §三 / `UI-REGIONS.md` 加现状说明 |

> 第 8 项里那个 bug 是本轮唯一**改动了产品行为**的修复，其余都是契约/测试/文档层面的收敛。

---

## 八、方法论：我自己踩的坑（如实记录）

统计「`ConversationView` 各字段在渲染层被读几次」时，**第一遍所有字段都返回 0**——这显然不对（`messages` 不可能没人读）。

根因两条叠加：① 模式串用了 BRE，而 BRE 里 `?` 是**字面量**（应写 `-E`）；② **我没有先做正向对照**就采信了结果。补了对照（同一目录下 `messages` 命中 6 次）后立刻定位到是模式串的锅，重跑才拿到真数据。

这正是 `AGENTS.md` §五 记的那类错——「判『有没有』之前先确认『查得到』」，以及「必然为假的假阴性」。**记录在案，提醒下一个人：全 0 和「确实没有」要先区分开。**

---

## 九、本轮核对范围说明

诚实标注边界：

- **未查**：`docs/UI-REGIONS.md`（1191 行）与 `docs/NEXT-PHASE.md`（850 行）的全文逐条一致性——只核了数字、路径与自相矛盾；
- **未查**：`src/dev/smoke/` 各模式装置的**断言语义正确性**（只有 `dock` 因实跑 211/211 有了行为层面的验收）；
- **未查**：`memory-e2e` / `model` 两个**会打模型计费**的冒烟模式（未运行）；
- **只做了静态核对**：渲染层的 6.1 多重真源与 6.2 依赖问题，均由**读代码**判定，**没有真机复现**——要坐实「计时器对不上」「侧栏卡在新会话」，需要在 dev 里实际操作一次；报告里的判定是「有漂移的路径」，不等于「已经看到漂移」；
- `src/main/` 与 `src/worker/` 本轮**未重新深挖**（第一轮已覆盖边界与 god 对象）。

---

## 附：本轮已落地的文档修正

- `AGENTS.md`：删掉重复的 `## 三、产品判断纪律` 标题；§四 标题改为「易犯的思维习惯与陷阱（按『易复发度』归类，含已造成事故的）」；`207` → 不写死；`:347/:354` 的 `smoke.ts` / `smokeView()` → 现路径与现名 `viewBase`；
- `docs/GLOSSARY.md`：冒烟模式表补上**漏掉的 `memory` / `memory-e2e`** 两行；`dock` 207 → 211；表下加一句「条数仅作量级参考，验收以运行输出为准」。
