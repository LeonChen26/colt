# Agent Skills 功能缺口报告（产品 + 架构）

> 报告日期：2026-09-19
> 范围：Agent Skills（`.agents/skills`）的**装载 → 系统提示词可见性 → 显式调用 → 渲染层呈现**全链路
> 方法：**读代码为主**（含解包核对内核 `pi-agent-core@0.85.1` 的调用点），文档只作设计意图参照；关键结论均给出行号证据。与 `architecture-critique-2026-09-19.md` 的关系：那份是全局批判，本份是 skill 单功能的深挖，不重复其结论。
> 前置结论：**接线层面达标**——内核那两条「只给函数、不替应用调用」的通道（`formatSkillsForSystemPrompt` / `resources.skills`）都已正确接上。本报告的火力全部集中在**产品面**与**结构面**。

---

## 0. 验证基线（本次实跑，非引用文档）

| 项 | 结果 |
|---|---|
| `npm run typecheck`（node / web / test 三份 tsconfig） | 绿 |
| `npm test` | `tests 1022 / pass 1022 / fail 0` |
| skill 专项单测（`tests/skills.test.ts` + `tests/skill-error.test.ts`） | `tests 23 / pass 23` |
| 内核版本 | `@earendil-works/pi-agent-core` **pin 0.85.1**（已解包核对，非推断） |
| 工作区状态 | 有未提交改动（`src/worker/lib/subagent.ts`、`src/dev/smoke/modes/subagent.ts`、`README.md`、`docs/GLOSSARY.md`、`docs/NEXT-PHASE.md`）。审计期间该文件正被编辑，typecheck 曾短暂报错，编辑落地后恢复绿——**与 skill 无关**，本报告不据此下结论。 |

---

## 1. 链路现状（先固定事实，再谈缺口）

```
① 装载        worker/entry.ts:305   loadSkillsForSession(skillDirs(cwd, homedir()))
                                    ├ 项目级 <cwd>/.agents/skills
                                    └ 用户级 <home>/.agents/skills（同名项目级胜出）
② 让模型看见  worker/entry.ts:398   systemPrompt: composeSystemPrompt(systemPrompt(cwd), skills.skills)
                                    └ 内核 system-prompt.js:1-21 只「提供」该函数、自身零调用 → 必须应用自己拼（已核实）
③ 按名调用    worker/entry.ts:381   resources: { skills } → 内核 lane.js:355-368 在 accept 的 case "skill" 里取值
④ 如实告知    worker/entry.ts:307   notice(kind:"security")
                                    → session-manager.ts:849-859 落 session_events
                                    → EventsPanel.tsx 由「事件」页签回查
⑤ 兜底自查    worker/entry.ts:937-962  state.meta.skills 命中检查 → lane.skill → 显式检查 Result.err
⑥ 渲染层拦截  Conversation/index.tsx:700-722  本地先判（reject 时不清空输入），worker 那条为兜底
```

**做对了的部分必须写在前面**（否则后面的批评不公允）：

1. 内核双通道都接上了，且 `skills.ts` 的模块注释把「不拼就是静默失败」写清楚了，单测也断言了「技能正文**不**进系统提示词（渐进披露）」。
2. 判错方向的代价不对称被反复体现：未知 `/xxx` 一律放行、裸 `/skill` 不吞、`resolveSkillCommand` 把 `undefined`（不知道）与 `[]`（知道且为空）**分开处理**（`slash-command.ts:93-98`）。
3. 内核失败走 `Result.err` 而非抛异常这个坑被显式处理，没有落入「敲了没反应」。
4. 文案单一真源（`shared/skill-error.ts`），渲染层与 worker 两条路径说同一句话。
5. v1.50 已把安全 notice 落库，「事件」页签可回查（`WorkspaceDock.tsx:109-111`）。

**链条能成立的关键前提（后面 A1 会重点谈）**：模型侧「自己想起来用技能」= 看到 `<description>` → 用 `read` 工具去读 `<location>`。这要求 `read` 在 `READONLY_TOOLS` 里（`shared/readonly-tools.ts:18-20`）**且**执行环境无工作区边界（内核 `harness/tools/path-utils.js:11-25` 只做路径归一化）。

---

## 2. 产品缺口

### P1 · 零技能时不可发现；有技能时也只有「名字」

- **零技能**：`describeSkills` 在「没装技能 + 无告警」时**故意返回 `null`**（`worker/lib/skills.ts:142-176`）→ 不发任何提示；敲 `/` 时 `slashCandidates` 只列 `/compact`、`/memory-tidy`（`slash-command.ts:137-158`）；起手区（`StartPanel.tsx`）无一句技能文案。唯一会告诉用户「技能该放哪」的文案是 `unknownSkillMessage(name, [])`（`shared/skill-error.ts:21-27`），而它**只在用户主动敲 `/skill <随便什么>` 时才会出现**——裸 `/skill` 按设计回落成普通提问。即：新用户没有任何路径知道这个功能存在。
- **有技能**：能拿到的只有一条 5 秒 toast（名最多 8 个 + 用法提示，`skills.ts:146-155`）和敲 `/` 时的名字列表。
- **没有浏览面**：`WorkspaceDock.tsx:94-112` 的 `DOCK_KIND_META` 只有 `follow / browser / usage / rules / events`，无 skills。

**同族功能的不对称**（这不是「还差一个面板」，是三套功能的产品完成度差了一档）：

| 通道 | 产品面 |
|---|---|
| 记忆 | 每请求注入 + 注入/读取失败告知 + 手动整理入口 `/memory-tidy` + 检索工具 `memory_search` + 索引落库 |
| 子代理 | `DESIGN-subagents.md` + 声明式定义 + ④ 活卡 + 「任务摘要」此刻段 + 下钻 + 可逐个中止 |
| **技能** | **一条 toast + `/` 浮层里的名字** |

> 建议：`/` 浮层在 `skills.length === 0` 时补一条**非命令**的说明项（灰字，例如「技能：把 `<项目>/.agents/skills/<名字>/SKILL.md` 放进去即装」），或在起手区加一行。成本极低，且不引入死控件。

### P2 · 调用在会话流 / 目录 / 分支树里「伪装成用户说的话」

内核把技能正文包成**一条 user 消息**（`<skill name="…" location="…">` + 全文 + `</skill>`，内核 `harness/skills.js:8-17`），它会被记进 transcript，于是三处都按「用户发言」处理：

| 呈现处 | 行为 | 证据 |
|---|---|---|
| ④ 会话流 | 渲染成**右对齐用户气泡**、`whitespace-pre-wrap`、**不截断不折叠** → 用户看到的是自己「说」过的一大段原始 XML | `MessageList.tsx:152-155`；`project.ts:261-279` 把 `role: "user"` 原样投影 |
| ② 会话目录 / TurnRail | `outlineOf` 只认 `role === "user"`，**每条都算一轮**，标签取「第一行非空文字」→ **标签就是 `<skill name="pdf" location="…">`** | `session-outline.ts:77-95`、`labelOf` 在 `:71-75` |
| ③ 分支树 | `projectBranchNodes` 对 `role === "user"` **无条件保留为节点** → 每次技能调用都在分支树上多一个可导航节点 | `project.ts:163-167` |

后果叠加：**轮次计数被技能调用污染**、目录标签出现原始 XML、消息流被长正文冲乱、且语义上把「系统替用户展开的技能」说成了用户的话。这是本报告里**最容易复现、也最容易修**的一条（渲染层加 `data-conv-skill` 标记 + 折叠；目录/分支树排除技能调用消息）。

### P3 · 模型「自己想起来用技能」完全不可见

模型侧唯一用法是读文件，界面上只会多出一张普通 `read` 工具卡。**没有任何信号表明「模型因为技能而改变了行为」**——而这恰是最该被观测的一件事（它直接决定模型怎么干活）。对比：记忆有检索/注入告知，子代理有「正在花钱」的可观测面（`DESIGN-subagents.md` 决策三）。

> 建议：`read` 工具卡命中「路径属于本会话已装载技能」时打一个「技能 X」标记；这在 `after_tool` 里就能判（技能路径集合在 worker 内存里现成）。

### P4 · 「装了哪些技能」是**状态**，却被当成**事件**播报

`describeSkills` 的「已加载 N 个技能（项目级 X · 用户级 Y）：…」在**每次 worker 启动**都会发一次 notice；主进程对 `kind="security"` 一律落库（`session-manager.ts:852-854`），而去重只覆盖**同一内容 5 分钟内**（`db/repo.ts:676-690`）。

→ 超过 5 分钟的 worker 重启（空闲回收、崩溃重启、新会话）都会在「安全事件」页签里再写一条同样的「加载成功」；**真正该长期可见的「当前装了什么」反而没有地方放**。状态与事件混在同一通道。

### P5 · 供应链信任没有关口

`.gitignore` 只忽略了 `.colt/` / `.workbuddy/`，**没有忽略 `.agents/`**。项目级技能因此可以随仓库分发——这是生态优势（对齐 agentskills.io 的团队共享意图），但代价没有被产品化：

- **clone 一个不可信仓库 = 它获得写你系统提示词的能力**，首次使用没有「确认信任 / 查看内容」这一步（对比：改文件要过审批闸门，而这是「改模型的系统提示词」）；
- 界面上**看不出某个技能来自项目级还是用户级**（toast 只给「项目级 X · 用户级 Y」的合计，不给单个技能的出处）。

### P6 · 生命周期只有「全有或全无」

- 没有单个启用 / 禁用；没有重新扫描；没有删除入口；没有「查看正文」。
- `disable-model-invocation` 这个安全相关开关只在通知里以一句话出现（`skills.ts:159-164`），用户得自己把它和「我为什么触发不了这个技能」对上。
- 技能装载后固定（见 A2），会话中途新增 `SKILL.md` 不生效，**且没有任何地方告诉用户这一点**。

### P7 · 成本不透明

技能正文整段进上下文、**无长度上限**（内核 `formatSkillInvocation` 不截断，本仓也未设 cap）。记忆块有截断 + 计数 + 指回文件，技能没有；用量面板也看不到「技能吃了多少 token」。一个几百行的 `SKILL.md` 被调一次，账单与上下文占用都是隐形的——与项目自己为 memory-tidy 立的「费用藏起来是静默」原则同源。

---

## 3. 架构缺口

### A1 · 正确但「零端到端」：模型可见性依赖一条没写进契约的隐性耦合

模型能用技能，依赖这条链**同时成立**：`<location>` 是绝对路径（有单测）→ `read` 在只读白名单里 → 执行环境无工作区边界。
后两条**没有任何断言**：把 `read` 移出 `READONLY_TOOLS`、或给它加根校验，用户级技能立刻退化成「列得出、读不到」的死条目，**而所有单测、计数、告警全绿**。这正是 `AGENTS.md` §四「只有定义、没有调用」的变体（这次是「只有配置、没有断言」）。

同时，`resources.skills → lane.skill → UnknownSkill / LaneBusy / Closed / InvalidMessage` 整条 worker→内核链路**无任何自动化覆盖**：`dock` 冒烟对 `skillOrReconnect` 只打桩记账（`dev/smoke/modes/dock.ts:2019-2027`），`entry.ts:937-962` 的三处接线（`resources.skills` / `composeSystemPrompt` / `meta.skills` / notice）也没有断言。

### A2 · 通道一致性：文档类热更新，定义类冻结

| 注入物 | 注入时机 | 证据 |
|---|---|---|
| AGENTS.md | **每请求**重新发现 + 重读 | `worker/lib/agents-md.ts:165-187` |
| 双级记忆 | 每请求重读 | `entry.ts:474-511` |
| todo 清单 | 每请求重拼 | `entry.ts:496-501` |
| MCP `instructions` | 每请求拼 | `entry.ts:507-509` |
| 子代理目录 | 每请求重拼（但**定义列表**是启动时装载） | `entry.ts:505-506`、`entry.ts:312` |
| **技能清单 + `resources.skills`** | **create-time 一次** | `entry.ts:395-398`、`entry.ts:381` |

技能偏偏是**最需要「刚写完就想试」**的那一类内容（写一个 `SKILL.md` 是分钟级动作），却享受不到任何热更新。架构选择本身没有错（避免每请求扫盘），但**代价没有被说出来**：新增技能只能开新会话。附带影响：技能正文在 create-time 读盘一次，若那一刻文件正被写入（编辑器半保存），会得到截断正文并作为一条 user 消息发出去，且不会重读——而每请求重读的通道天然规避了这个窗口。

### A3 · 契约不足以支撑任何技能 UI

`ConversationView.skills` 是 `string[]`（`shared/worker-protocol.ts:208-220`），**只有名字**：没有 description、没有来源层级、没有 `disableModelInvocation`、没有路径、没有装载告警。全仓唯一消费点是 `/skill` 的本地拦截（`Conversation/index.tsx:705`）与冒烟夹具。

→ **P1 / P4 / P5 / P6 之所以做不了，根在这里**：没有一条能承载「技能列表」的通道。想加技能面板，必须先扩 `ConversationView` 或新开一条 `skills.list`——这不是画个组件的事。

### A4 · 模型的「自选技能」是提示性约定，不是结构性能力

内核导出的工具面只有 `bash / edit / read / write`（`harness/tools/index.d.ts:1-5`），**没有 skill 工具**；内核也从不调用 `formatSkillsForSystemPrompt`。所以「模型用技能」全靠它读了描述后自觉去 `read` 文件：

| 能力 | 接入层级 |
|---|---|
| 子代理 | 一个**工具**（参数校验 + 闸门 + 返回结构） |
| MCP | 一组**工具** |
| **技能** | **一句提示词** + 一次文件读取 |

这不是缺陷（对齐标准的渐进披露），但要明确：**「启用一个技能」在结构上无法被保证，只能被建议**。

### A5 · 单一真源在 worker 内存，跨会话无结构化落盘

`LoadedSkills` 只活在 worker 进程里。worker 被空闲回收后，「这个会话之前装了哪些技能」只能靠下次启动重新扫盘；库里 `session_events` 存的是**文本**（`repo.ts:676-700` 只存 `message`），不是结构化清单。任何「回看 / 审计 / 跨会话对比」的需求，今天都没有数据基础。

### A6 · 去重与计数的归因假设不成立

`dedupeByName`（`skills.ts:51-66`）假定重名只发生在**来源之间**，`describeSkills` 又用「去重后总数 − 去重前项目级数」算用户级数（`skills.ts:144-145`）。而内核侧核实：单目录内**不去重**（`harness/skills.js:66-131`），`name ≠ 目录名` 只告警不丢弃（`skills.js:240-254`）。于是「`a/SKILL.md`（name: x）+ `b/SKILL.md`（name: x）」会打印：

```
已加载 1 个技能（项目级 2 · 用户级 -1）：x；项目级覆盖了同名用户级技能：x
```

**负数 + 把「同目录重名」说成「项目级覆盖用户级」**。触发概率低（需 frontmatter name 与目录名不一致且撞名），但该模块存在的全部意义就是「如实告知」——口径出错比不报更伤。根因是**没有按来源分别累计**，不是一处笔误。

---

## 4. 测试覆盖矩阵

| 被测物 | 覆盖 | 位置 |
|---|---|---|
| `skillDirs` / `dedupeByName` / `describeDiagnostic` / `describeSkills` / `composeSystemPrompt` / `loadSkillsForSession`（真目录 + 内核 loader） | ✅ | `tests/skills.test.ts` |
| `unknownSkillMessage` / `describeSkillError` | ✅ | `tests/skill-error.test.ts` |
| `parseSlashCommand` / `resolveSkillCommand` / `slashCandidates` | ✅ | `tests/lib.test.ts` |
| `/skill` 输入消费、`/` 浮层弹出→选中→写入→回车（**打桩只记账**） | ✅ | `dev/smoke/modes/dock.ts:2009-2190` |
| `resources.skills → lane.skill → UnknownSkill / LaneBusy` | ❌ | — |
| `entry.ts` 三处接线（`resources.skills` / `composeSystemPrompt` / `meta.skills` / notice） | ❌ | — |
| 「工作区外的技能文件 `read` 得到」 | ❌ | — |
| 技能调用在会话流 / 目录 / 分支树里的呈现 | ❌ | — |

前三行是「纯函数 + 真装载」的扎实覆盖；后四行正是 A1 / P2 说的事——**越靠近真实链路，覆盖越薄**。

---

## 5. 收束：两个视角指向同一个结构性原因

产品面缺的（浏览、管理、归属、成本、信任确认、可见性）与架构面缺的（热更新、契约、真源、端到端覆盖）**全部**落在一句话上：

> **技能只有「一份名字数组」这一种数据形态，且只在 worker 内存里、只在 create-time 生成一次。**

因此修法也不是「一个个补产品功能」，而是先把结构补上，产品面自然打开：

| 补结构 | 解锁的产品面 | 关联缺口 |
|---|---|---|
| ① `ConversationView` 扩成技能对象（description / 来源 / 是否禁自选 / 路径），或新开 `skills.list` 通道 | 技能面板、单个启用禁用、看出处 | P1 P5 P6 / A3 |
| ② 把「当前清单」从 notice（事件通道）挪到视图/状态通道 | 事件页签不再被例行装载灌水 | P4 / A5 |
| ③ 给技能调用消息一个专属标记与折叠（渲染层），目录/分支树排除它 | 不再伪装成用户发言、轮次不被污染 | P2 |
| ④ 模型读技能文件时在工具卡上标「技能 X」 | 自选技能可见 | P3 |
| ⑤ 零技能引导项 + `.agents/skills` 首次信任/出处展示 | 入口与供应链关口 | P1 P5 |
| ⑥ 补一条**免模型**端到端用例（`resources.skills` → `lane.skill` → 三种 `Result.err`）+ 一条「工作区外可读」断言 | 把隐性耦合变成契约 | A1 |

---

## 6. 建议动作与优先级

| 优先 | 动作 | 类型 | 可验证性 |
|---|---|---|---|
| 1 | ⑥ 免模型端到端用例 + 「工作区外技能可读」断言 | 纯测试，无产品口径争议 | 高（断言一条命令即可跑） |
| 2 | ① + ② 契约扩字段 + 状态出事件通道 | 结构改动，是后面所有产品面的前置 | 高（契约类型 + 单测） |
| 3 | ⑤ 零技能引导 + 供应链信任提示 | 界面文案/小交互 | 中（冒烟可断言） |
| 4 | ③ 技能调用的会话流/目录/分支树归属 | 渲染层 + 投影规则 | 高（冒烟可断言标签与轮次） |
| 5 | ④ 技能工具卡标记 | worker `after_tool` + 渲染 | 中 |
| 6 | A2 热更新（给技能一条「重新扫描」入口） | 需先定产品口径 | 低（先出方案） |
| 7 | A6 计数归因修正 + P7 正文长度上限 | 纯函数 / 取舍 | 高（补 2 条单测） |

**如果只做三件事**：第 1 项（把最脆的隐性耦合钉住，成本最低、收益最确定）、第 2 项（止住事件页签灌水 + 打开后续所有产品面的前置）、第 5 项中的零技能引导（决定「新用户能不能用上」）。

---

## 7. 落地记录（2026-09-19，本轮）

第 6 节里「可立即动手、无产品口径争议」的两项已实现并通过验证：

| 项 | 内容 | 落点 | 验证 |
|---|---|---|---|
| ⑥（A1） | 免模型的**接线端到端**用例：`resources.skills → lane.skill` 认得清单内的名字并跑完、`UnknownSkill` / `Closed` 走 `Result.err`、正文与额外指示真的进了 user 消息；外加「工作区外的技能文件 `read` 得到」 | 新增 `tests/skills-harness.test.ts`（4 条，模型用 `pi-ai` 的 faux provider 回放，不出网、不计费） | `tests 4 / pass 4`；且做过**变异验证**——把 `resources` 置空后该用例立刻报 `UnknownSkill`，证明断言不是「必然为真」 |
| ⑦（A6） | 计数/遮蔽**按来源归因**：`dedupeByName` 连来源一起收集（`{name, from, by}`）并返回去重后的 `counts`；同目录重名不再被说成「项目级覆盖用户级」，用户级计数不再为负 | `src/worker/lib/skills.ts` + `tests/skills.test.ts` | 新增 3 条纯函数用例 + 1 条**真装载**用例（两目录放同一 frontmatter `name`，验证内核确实返回两条同名、由我们兜住） |
| ②（P4/A3） | **契约扩字段 + 状态出事件通道**：`ConversationView.skills` 由 `string[]` 升为整份 `ViewSkill[]`（名字/说明/来源层级/是否对模型公开/路径），新增 `toViewSkills` 投影；`describeSkills` 收窄为 `describeSkillWarnings`，**只报事件**（遮蔽/解析失败/不对模型公开），不再播报「已加载 N 个技能」这条**状态** | `shared/worker-protocol.ts`（`ViewSkill`）、`worker/lib/skills.ts`、`worker/lib/project.ts`、`worker/entry.ts`、渲染层 `Conversation/index.tsx`（派生名字，保留 `undefined` 三态）、`docs/SECURITY.md`、`docs/UI-REGIONS.md` v1.53 | 单测 8 条（含 `toViewSkills` 的来源映射）+ 1 条「干净装载时一条通知都不发」；dock 冒烟 **216/216**（`/` 候选浮层夹具已改对象数组）；`npm run typecheck` 绿、`npm test` **1046/1046** |
| ③（P2/A3） | **技能调用不再伪装成用户发言**：`ViewMessage` 新增 `skill?: ViewSkillInvocation` 标记，投影时由 `parseSkillInvocation` 认出（只锚内核生成的固定开头两行 + `lastIndexOf` 取额外指示，**拿内核真函数 `formatSkillInvocation` 钉住**）；④ 会话流改画成可折叠的「技能 X」卡（默认收起、展开看模型实际收到的正文），② 会话目录与 ③ 分支树的标签/摘要改用单一真源 `skillInvocationLabel` | `shared/worker-protocol.ts`（`ViewSkillInvocation`）、`shared/skill-invocation.ts`（新）、`worker/lib/skills.ts`、`worker/lib/project.ts`、`renderer/src/lib/session-outline.ts`、`renderer/src/features/Conversation/MessageList.tsx`（`data-conv-skill` / `-toggle` / `-body`，并给正常气泡补 `data-conv-user`）、`dev/smoke/modes/dock.ts` | 单测 10 条（parser 4 · 投影 5 · 目录 1）+ dock 冒烟 3 条（卡片出现且无用户气泡 / 默认收起 / 展开可见正文）；做过**变异验证**——把投影里的 `skill` 抹掉后 2 条断言立刻变红 |

| ⑤（P1/P5）+ A2 | **技能进设置页**：设置页新增「技能」分区——逐个列出本会话装载的技能（名字 / 说明 / **出处** / 是否对模型公开 / 路径）、零技能时给放置路径引导、有项目级技能时补**来源提醒**（它会进系统提示词、影响模型行为）；新增「重新扫描」（走 `harness.setResources` 热更新，改完当轮生效、不必重启会话）。产品口径由用户定：**像 MCP 一样进设置页**，右栏只显示当前会话用到的技能 | `shared/worker-protocol.ts`（`SkillsStatus` / `skillsStatus` / `skillsRescan`）、`shared/protocol.ts`、新 `worker/lib/skills-command.ts`、`worker/entry.ts`、`main/session-manager.ts`（`#querySkills`）、`main/ipc/index.ts`、`renderer/src/features/Settings.tsx`、新 `dev/smoke/modes/skills-reload.ts` | 新增 `tests/skills-command.test.ts`（10 条：未就绪两副面孔 / 重扫写回 harness + 换容器 + 广播 / 启动即 publish / 先自查再投递）+ **新冒烟模式 `skills-reload` 10 条**（冷启动装载 / 加技能不重启会话 / 超长正文的全文与告警 / 两个 IPC 的有会话与无会话形状）——**这条链路此前零冒烟覆盖**（`mcp-reload` 只覆盖 MCP 那条同构链路） |
| ④（P3） | **技能工具卡标记**：模型不「调用技能」——它读了描述后自觉去 `read` 技能文件，界面上原本只有一张普通 `read` 卡。投影时判「这次 `read` 的路径命中某个已装载技能的文件」，命中就在 ④ 工具卡上打「技能 X」徽标 | `shared/worker-protocol.ts`（`toolCalls[].skill`）、`worker/lib/skills.ts`（`skillPathMatcher`）、`worker/lib/project.ts`（`skillOfReadCall` + `projectTranscript` 的可选 `matchSkill`）、`MessageList.tsx`（`data-tool-skill`）、`dev/smoke/modes/dock.ts` | 单测 6 条（`skillPathMatcher` 4 · 投影 2）+ dock 冒烟 2 条（带徽标 / 普通 read 不带）；**变异验证**——把 `matchSkill` 传空，投影那 2 条立刻变红 |
| P6（生命周期那半） | **设置页「查看正文」**：技能正文会进系统提示词、改变模型行为，用户有权看到它到底是什么。技能卡「查看正文」展开显示 **SKILL.md 全文**（只读、不可写、不落库）。为此新增 `ViewSkillDetail`（`ViewSkill` + `content`）——正文**只进按需查询**（`skills.status` / `skills.rescan`），**不进**每 50ms 推送的 `ConversationView` | `shared/worker-protocol.ts`（`ViewSkillDetail`；`SkillsStatus.skills` 升为它）、`worker/lib/skills.ts`（`toSkillDetails`）、`worker/lib/skills-command.ts`（`skillsStatusOf`）、`renderer/src/features/Settings.tsx`（`data-skill-toggle` / `data-skill-body`） | 单测 1 条（详情带**全文**、与给模型那份不同）+ `skills-reload` 冒烟 2 条（现状带全文 / IPC 里带正文）；单技能启用禁用与删除入口见下一行 |
| P6（生命周期·写那半） | **单个启用 / 禁用 + 「在文件管理器中显示」**：设置页每条技能加开关（`role="switch"`），关掉 = **完全不装载**（不进系统提示词、`/` 候选也**不列**），`/skill <被禁名>` 回「已被你禁用」而非「不存在」；偏好只写**项目级** `.colt/skills.json`，两层为**并集**（用户级禁用是全局的，项目级**不能**启回来，否则越权——这类开关置灰 + 说明）；**不做删除**，替代出口是「在文件管理器中显示」（`shell.showItemInFolder`，只认 `.agents/skills/<名字>/SKILL.md` 形状、文件不在如实回） | 新 `shared/skills-config.ts`（并集语义 / 读改写 / 坏文件不覆盖）、`shared/worker-protocol.ts`（`ViewSkill.disabled` / `ViewSkillDetail.disabledByUser` / `skillsSetDisabled`）、`shared/protocol.ts`、`shared/skill-error.ts`（`disabledSkillMessage`）、`worker/lib/skills.ts`（`enabledSkills` / `modelSkills` / `loadSkillsForSessionWithConfig`）、`worker/lib/skills-command.ts`（`applyDisable` / `dispatchSkills`）、`worker/entry.ts`、`main/session-manager.ts`（`skillsSetDisabled`）、`main/ipc/index.ts`（`skills.setDisabled` / `skills.reveal`）、`Settings.tsx`（`data-skill-switch` / `data-skill-reveal`）、`Conversation/index.tsx`（`/` 候选排除 + 本地拦截） | 新 `tests/skills-config.test.ts`（并集 / 去重 / 坏文件不覆盖等）+ `tests/skills.test.ts` / `tests/skills-command.test.ts` 扩充；`skills-reload` 冒烟 **+7 条**（禁用 → 落盘项目级 → `/` 候选排除 → 启用恢复 → `reveal` 两种拒绝形状） |
| P7（成本透明） | **技能正文长度上限**：正文整段进上下文、此前无 cap，几百行的 `SKILL.md` 被调一次账单与上下文都是隐形的。现给**模型**的那份副本超 `MAX_SKILL_BODY_CHARS`（8000）即截断并在尾部**指回文件**；**装载结果本身不截断**（设置页要看全文）；超限如实进装载告警（「模型只会收到截断后的正文」+ 点名） | `worker/lib/skills.ts`（`MAX_SKILL_BODY_CHARS` / `capSkillBodies` / `skillWarningParts`）、`worker/entry.ts`（`resources.skills` 用副本）、`worker/lib/skills-command.ts`（rescan 写回同一份口径） | 单测 6 条（限内同一对象 / 超限截断+指回+不改原对象 / 告警点名 / 限内不报 / 详情全文 / rescan 写回的是截断副本）+ **harness 端到端 1 条**（截断后的正文真的经内核进了 user 消息、超限部分不在）+ `skills-reload` 冒烟 2 条 |

改动后全量：`npm run typecheck` 绿，`npm test` **1104 / 1104**，dock 冒烟 **221 / 221**，`skills-reload` 冒烟 **17 / 17**（含新增的启用/禁用/定位 7 条）。

**落地时撞到的一条闸**：`entry.ts` 的体量棘轮（≤1032）当场报出超 3 行——闸**零余量**（`AGENTS.md` §1.4）。新逻辑已按规矩搬到纯模块（`toViewSkills` → `worker/lib/skills.ts`，顺带让它可单测），剩下超出的部分压缩的是我自己那几个新写的注释块，没有动既有行为。

仍未做：技能消耗的 **token 归属**（P7 的另一半——正文长度已有上限，但「这个技能吃了多少」仍看不到）；**删除**入口（本轮判断不做，改由「在文件管理器中显示」替代——删技能目录是不可逆操作，交给文件管理器更稳）。**P6 生命周期（查看正文 + 单个启用/禁用 + 定位）与 P7 正文长度上限已全部落地**：零技能引导与供应链出处提示（P1/P5）、工具卡标记（P3）、热更新口径（A2，设置页「重新扫描」）、「查看正文」与**单个启用/禁用**（P6）、正文长度上限（P7）均已实现并有单测 / 冒烟护住。

> 顺带记一条**同类但未动**的：子代理定义（`agentDefs`）的装载通知**仍是状态的播报**（`describeAgents` 每次 worker 启动都发「已加载 N 个定义」），与技能这次改掉的正是同一个毛病。本轮只做技能，未一并改——要做的话是同一套拆法。

---

## 附录：本报告涉及的文件索引

**本仓**
`src/worker/lib/skills.ts`、`src/worker/lib/system-prompt.ts`、`src/worker/lib/project.ts`、`src/worker/lib/agents-md.ts`、`src/worker/entry.ts`、`src/shared/skill-error.ts`、`src/shared/worker-protocol.ts`、`src/shared/protocol.ts`、`src/shared/readonly-tools.ts`、`src/main/session-manager.ts`、`src/main/ipc/index.ts`、`src/main/db/repo.ts`、`src/renderer/src/lib/slash-command.ts`、`src/renderer/src/lib/session-outline.ts`、`src/renderer/src/features/Conversation/index.tsx`、`.../MessageList.tsx`、`.../WorkspaceDock.tsx`、`.../panels/EventsPanel.tsx`、`.../StartPanel.tsx`、`src/dev/smoke/modes/dock.ts`、`tests/skills.test.ts`、`tests/skill-error.test.ts`、`tests/lib.test.ts`、`.gitignore`

**内核（解包核对，`node_modules/@earendil-works/pi-agent-core/dist/`）**
`harness/skills.js`、`harness/system-prompt.js`、`harness/runtime/lane.js`、`harness/tools/index.d.ts`、`harness/tools/read.js`、`harness/tools/path-utils.js`

**相关文档**
`docs/SECURITY.md` §技能、`docs/ARCHITECTURE.md` §四、`docs/NEXT-PHASE.md` §3.2 D3、`docs/UI-REGIONS.md` 规则 ⑤-F 与版本表 v1.42–v1.50、`AGENTS.md` §四、`reviews/architecture-critique-2026-09-19.md`（F3）
