# 代码审查·第三轮：回归验证 + 从未核对过的 `UI-REGIONS.md`

> 同日前两轮：`docs/CODE-REVIEW-2026-09-17.md`（三维度全量）、`-part2.md`（回溯验证 + 渲染层）。
> 第二轮 §七 声称**九项修复全部落地**。本轮的第一件事是**用代码核实这句话**——
> 这个仓库最贵的事故正是「文档说做了、代码没做」（`formatSkillsForSystemPrompt` 只有定义没有调用点）。
> 第二件事是攻前两轮**明确列为未查**的最大项：`docs/UI-REGIONS.md`（1191 行，README 称「界面现状的真源」）。

---

## 实测基线（本轮亲自跑，非引用）

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.node.json` | **exit 0** |
| `tsc -p tsconfig.web.json` | **exit 0** |
| `tsc -p tsconfig.test.json` | **exit 0** |
| `node --test "tests/**/*.test.ts"` | **732 条 / 732 通过 / 0 失败 / 0 跳过**（4.9s） |

⚠️ **这本身就是一条发现**：`README.md:41` 写「2026-09-17 实测 664 条：663 通过 / 1 跳过」——
与实测差 **68 条**、且「1 跳过」已归零。那行字今天刚改过，仍然当天就过期。

---

## 一句话结论

**前两轮的修复大体是真的——九项里七项经代码/实跑验证落地，没有凭空捏造；但有两项是措辞失真（写了个代码里不存在的函数名）。**

真正的坏消息在别处：

1. **`UI-REGIONS.md` 已经不是「界面现状真源」**——它不是写错了，而是**停在 v1.44**：`/memory-tidy` 命令、对应 IPC 通道、左栏整块分支树面板全都没进去。区域规则仍可信，覆盖范围不可信。
2. **首轮 P0 的 god 对象与超长函数一项未解，且指标变坏**：`Conversation()` 从 1425 行涨到 **1657 行**（第二轮重构后反增 232 行）。
3. **新增一类前两轮没查的腐化：跨层同义阈值各写一份**（审批超时、嗅探字节数）——两份漂一个，主进程与 worker 就会一个已拒绝、另一个还在等，**静默挂死**。

---

## 一、回归验证：前两轮声称的修复，落地实况

判定依据一律是代码行为与真实调用点，不采信文档/注释自述。

| # | 第二轮声称 | 实际 | 证据 |
|---|---|---|---|
| 1 | 运行起始时刻收敛为单一真源；抽 `lib/session.ts` + `mergePersistedWithDrafts` | ⚠️ **措辞失真** | `mergePersistedWithDrafts` **全仓 0 命中**（真名 `mergeSessionList`，`lib/session.ts:35`）；起始时刻真源实为 `App.tsx:59` 的 Map，不在 `lib/session.ts`；`lib/session.ts` 仅 `App.tsx:26` 一处 import，Conversation 不用。草稿守卫（`:278`）与 `tests/session-list.test.ts:45-88` 为真 |
| 2 | `file-read` 越界用例改用 junction，0 skipped | ✅ | `tests/file-read.test.ts:47`；**实跑 12 pass / 0 skipped**；守 `main/file-read.ts:74-75` realpath 二次校验 |
| 3 | `clampDockWidth` / `dockWidthFromDrag` 抽到 `lib/dock.ts`，旧实现删除 | ✅ | `lib/dock.ts:27,43`；组件只剩 import（`Conversation/index.tsx:49,347,374`）；`tests/dock.test.ts` 94 行含 §3.3 回归守卫 |
| 4 | 删 `nextTheme`；日期戳改名 `formatSessionStamp` | ✅ | 全仓 0 命中（仅 part2 文档提及）；`lib/format.ts:95`、`App.tsx:767` |
| 5 | `tests/helpers/temp.ts` 收走重复生命周期 | ✅ | **15 个测试文件真 import**（不是建了没人用）；`net-change.test.ts:26-28` 每例新树 |
| 6 | 8 处「只验非空」全改为断言具体值 | ⚠️ **部分** | `contract.test.ts:1-31,89-123` 注释与相等断言为真；残留 `provider-factory.test.ts:26` `assert.ok(model)`、`:78` `length>0` |
| 7 | ToolCard 展开态收敛；下钻 `nonce` | ✅ | `MessageList.tsx:244` 读 prop（无本地镜像）；nonce 在 `WorkspaceDock.tsx:314-316` 递增、`ChangeDrilldown.tsx:272` 作依赖 |
| 8 | 三个新测试 + `approval/config` bug | ✅ | `env-check` / `approval-config` / `icon` 均存在；`approval/config.ts:37-44` 非数组→undefined→`:29-30` 回落默认 |
| 9 | `ConversationView` 删 `lane` / `cwd` / `faulted` | ✅ | `worker-protocol.ts:101-106` 已删并留注记；残余 `lane` 均为 harness API（`worker/entry.ts:681`、`telemetry.ts:22`），与 DTO 无关 |

**首轮 P0/P1 的当前状态**

| 项 | 状态 | 证据 |
|---|---|---|
| 3 死通道 + 1 死事件 | ✅ **已修，0 个**，且加了双向相等守卫 | `contract.test.ts:89-103` |
| `src/main/smoke.ts`（曾 4452 行） | ✅ 已迁出生产树 | 现为 `src/dev/smoke/{index,context,modes/}` |
| `Conversation()` god function | ❌ **未解，且变坏** | `index.tsx:107-1543` ≈ **1657 行**（原 1425）；hook 调用点 81 → 50（唯一改善） |
| 4 个超长函数 | ❌ 未拆 | `entry.ts:424-778` init ≈355 行、`:819-1033` handle ≈215；`session-manager.ts:252-435` resolveApproval ≈184 |
| `shared/` 纯度（静态 import pi） | ❌ 未修 | `shared/provider-factory.ts:11-12` 仍静态 import，仅缩到 77 行 + 注释声明「main/worker 专用」 |
| 路径越界两份实现 | ❌ 未统一（见 §二） | `policy.ts:214` vs `file-read.ts:45,74` |

> **规律**：能靠「加文件 / 加测试 / 删字段」完成的修复**全部真落地**；需要**动结构**的三项（拆 god 对象、拆长函数、拆静态依赖）**一项没动**。
> 这与第二轮自述一致（那三项本就不在它的九项范围内），但后果是仓库的结构债一分未减。

---

## 二、`UI-REGIONS.md` 首次核对（前两轮明确未查）

**结论：区域规则可信，版本表与覆盖范围不可信。可以照它做开发，但不能照它判断「现在有什么」。**

### 对得上的部分（✅ 逐条核实，结构层面干净）

| 条目 | 证据 |
|---|---|
| ⑦ `DockKind` 只有 4 个：`follow/browser/usage/rules` | `WorkspaceDock.tsx:54` |
| 4 个 kind **都有真实渲染分支** | `:744,746,734-742,751-758` |
| **无死菜单项**——「+」由 `closable` 推导，只列真有的 3 项 | `:93-103,119-120` |
| 下钻三层 `list/diff/content` + 面包屑 + ESC 三条回退齐全 | `ChangeDrilldown.tsx:37,359,325` |
| 宽度常量 544 / 折叠 44 / 右≥220 中≥360，与文档同值 | `WorkspaceDock.tsx:134,137`；`lib/dock.ts:14,17` |
| 浏览器 400ms 重申、观测抽屉 1s 轮询 | `:438`；`ObserveDrawer.tsx:47` |
| ② 会话头只剩「统计」「规则」两个入口 | `index.tsx:1005-1018` |
| ⑥ Live Bar 四态 + `runStateOf` 纯函数 | `index.tsx:1425,1478-1486`；`lib/format.ts:47` |
| 容器查询六档 900/760/620/560/520/400 | `styles.css:321-368` |
| 已删文件（`file-tree.ts` / `ToolsPanel` / `FilePanel`）确实不存在 | `lib/` 目录、`styles.css:262` |

> 值得单独表扬：这个仓库翻过两次车的「死菜单项」（`AGENTS.md` §3.6）**这次是干净的**——菜单由 `closable` 推导这条机制守住了。

### 对不上的部分

| # | 级别 | 问题 | 位置 | 说明 |
|---|---|---|---|---|
| 1 | **P1** | **`/memory-tidy` 全文没有** | `UI-REGIONS.md` 0 命中 | 代码里命令（`lib/slash-command.ts:29,33,142`）、IPC 通道（`protocol.ts:252`）、候选项**都已实现**；README:66 已收录，唯独这份「界面真源」没有 |
| 2 | **P1** | **左栏分支树面板全文没有** | `UI-REGIONS.md:92` 写「只有项目→会话两层列表」 | 实际左栏下半是整块分支树面板，可点跳转（`App.tsx:505-512`、`features/BranchTree.tsx`） |
| 3 | **P2** | 版本表停在 v1.44 | `:1136` | 代码已越界（第 1 项），没有 v1.45+ 条目 |
| 4 | ~~P2~~ | ~~IPC 通道数写「47 → 48」~~ | `:1067` | **误判**：该行在「## 六、版本」里，是当时提交的验收快照，不是当前陈述（见 §五 更正 2） |
| 5 | ~~P2~~ | ~~验收基线写 599 / 207~~ | `:1175-1176` | **同上**：版本历史条目，改动等于篡改历史 |
| 6 | **P2** | ⑤ 承载含「**语音**」 | `:138` | `src/renderer/src` 全仓无任何 mic / 录音代码 → **虚构入口**。修法是改文档，**不要为了对齐去加语音** |
| 7 | **P2** | ⑥-C 阈值文案漂移 | `:174` vs `index.tsx:53,932,1470` | 文档说「如实显示 N 秒没动并转琥珀」，实际是「最后活动 Ns 前」+「似乎卡住了，可中断」，阈值 30s 未写入文档 |

---

## 三、架构腐化：本轮新发现

### 3.1 【P1】跨层同义阈值各写一份 —— 本轮最该修的一类

同一语义的阈值在 `main` 与 `worker` 各定义一次，**没有共享真源，也没有守卫**：

| 语义 | 第一份 | 第二份 | 漂移后果 |
|---|---|---|---|
| 审批超时 5 分钟 | `main/approval/store.ts:29` `DEFAULT_TIMEOUT_MS` | `worker/entry.ts:114` `APPROVAL_TIMEOUT_MS` | 主进程已自动拒绝、worker 还在等（或反之）→ **静默挂死**，界面停在「等待授权」 |
| 嗅探字节 8000 | `main/file-read.ts:28` `SNIFF_BYTES` | `worker/lib/baseline.ts:20` `SNIFF_BYTES` | 两侧对「是不是二进制」判定不一致 → 净值基线与实际预览分叉 |

这正是 `ARCHITECTURE.md` §三「契约只有一个真源」该覆盖却**没覆盖**的一类：那条纪律管的是**类型**，管不到**常量值**。

### 3.2 【P1】路径越界仍是两份实现，且审批闸门用弱的那份

- `main/approval/policy.ts:214` `isInside()` —— **纯字符串折叠**，无 `realpath`；被 `:556`、`:581` 用于越界拦截。
- `main/file-read.ts:45` `isWithin()` —— 含 `realpath` **二次校验**（`:71`、`:75`）。
- 两份**互不引用**。软链接逃逸这条防线**只在文件读取路径上有，审批闸门上没有**。

首轮已列为 P1#7，两轮之后仍未统一。

### 3.3 ~~【P1】常量语义串台~~ —— ⚠️ 本条是误判，见 §五 更正 1

~~`session-manager.ts:412` 注释称「默认 5 分钟兜底」，实际复用的 `DEFAULT_TIMEOUT_MS` 是**审批**超时常量当**就绪超时**兜底。~~

实际读代码：`:412` 位于 `#armApprovalTimer` 内部，它起的**就是**审批超时定时器，用的就是审批超时常量——语义正确，没有串台。这一条是把「函数名看着像别的用途」当成了串台。

### 3.4 跨层边界：干净（正面）

- worker **无** electron / 窗口 / OS 权限调用；
- main **无**直接调模型；
- 渲染层 **无** fs 直读（密钥只经 `secrets.set` IPC，主题用 localStorage）。

首轮判定「分层零违规」，本轮复查**依然成立**——这是这个仓库最结实的一项。

---

## 四、坏味道：前两轮未查的维度

### 4.1 【P1】状态查询伪造空值，掩盖失败

- `main/host/browser-host.ts:287` `stateOf()`：会话不存在时**伪造一个 `loaded:false` 空状态**，与「视图已建、尚未加载」（`#emitState(id, false)` 推出）**完全同形** → 调用方无从区分「没有浏览器」与「浏览器在加载中」。（危害等级以 §五 更正 3 为准：实际表现是状态保持为空，不是永久等待。）
- `main/ipc/index.ts:329` `session.view` `?? null` 同类。

对照 `docs/ERRORS.md` 的「不许静默」铁律：这里把**失败**伪装成了**合法的未就绪**。

### 4.2 【P1】坏入参被当空参数继续走规则匹配

`main/approval/store.ts:365` `safeParseArgs` 解析失败 → 返回 `{}`。
审批入参坏了会被当成「空参数」继续做规则匹配，可能命中过宽的 allow 规则。**这是安全路径上的静默降级。**

### 4.3 【P2】静默失败分布

- 空 / 仅注释 catch **15 处**（全部自带理由，属有意为之）；
- `.catch(() => …)` **24 处**，集中在渲染层 fire-and-forget：`Conversation/index.tsx:308,321,333,561`、`WorkspaceDock.tsx:400,408,426` —— 用户点导航 / 缩放 / 关会话失败，**界面零反馈**；
- `session-manager.ts:648` `void … .catch(() => undefined)` 吞掉就绪链路失败；
- `main/db/memory-index.ts:232` FTS MATCH 失败 → 静默回落 LIKE，无任何记录。

### 4.4 【P2】文档与实现名不副实

`ARCHITECTURE.md:209` 写「下载 **每会话 5 个** / 单文件 100MB」。
实际 `MAX_DOWNLOADS_PER_SESSION=5` **只用于观测缓冲截断与展示**（`browser-observe.ts:53-54`），**没有任何逻辑取消第 6 个下载**——文件照常落盘。上限是假的。

### 4.5 【P2】资源生命周期（整体健康，3 处小疏漏）

- `setInterval` **8 处全部**有 `clearInterval` 配对 ✅；
- `setTimeout` 24 / `clearTimeout` 21，未配对的 3 处是「复制成功提示」（`App.tsx:711`、`Markdown.tsx:35`、`ObserveDrawer.tsx:275`），卸载后仍 setState；
- 88 处 `.on(` 全落在 app 级 / per-webContents（随 `contents.close()` 销毁）/ per-child 进程，`webRequest` / `will-download` 有 `#networkHooked` / `#downloadHooked` 幂等守卫 ✅。

### 4.6 【P2】IPC 错误模式（正面）

47 个 `handle(...)` 仅 4 处 try/catch（`:97,111,187,197`），其余一律 throw 由渲染层接——**模式统一**。唯一不一致是 `browser.state.get` / `browser.observe` / `session.view` 走「静默返回空」（即 §4.1）。

### 4.7 注释与代码说反话（抽查 54 条断言性注释）

- 新发现 1 处：`FollowPanel.tsx:22` 仍写「本文件此刻已没有任何可点路径」，但同文件 `:83` 已有 `onOpenChanges`（总账 → 清单）——v1.29 的残留注释。
- 其余核对一致（`memory.ts:189`、`browser-host.ts:573` 守卫等）✅。

### 4.8 并发

`browser-host.ts:573` 与 `closeSession:1001` 有「条目还是不是它」守卫；`session-manager` 用 `[...this.#workers.values()]` 快照迭代；`branches()` 的 settle/timer 双向摘除配对正确。**无 TOCTOU 缺口** ✅。

---

## 五、修复优先级（第三轮）

按投入产出比。**前四条都是「小成本、消真风险」**：

| 顺序 | 动作 | 成本 | 收益 |
|---|---|---|---|
| **1** | 审批超时 / `SNIFF_BYTES` 两份常量收到 `shared/`，加一条「两侧同值」用例 | 小 | 消掉 §3.1 的**静默挂死**路径 |
| **2** | 统一越界判定：审批闸门改用 `file-read.ts` 那份含 `realpath` 的实现 | 小 | 补上审批侧的软链接逃逸防线（安全） |
| **3** | `browser-host.ts:287` 区分「会话不存在」与「已建未加载」，前者**报错**而非伪造空状态 | 小 | 消掉「永久等待」；呼应 `ERRORS.md` 的不静默铁律 |
| **4** | `approval/store.ts:365` 解析失败**不要回落 `{}`**，标记为「入参无法解析」并走最严判定 | 小 | 安全路径不再静默降级 |
| **5** | 修 README:41 的 664 → **732**（0 跳过）；`UI-REGIONS.md` 的 599/207、IPC 47→48 → 46 | 极小 | 数字类漂移本轮又抓到 3 处，**建议这两处直接删掉写死的数字，改为「以运行输出为准」** |
| **6** | `UI-REGIONS.md` 补 `/memory-tidy` 与左栏分支树；删「语音」；改 ⑥-C 阈值文案 | 小 | 让「界面真源」重新配得上这个名字 |
| **7** | 更正 part2 §七 的两处措辞失真（`mergePersistedWithDrafts` → `mergeSessionList`；起始时刻真源在 `App.tsx`） | 极小 | **文档必须能被执行**——写了个不存在的函数名，后来者 grep 不到会以为没做 |
| **8** | `provider-factory.test.ts:26,78` 两处残留弱断言改具体值 | 极小 | 补全第 6 项 |
| **9** | 3 处未配对 `setTimeout` 清理；`FollowPanel.tsx:22` 残留注释 | 极小 | 清尾 |
| **10** | `ARCHITECTURE.md:209` 要么实现「第 6 个下载被拒」，要么把文档改成「仅观测展示上限」 | 小 | 文档不再承诺一个不存在的上限 |

**关于结构债（god 对象 / 超长函数 / `shared` 纯度）**：三轮下来一项未动，且指标在变坏。
建议**不要**再做「一次性大重构」，而是设一条**可执行的闸**：在 `tests/` 加一条体量守卫（如 `Conversation/index.tsx` 超过当前行数即红），
先**止住漂移**，再谈拆分——这比任何一次大重构都更可能真的发生。

### 执行状态（同日，十项已按上表顺序处理）

**实测基线：三份 tsc 全绿；单测 747 条 / 747 通过 / 0 失败 / 0 跳过**（本轮新增 15 条）。

| # | 落点 |
|---|---|
| 1 | 新建 `src/shared/limits.ts`（`APPROVAL_TIMEOUT_MS` / `SNIFF_BYTES`）；`store.ts` / `session-manager.ts` / `entry.ts` / `file-read.ts` / `baseline.ts` 五处改为 import，本地定义删除。新增 `tests/limits.test.ts`（4 条）：断言值、**src 下除 limits.ts 外无同名定义**、**5 个消费方确实 import 自 `@shared/limits`**、守卫自身非空转。**已用探针验证**：在 `git.ts` 里插一份 `SNIFF_BYTES = 1` → 守卫立刻变红并指名文件，探针已撤回 |
| 2 | 新建 `src/main/lib/path-guard.ts`：`isWithinRoot`（纯字符串）与 `isWithinRootReal`（解真实路径）。`policy.ts` 的 `isInside` 转为转发、write/upload 两个调用点改用 `isWithinRootReal`；`file-read.ts` 改用共享判定；删掉只服务于旧实现的 `collapseRelative` / `collapseAbsolute`。新增 `tests/path-guard.test.ts`（10 条），含**两条软链接逃逸**（目标存在 / 尚不存在）与「尚未创建不算越界」。**已用探针验证**：把逃逸那条判定改成无条件放行 → 两条逃逸用例同时变红 |
| 3 | `browser-host.ts` 的 `stateOf` 在会话无视图时**抛错**，不再伪造 `loaded:false`；`#emitState` 加并发守卫（视图刚被关掉时按未加载推，不让状态推送崩掉） |
| 4 | `safeParseArgs` → `parseArgs`，解析失败返回 **null** 而非 `{}`；`evaluate` 在「本来要自动放行」时改为**挂起人工确认**并写明「无法解析本次工具入参」。新增用例钉住「坏入参不被工具级记忆放行」。**已用探针验证**：把拦截改回放行 → 该用例变红 |
| 5 | `README.md` 测试条数改为「**以运行输出为准**，不写死」 |
| 6 | `UI-REGIONS.md`：新增规则 ⑤-F（三条斜杠命令及两类语义）、左栏补**会话分支树**、⑥-C 校准为实际口径（`STALE_IDLE_SEC = 30`、「最后活动 Ns 前」+「似乎卡住了，可中断」）；删除虚构的「语音」入口 |
| 7 | `part2` §七 更正：`mergePersistedWithDrafts` → 真名 `mergeSessionList`；起始时刻真源位置订正为 `App.tsx` 的 Map |
| 8 | **核查后无需改动**——见下方更正第 3 条 |
| 9 | 三处「复制成功」提示（`App.tsx` / `Markdown.tsx` / `ObserveDrawer.tsx`）的复位定时器改为 **effect 托管**（卸载即 `clearTimeout`）；`FollowPanel.tsx` 的残留注释订正为「文件行不再各自可点，可点入口只剩总账一行」 |
| 10 | **改文档与代码注释使其诚实**：`ARCHITECTURE.md` 与 `browser-host.ts` 文件头都改为「5 是观测列表条数上限，**不阻止下载**」。**未实现数量限制**——那是一次产品行为变更（第 6 个下载会被取消），且冒烟无法在本轮实跑验证，故留给明确决策，不擅自改变行为 |

### ⚠️ 自查更正：本轮报告自己查出的四处误判

回读代码逐项落地时，发现**本报告有四处的判断站不住**。就地更正，不改结论只改依据：

1. **§3.3「常量语义串台」是误判。** `session-manager.ts:412` 就在 `#armApprovalTimer` 内部，
   它起的**就是**审批超时定时器——借 `DEFAULT_TIMEOUT_MS` 当审批超时兜底，语义正确，没有串台。
   （「两者恰好同为 5min 所以没出事」这个说法也不成立：它们本来就是同一个语义。）
2. **§二 的「UI-REGIONS 数字漂移」第 4、5 条是误判。** IPC「47 → 48」与「599 / 207」
   都出自 `## 六、版本` 章节，是**当时那次提交的验收快照**，属于历史记录而非当前陈述，
   改成 46 / 732 反而篡改历史。**真正漂移的只有 `README.md:41`**（它描述的是当前状态），已修。
3. **§4.1「渲染层会停在永久等待」是夸大。** 渲染层在 `.catch(() => undefined)` 里吞掉了错误，
   实际表现是视图状态保持为「没有浏览器」（等价于初始的 `null`），**不是永久等待**。
   不过「两种状态同形、调用方无从区分」这一点成立，故仍按原计划修了，只是危害等级应降为 P2。
4. **§五 第 8 项「弱断言残留」是虚惊。** `tests/provider-factory.test.ts:26` 的 `assert.ok(model)`
   是给 `find()` 做**类型收窄**（其后每条用例都断言具体字段），`:78` 的 `length > 0` 是
   **防止目录为空时下面的 `deepEqual` 恒真**（注释里写明了）。判断弱不弱要看这条断言
   **是否独立承担验收**——只给后面的真断言清场的，不是弱断言。详见 `part2` 的更正小节。

> 这四条里，前两条是「把历史快照当成当前状态」与「没读调用点就下结论」，
> 正是 `AGENTS.md` §3.5 与 §四 反复记过的错。**写进审查报告的判断同样要先读代码，
> 不能因为它是「分析报告」就免检**——报告里的错会指挥别人去改不需要改的地方。

---

## 六、本轮范围说明（诚实标注边界）

- **未跑**：`dock` / `fixture` 冒烟（需起 Electron GUI，本轮未运行）→ README 与 GLOSSARY 里的 **211 / 25** 两处数字本轮**未验证**；
- **未跑**：`model` / `memory-e2e`（会打模型计费）；
- **未查**：`docs/NEXT-PHASE.md`（89176 字节）全文逐条一致性——前两轮也只核了数字与路径；
- **未查**：`src/dev/smoke/modes/` 各模式的**断言语义正确性**；
- **静态判定**：§3.1 的「漂一份就静默挂死」是**读代码推出的路径**，未真机复现；
- 常数统计均做了**正向对照**再采信（对照项：`removeAllListeners` 命中 `dev/smoke/index.ts:75`，证明「0 命中」不是模式串的锅）。

---

## 附：本轮与前两轮的关系

| | 第一轮 | 第二轮 | **第三轮** |
|---|---|---|---|
| 主攻 | 三维度全量扫描 | 回溯 AGENTS.md + 渲染层 | **回归验证 + UI-REGIONS 首次核对** |
| 新增维度 | 契约覆盖、死导出、测试语义 | 死导出、DTO 字段、多重真源 | **跨层同义常量、资源生命周期、静默失败分布** |
| 落地 | 契约守卫 | 九项修复（七真两失真） | 未改动任何代码，仅产出本文档 |
