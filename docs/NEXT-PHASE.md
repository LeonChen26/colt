# Colt · 下一阶段计划（开发交接）

> 上一阶段（2026-09）已把设计稿与代码的差异**全部收敛**，批次 A / B / C 均已收口。原 `DESIGN-TO-CODE.md`
> （差异收敛清单）随之完成使命并删除，其中仍然有约束力的「已定调」条目转记于 §2。
> **本文档是下一阶段的待办来源**，也是新会话的交接书。

**新会话接手阅读顺序**

必读（四份，半小时内看完）：

1. `README.md` — 这是什么 / 怎么跑 / 文档路标；**要动手再加 [`CONTRIBUTING.md`](../CONTRIBUTING.md)**（环境、命令、测试与冒烟、代码地图、提交前检查）
2. `AGENTS.md` — 纪律。尤其 **3.5：动手前先 `read` 代码**；截图只作视觉参考，不作功能依据
3. `docs/PRINCIPLES.md` — 设计原则八条 + **逐条现状**（哪条欠账、哪条已废弃，一眼可查）
4. 本文档

按需（做哪类改动读哪份）：

| 你要做的事 | 读 |
|---|---|
| 看懂某个编号（`⑦`、`A3-4`、`N1`、`事 B`） | `docs/GLOSSARY.md` |
| 改界面区域 | `docs/UI-REGIONS.md` — **界面现状的真源**（区域定义 + 版本表，落地细节都在版本表里） |
| 跨进程改动：加 IPC 通道 / 加 worker 命令 / 加右栏视图 / 加表字段 / 加工具 | `docs/ARCHITECTURE.md` — 每条都写了「要走哪几步」 |
| **升级 pi 依赖、或想知道我们依赖内核的哪些契约** | `docs/ARCHITECTURE.md` §四 — 接缝清单 + 升级检查清单（**动手前必读**） |
| 碰审批、文件读写、浏览器 / 电脑控制、密钥 | `docs/SECURITY.md` |
| 写任何可能失败的路径 | `docs/ERRORS.md` |
| 想看视觉 / 交互的历史概念稿 | `docs/archive/prototype-work-browser-hifi.html`（**归档的概念稿，不等于产品现状**） |

> 📌 本文提到的 `v3 §X` 指**已删除的 v3 设计稿**（其可执行结论已并入 `docs/UI-REGIONS.md`）；
> 「原型」指 `docs/archive/` 下的两张概念稿。二者都**不是当前的能力清单**。
> 已完结批次的审查 / 交接记录（含「右栏工作现场重组」⑦-G / ⑦-H 四步）都在 `docs/archive/`，
> 只在追溯历史时看，**不要再从那里接活**。

**交接摘要（30 秒版）**

- **现在在哪**：批次 A（⑦ 右栏工作区）/ B（浏览器操作面）/ C（⑥ 状态语义）**全部收口**（2026-09，见 §3.2 索引）；
  另有**独立的一批**「右栏工作现场重组」（⑦-G / ⑦-H）**四步已全部落地**（`UI-REGIONS` v1.29 ~ v1.32）；
  观测抽屉的**条目详情**已落地（`UI-REGIONS` v1.33；时间戳 / 耗时 / 请求头**未做、未排期**）。
  **2026-09 全库缺陷审计**：按用户指令重新审读代码找 bug，确认并批量修复一批
  （工具卡展开态丢失 / 自动滚底抢滚动 / newSession 闭包 / 导航清缓冲时机等，清单见 `UI-REGIONS` v1.35）；
  3 处上报经核实不修（Esc 已有守卫 / 全量授权不清队列是刻意设计 / 并发投递常规路径不可达）。
  验收基线：`typecheck` + **单测全绿**（条数以运行输出为准，当前 **1158**） + `build` + `fixture` **25/25** + `dock` **255/255** + `model` **61 条（7/6/6/6/3/33）**。
- **下一步做什么**：暂无排期——原 §3.1 的 **N1–N4 已按用户指令删除**（2026-09），
  新计划确定后再写回 §3.1。
- **别重开**：§2 的「已定调」条目（尤其 ⑦ 的宽度是**全局统一值**、⑥ 的**四态**语义）。
- **别引用旧结论**：§2 末尾的「已订正的事实」——那几条曾经写反过，别再照着做。
- **别重踩**：上一阶段踩过的坑记在 `AGENTS.md` §五（原生视图不参与 DOM 叠层、电平状态别用边沿事件同步、判据别用会被钳住的量……）。

---

> 📌 本文提到的具体数值与版本以 `docs/UI-REGIONS.md` 的版本表为准，本文只记计划与纪律。

## 1. 现状基线（建立方位，细节仍以代码为准）

| 区域 | 现状 |
|---|---|
| ③ 左栏 | 项目 → 会话列表（**只有这两层**，v1.66 起）；运行中会话带绿点与计时——**绿点与计时挂在会话行上**（`App.tsx` 的 `SessionRow`）。⚠️ **「会话分支树」面板已删**（`features/BranchTree.tsx`，v1.66）：分支的唯一界面入口改在 ④（每条回复下面一行「从这里分叉」，规则 ④-K），`session.branches` 保留但无消费者 |
| ② 会话头 | cwd + git 分支 chip（游离 HEAD 转琥珀色、窗口获焦刷新）；**统计 / 规则两个入口**（⑦-H 把原来的「改动 / 用量 / 工具 / 规则」四个收敛成两个：「改动」改由「任务摘要」底部的总账进入下钻（⑦-G，v1.32 连页签一起取消）、「工具」整体并入了「统计」，v1.30） |
| ④ 会话流 | 思考轨、工具卡（**内嵌 diff**）、授权卡；工具卡默认折叠为一行。⚠️ 注意**没有「变更卡」**：`ProjectChanges` 是**主区整页**（项目级跨会话汇总，由 ① 的「改动」打开），不在 ④——④ 禁止跨会话信息 |
| ⑤ 输入区 | 模型选择、附件（图片 / 文件）、审批模式、**思考等级**（v1.38，默认「高」）、**`/compact` 手动压缩入口**（v1.34）、**`/skill <名字>` 技能调用**（v1.42）、**敲 `/` 弹候选浮层**（v1.44：技能与 `/compact` 的可发现入口，选中即写入输入框）、发送 / 停止；Enter 发送或插话 |
| ⑥ Live Bar | 位于输入区**下方**，**只读区、不放任何操作**：上下文条（>70% 转琥珀、>90% 转红）+ 成本 + 心跳 / 最后活动 / 「似乎卡住了」；心跳等周期定时器**窗口不可见时暂停、回可见立即补跳**（v1.51，F11）；**压缩入口在 ② 会话头**（上下文 >70% 才出现，v1.34）——⑥ 这里只有条，没有按钮；非运行态有明确四态——**运行中 / 已中断 / 已失败（带 error 摘要）/ 空闲**（C1+C2） |
| ⑦ 右栏 | **工作区容器**：页签只有**五种 kind**——「任务摘要 / 浏览器 / 统计 / 规则 / 事件」（`follow` / `browser` / `usage` / `rules` / `events`；「事件」是 F3 安全事件流的回查页签，v1.50）；浏览器是内嵌 `WebContentsView`（独立 partition），首次加载自动切页签，页签底部带**观测抽屉**（B2：控制台 / 网络 / 下载；**每行可点开展开完整字段 + 复制**，v1.33——**时间戳 / 耗时 / 请求头仍未做、未排期**）；宽度是**全局统一值 544**（不随页签变，v1.24）。**⑦-G / ⑦-H 的重组已全部落地**：「任务摘要」= 计划 + 紧跟其下的一行总账（v1.29；第一段「计划」v1.48 加；「进行中的动作」段 v1.53 删，此刻动作只在 ④），点总账或工具卡路径进入**下钻**（清单 → diff → 文件内容，v1.32）；原「改动」「文件」两个页签**整个取消**，「工具」并入「统计」（v1.31）——故「+」菜单共 **4 项**（`browser / usage / rules / events`，v1.50 起） |
| 宿主能力 | 浏览器（`host/browser-host` + `browser-observe`）、桌面控制（`host/computer-host`）、输入合成（`host/input-keys`），统一经 `HostBridge` 路由 |
| 审批 | 按工具风险分级（`safe / moderate / dangerous`）+ 四档动作（允许一次 / 本会话内始终允许 / 拒绝一次 / 始终拒绝）+ 可见倒计时超时；会话级记忆规则可列出 / 删除，切 full-access 时清空。**待批是多张卡（列表渲染），没有键盘入口** |
| 已有面板 | 统计 `UsagePanel`（原「用量历史」，v1.31 重写为 KPI + 按模型 + 工具次数 / 耗时排行 + 可筛明细）、审批规则 `RulesPanel`——**两个都已迁入 ⑦ 页签**（A3-5，2026-09），不再是中栏浮层。**改动 `ChangesPanel` 与「工具」`ToolsPanel` 已删除**：前者并入「任务摘要」的下钻清单（⑦-G，v1.32），后者并入「统计」（⑦-H，v1.31） |
| 浏览器观测 | `host/browser-observe.ts` 的 `CaptureBuffer`（console / network / downloads）；B2 起在浏览器页签内以**底部抽屉**（`ObserveDrawer`）呈现，读的是与 `browser_read` **同一份**缓冲；**已有条目详情**（点行展开字段表 + 复制，v1.33），**仍缺时间戳 / 耗时 / 请求头**（未排期） |
| 三栏尺寸（实测） | 窗口 1440 → 三栏可用宽 **1184**（即左栏 + 内边距约占 256）；左栏 `w-[240px]` + 1px 边框（`--w-sidebar: 248px` 这个令牌**声明了却无人引用**）；右栏统一 544、下限 220；中栏下限 360。**三栏同时拿到各自下限需要窗口 ≈ 836**（256 + 360 + 220）；再窄时右栏被钳在 220 不动，而**中栏会继续被压**——grid 是 `minmax(0, 1fr)`（`index.tsx:832`），**没有硬兜底**——已知缺口，未排期 |

---

## 2. 已定调，不要重新讨论

- ⑦ 是**工作区容器**，不是浏览器专用栏；以页签切换视图，「任务摘要」是默认视图且**不可关闭**（可折叠）
- 浏览器载体是 `WebContentsView`，**不回退到独立窗口**；页面用**独立 partition**
- 视图**懒创建**：未激活的页签不创建 WebContents
- ⑥ 是**只读区**，不放任何操作（中断属于 ⑤）
- ⑥ 的位置在输入区**下方**
- **⑦ 的宽度是全局统一值 544**（v1.24）——**不按页签取建议值**。理由：按视图各给一个宽度会让切页签就改宽度、
  中栏跟着反复重排。**别再引入「每个视图一个建议宽度」**（原型的 `VIEW_RATIO` 就是这么画的，是刻意不采纳的）
- **⑥ 的非运行态是四态**（v1.25）：运行中 / 已中断 / 已失败（带 error 摘要）/ 空闲；
  **正常跑完回「空闲」**，不为一次正常结束留痕；状态是**电平**（留到下一轮跑完）
- 权限（审批）模式**在 ⑤ 输入区呈现**（工具行右侧的下拉）——它是「发送这条消息的参数」（⑤-A）。
  历史：曾记作「暂不处理」（当时它在 ⑥ Live Bar 里，属违规 #8），**该状态已被实现推翻**：现在它在 ⑤，⑥ 是只读区
- ③ 的 L1（模式切换）/ L2（功能入口）分层：功能尚未落地，规则**暂无适用对象**
- **模型选择的优先级**（2026-09 定调）：

  **会话选定（`sessions.model_ref`）> 首个可用服务 > 内置默认**（`resolveSessionModel`）

  - 这条链上**只有第一级是「用户的显式意图」**，其余两级都是**回落**，只在选定缺失或
    **已失效**（服务被删 / 模型下线）时启用
  - 曾有过一级「预设（`presets.model_ref`）」夹在第一级与回落之间——2026-09 **随整个 presets 功能
    一起删除**，理由见 §3.2 的「预设」那条
  - 「可用」的判据是 `isUsableProvider`（`src/shared/model-ref.ts`）：**有模型**，且
    **不需要密钥 或 已配密钥**。**不能拿「配了密钥」当「可用」的同义词**——本地 / 自建
    endpoint（ollama、vLLM、llama.cpp …）本来就没有密钥，按「必须有密钥」判会把它们
    永远排除在外（用户明明跑着模型，却一个也用不上）。「要不要密钥」是**服务的属性**，
    由 `providers.requires_key` 显式声明（0 = 无需鉴权），推断不出来
  - 选定的显示值必须与**实际会用**的值同源：选定失效时界面显示回落结果，
    并提示「原选定 X 已不可用」（`displayModelRef` 的 `driftedFrom`）。
    **别再让界面展示一个永远不会被使用的模型**

### 已订正的事实（曾经写反过，别再照着做）

| 曾经的结论 | 真相 | 出处 |
|---|---|---|
| 「用户自己无法操作内嵌浏览器，缺的是按钮」 | **错**：那是个真实 `WebContentsView`，用户本来就能直接点它；缺的只是后退/前进/刷新按钮 | v1.19 |
| 「跟随线（follow line）可以收成右侧边缘标签 / 浮层」 | **过期**：跟随线在本产品里已不存在，它成了 ⑦ 的默认页签「任务摘要」（`FollowPanel.tsx`，v1.48 由「正在处理」更名）。v3 §8 的四档是按旧模型写的 | v1.23 |
| 「bing 首页自己不会横向溢出」 | **错在判据**：`documentElement.scrollWidth` 被页面自带的 `overflow-x: hidden` 钳到 `clientWidth`，是**必然为真的假阴性**。实测 `div.hp_body` 有 768px 最小内容宽，停靠区 <783 就真溢出（且没有横向滚动条，裁掉的部分用户够不到） | v1.21 → v1.23 |
| 「`faulted` 可以表达任务的异常结束」 | **错**：它是 harness `fault` 事件的**会话级硬故障**标记，内核**从不复位**它。轮次终态要看 `lastResult.status` | v1.25 |
| 「渲染层传下来的 `cwd` 就是读文件的根」 | **错**：根只在 `projects.root_path` 上（`sessions` 表不存 cwd），必须由主进程按 `sessionId` 查 DB 推出 | v1.13 |
| 「`file.read` 只收相对路径」 | **站不住**：工具入参里的 path 由模型给出，实测常是绝对路径；安全靠**越界校验**（先于任何 fs 访问），不靠限制写法 | v1.14 |
| 「浏览器该做成独立窗口，便于用户旁观与授权」 | **旧前提**，被 ⑦-C 推翻：内嵌恰恰更利于旁观。这是「把现状当约束」的典型（`AGENTS.md` §3.1） | v1.8 → 内嵌 |

---

## 3. 计划

### 3.1 下一阶段计划

> **本节暂空**：原 **N1–N4** 四条计划（观测条目详情 ② / 全局快捷键子集 / 响应式四档 / 停靠弹出双态）
> 已按用户指令删除（2026-09）。两点备忘：
> ① N1 的 ①（条目详情的纯前端那半）在删除前已交付（`UI-REGIONS` v1.33），是**事实**而非计划；
> ② N1 的 ②（时间戳 / 耗时 / 请求头）随计划一并删除，**不在待办里**——旧文档里的「② 待定」均已成为历史。
> 新计划确定后在此增补；若沿用「N」前缀，**从 N5 起**，别与历史编号撞车（`GLOSSARY.md` §四有历史对照）。

### 3.2 前置不具备 / 明确不做

- **D3 `/` 命令菜单**：后端没有命令注册（对齐 ACP `available_commands_update`）。白名单里只有**两条由前端本地识别**的命令：`/compact`（**零参数**，必须独占整条输入，v1.34）与 `/skill <技能名> [额外指示]`（**必须给名字**，v1.42；v1.43 起名字不存在时**在渲染层就地拦下**、且**不清空输入**）——两道阀从紧都是为了别把 `/compact 一下` 这类正常提问**静默吞掉**。**条件不具备前不动 UI**（做了就是死菜单，`AGENTS.md` §3.6）；v1.44 起做成了「敲 `/` 弹候选浮层」（`slashCandidates`，`UI-REGIONS` v1.44），它**不占工具行的常驻宽度**——「第 5 个控件装不下」是被**绕开**而非解决的。**仍然没有**对齐 ACP `available_commands_update` 的动态命令菜单：那需要后端注册机制，本仓没有、也不打算加。
- **事 B 浏览器多实例**：前置是 `UI-REGIONS` **§五** 待决 #7——agent 的 `browser_act` / `browser_read` 作用于**哪个**实例；且**必须与资源上限 / 挂起同时交付**（否则 5 个实例 = 5 个渲染进程）。账单提醒：`fixture` + `dock` 都按 `sessionId` 驱动，协议一改两边都要重写。推荐方向（同 #7）：agent 固定绑定会话主视图，用户额外开的页签标记为「我的浏览」——agent 工具面零改动。
- **终端视图**（原型的「+」菜单画了它）：需要新的 host 能力（**PTY**），而本仓 `package.json` **没有任何 pty / 终端依赖**——这是后端活，**别照着菜单补页面**。
  - ⚠️ **订正（2026-09，v1.48）**：本条原写「原型画了它和**任务摘要**」并一起归入「需要 PTY」——**后半句不成立**：PTY 只有「终端」需要。「任务摘要」的落地形态是**把 ⑦ 的默认视图从「正在处理」升为「任务摘要」并把计划清单放进去**（`UI-REGIONS` v1.48，已落地）。**「任务摘要」不再是缺口。**
- **整项目树**（A3-4 的范围 B / C）：产品只做了「本次动过的文件」，落地形态在 v1.32 又变了一次——从「文件」视图右栏的树（`file-tree.ts`）改成「任务摘要」下钻的**一层目录分组清单**（`change-list.ts`）。要不要做整项目树**先看有没有人真的需要浏览项目**，不排期。
- **预设（presets）——2026-09 已删除**（产品评估后拍板）：此前**只有 schema 与字段搬运、没有任何读写代码**（无 list / save、无 IPC 通道），界面也无入口；删除时把 `sessions.preset_id` 与那圈透传一并去掉（`db/index.ts` / `repo.ts` / `protocol.ts` / `ipc/index.ts`）。不留着的理由：那七列里**五列今天没有对应的产品面**、两列已由会话级持久化覆盖，而**最影响会话行为的审批模式它偏偏带不了**（`SECURITY.md` 明令不许持久化）——它是**推测性的**，不是预留位。真想解决「每次新建会话要重挑模型」，正解是一条**全局默认模型设置**。迁移口径：**没有加迁移**（`SCHEMA_VERSION` 仍为 **9**），新库不再有该列 / 该表、旧库保留（恒 NULL、无人读，无害），两条路径都实测过。
- **扩展宿主层（加载第三方扩展）——2026-09 明确不做**（方案选型后拍板）：评估过 Pi 生态（`pi-mcp-adapter` / `pi-web-access` / `pi-subagents` / `pi-lens` / `rpiv-ask-user-question` / `rpiv-todo`，**全部 MIT**，源码曾解包逐行复查——那份解包在本地私有目录、**未随仓库分发**），结论是**抄设计、不装包、也不自建扩展宿主**。三条否决理由：
  ① **UI 挂载点对不上**——那些包依赖 `pi-coding-agent` 的 `ctx.ui`（终端 TUI 抽象），Colt 是 React + IPC 双进程，装进来逻辑能跑、**画不出东西**（死入口，`AGENTS.md` §3.6）；本仓用的是 `pi-agent-core`，本就没有那层 API。
  ② **绕过审批闸门**——扩展是**代码**，在 worker 内以完整权限运行，副作用不是工具调用、天然躲开 `before_tool`；技能那条隐式信任通道可接受是因其「只是文本、不改盘」（`SECURITY.md` §技能节），代码扩展连这个辩护都没有。
  ③ **验收手段失效**——全部单测 + 冒烟都是对**自己代码**的断言，对第三方扩展内容无效，而冒烟仅开发期存在、生产侧无兜底。
  **替代路径（已选定）**：能力**内建**（像 `browser` / `computer` / `memory` 一样进 `AgentHarness.create({ tools: [...] })`，每个都过审批闸门）；可编程的行为交给**已支持的 Agent Skills**（声明式 `SKILL.md`、社区包直接丢进 `.agents/skills`）。**复用 Pi 生态的正确姿势是读它的源码抄设计，不是加载它的包。**

- **能力补齐进度（方案 C 之下，2026-09 起）**。顺序与依据来自那轮 Pi 生态对比：

  | # | 能力 | 状态 | 落点 |
  |---|---|---|---|
  | ① | `ask_user` | **已实施**（2026-09-18；2026-09 加多题翻页与自由输入，见 `UI-REGIONS` v1.65） | 单测 `tests/ask-user.test.ts`（14 条）+ `tests/question-store.test.ts`（9 条）+ `tests/question-answer.test.ts`（10 条）；冒烟 `ask-user`（39 条，免模型）+ `ask-user-e2e`（11 条，**打模型**） |
  | ② | web 搜索 / 抓取 | 未开工 | 只读白名单免审批；provider 进设置 |
  | ③ | MCP | **已实施**（2026-09-19） | 设计 `docs/DESIGN-mcp.md`；配置 `<cwd>/.colt/mcp.json` 与用户级 `~/.colt/mcp.json` **合并**（同名项目级覆盖）。传输 stdio + 远程（Streamable HTTP / SSE；SDK 已迁 `@modelcontextprotocol/*@2.0.0`）、`listTools` 分页、`${VAR}` 插值、配置热重载（设置页「重新加载」，**不必重启会话**）、工具重名去重、`resources` / `prompts` 能力面（**未声明就不加**）、server 自报 `instructions` 拼进系统提示词、展示名 `shared/mcp-label.ts`、notice 按 `kind` 分流、调用超时按 server / 工具可配。工具名 `mcp__<server>__<tool>` 不在任何豁免名单 ⇒ **天然过 `before_tool` 审批闸门**。单测 `tests/mcp-tools.test.ts`（42 条，真实 stdio / HTTP / SSE 往返）；冒烟 `mcp-e2e`（打模型）+ `mcp-real`（真实第三方 server）+ `mcp-reload`（免费，接线）。**仅剩**：worker 被强杀时**正在启动**的 MCP 子进程成孤儿（正常 dispose 走 `runtime.close()`） |
  | ④ | todo | **已实施**（2026-09-19） | 单测 `tests/todo-store.test.ts`（63 条）+ `tests/migration.test.ts` 的 v10；冒烟 `todo`（26 条，免模型）；设计 `docs/DESIGN-todo.md`；界面归属见 `UI-REGIONS.md` v1.48（⑦ 默认视图**任务摘要**，清单是它的第一段） |
  | ⑤ | 子代理 | **已实施**（2026-09-19） | 设计 `docs/DESIGN-subagents.md`（决策 D1–D10）；worker 侧 `lib/subagent.ts` + `lib/agent-defs.ts` + `lib/subagent-view.ts` + `lib/lane-ownership.ts`（新逻辑压进新文件，大户只留接线）；单测 `tests/lane-ownership.test.ts` / `agent-defs.test.ts` / `subagent-view.test.ts`；冒烟 `subagent`（免模型）。**执行侧三事实**（`subagent` 免闸门 / 内部写弹卡带归属 / `fresh` 隔离真实效果 / 清单真进提示词）由 `subagent-e2e`（打模型）覆盖，见 §5。**仍未覆盖**：子代理中止 / 超时墙钟的 e2e；导航守卫（`worker/lib/navigate.ts` 的 `applyNavigate`）由 `tests/navigate.test.ts` 覆盖，仍**未**走真实内核 `navigateTree` |
  | ⑥ | 写后诊断 | 建议后置 | `after_tool` 钩子；要先定「自动跑检查要不要过审批」 |

  **① 的入口级遗留**（别当成验过了）：worker 侧跳过闸门那条守卫与「全权模式下提问仍要弹」已由 `ask-user-e2e`（打模型）覆盖；仍未覆盖的是 worker **意外崩溃**那一支的收尾、以及提问的桌面通知（`notifyQuestion`）。

  **④ 的入口级遗留**（别当成验过了）：**镜像 → `transform_context` 的每请求注入**要走一次真实请求才到得了，`todo` 免模型冒烟不调模型 ⇒ 那个「模型在提示词里真的看得见清单」只有 `todo-e2e`（**打模型、计费**，尚未建）能覆盖；纯函数那半已由 `tests/todo-store.test.ts` 逐条钉住。另 **worker 意外崩溃**那一支的收尾同样未覆盖（同 ① 的缺口）。

### 3.3 v3 §10 优先级表里**仍开着**的项（不排期，但别丢）

> 其余项均已落地：P0 现场状态栏 / 授权卡 / 工具卡内嵌 diff；P1 思考轨 /「长时间无事件」；
> P3 分支树 / 用量历史页。
>
> ⚠️ **「跟随线」不能算「已落地」**：本产品里它**根本不存在**——它就是 ⑦ 的默认页签「任务摘要」
> （`FollowPanel.tsx`，v1.48 由「正在处理」更名）。v3 §10 / §8 里那两处「跟随线」是按**旧模型**写的（见 §2「已订正的事实」）。
>
> ⚠️ 一处**部分落地**：§10 的「授权卡（**四档 + 可见超时 + 取消**）」里，**「取消」是缺的**——
> 卡片上只有四个决定档位与倒计时，没有「取消这次请求」的入口；实际取消只能靠**中断整轮运行**
> （`session-manager.cancelPending` 在 `abort` 里被调）。若将来要补，走**键盘中断**（`Esc` / `⌘.`）
> 而不是往卡片上再加一个按钮——卡片上的四个档位已经够满，多一个控件反而更慢做决定。

| 项 | v3 依据 | 现状（实测） |
|---|---|---|
| 状态分组侧栏 | §10 P2（痛点 C） | ③ 会话列表已有**运行绿点 + 计时**，但**没有**按状态（进行中 / 待验收 / 已完成）分组 |
| 省流开关 | §10 P2（痛点 F：关流式、关动画） | **无** |
| 多会话监控 | §10 P3 | 部分（= 上面的绿点 + 计时）；没有集中监控视图 |
| 命令菜单 | §10 P2 | 见 §3.2 的 D3（后端前置不具备） |

---

## 4. 现成可复用的实现（别重写）

| 需要 | 已有 |
|---|---|
| 观测数据 | `host/browser-observe.ts` 的 `CaptureBuffer`（console / network / downloads，导航时清空） |
| 视图动作分发 | `HostBridge.handle` + `shared/worker-protocol.ts` 的 `HostCapability`（加动作只需加一个 `case`） |
| 原生视图摆放 | `host/browser-host.ts` 的 `#applyBounds`——**渲染层上报的矩形 + 可选 `viewport` 覆盖**（放大 / 全屏走同一机制，不需要新增） |
| 跨进程契约 | `shared/protocol.ts` 的 `IPC_CHANNELS` / `IpcInvokeMap` / `IPC_EVENTS`——**编译期强制对齐**，两侧必须同时改 |
| worker → 渲染层的视图契约 | `shared/worker-protocol.ts` 的 `ConversationView`；主进程 `#withDbChanges` 只是**透传**，加字段不必改主进程逻辑 |
| Markdown / diff 渲染 | `Markdown.tsx` / `DiffView.tsx`（文件预览的 Markdown 分支复用前者，见 `panels/FilePreview.tsx`） |
| 改动清单 / 文件预览 | `lib/change-list.ts`（纯函数 `buildChangeList`，按目录一层分组 + 越界过滤，有单测）/ `panels/ChangeDrilldown.tsx`（清单 → diff → 内容）/ `panels/FilePreview.tsx` |
| 统计聚合 | `lib/session-stats.ts`（纯函数 `buildSessionStats` / `formatTokenCount` / `formatToolDuration` / `toolCallSummary`，有单测） |
| 观测条目详情 | `lib/observe-detail.ts`（纯函数 `consoleFields` / `networkFields` / `downloadFields` / `observeCopyText` / 三个 `*RowKey`，有单测）+ `features/Conversation/ObserveDrawer.tsx` |
| 行级差异 / 净值 / 基线（v1.36） | `shared/line-diff.ts`（行级 unified patch）/ `main/net-change.ts`（净值：**基线 → 现在**）/ `worker/lib/baseline.ts`（改动前的内容快照）——**都有单测** |
| 代码着色 / 语言识别（v1.37） | `renderer/src/lib/code-lang.ts`（扩展名 → highlight.js 语言）/ `components/CodeView.tsx`（着色 + 行号；认不出则原样等宽、不猜）——**都有单测** |
| 思考等级 / 压缩错误（v1.38） | `shared/thinking-level.ts`（思考等级与默认值）/ `worker/lib/compact-error.ts`（压缩失败翻译）——**都有单测** |
| 项目内文件读取 | `main/file-read.ts`——相对/绝对皆收 + `realpath` 双重校验 + 上限 + 二进制判定，纯 Node 可单测 |
| （原）中心列面板样式——**这些面板现在渲染在 ⑦ 页签内**，不再是中栏浮层 | `features/Conversation/panels/` |
| 数字缩写 / 心跳点 / 窄栏降级 | `formatTokens`（**`Conversation/index.tsx` 里的局部函数，不是共享 lib**）/ `.live-dot`（含 `.stale-dot` / `.idle-dot` / `.danger-dot`）/ `styles.css` 的容器查询（**六档：900 / 760 / 620 / 560 / 520 / 400**） |
| ⑥ 状态判定 | `lib/format.ts` 的 `runStateOf`（纯函数 + 单测）——复用它，别在组件里再写一遍分支 |
| 周期定时器「不可见即停」（v1.51，F11） | `renderer/src/lib/visible-interval.ts`（纯逻辑，环境注入可单测）+ `use-visible-interval.ts`（React 包装，回调走 ref 不重启定时器）。语义：启动即跳一次、重新可见立即补跳再续周期。「不可见时暂停」本身由 `tests/visible-interval.test.ts` 逐拍覆盖 |
| MCP 工具装载 | `worker/lib/mcp-tools.ts`：`createMcpRuntime`（连接 / 包装 / `reload` / `status` / `close`）、`mcpToolName`、`mapMcpContent`、`closeMcpTools`；配置解析在 `shared/mcp-config.ts`（`loadMcpConfig` / `parseServerConfig` / `transportOf` / `targetOf` / `configKey` / `interpolateConfig`，都是纯函数，有单测）；热重载写回在 `worker/lib/mcp-reload.ts`；主进程那条「拿现状 / 点重新加载」的往返在 `main/session-manager.ts`（`mcpStatus` / `mcpReload` / `#queryMcp`，**等待预算 `MCP_QUERY_TIMEOUT_MS` 按 worker 侧的单步上限推导**，那个单步值在 `shared/limits.ts`——它被两侧各读一次，漂成两份就会假报超时）；设置页可见性在 `main/ipc` 的 `mcp.status` / `mcp.reload` + `renderer/src/features/Settings.tsx` 的 `McpSettings` |
| 复制到剪贴板 | `navigator.clipboard.writeText`（`App.tsx` 复制会话 ID、`Markdown.tsx` 复制代码已用）——**不需要新 IPC** |
| 冒烟里推「受控视图」 | `src/dev/smoke/` 的 `smokeView(over)`——不跑模型就能把任意 `ConversationView` 经 `session.view` 推入渲染层（A3-2 / C1 都这么测） |

---

## 5. 验收手段（成本从低到高）

> **验收一律以运行输出为准**：本文件与 `UI-REGIONS` 里写下的条数都是当时的快照，会随断言增补而漂。

1. **静态**：`npm run typecheck` + `npm test`（**条数以运行输出为准**）+ `npm run build`。
2. **冒烟**：一律 `npm run dev`（**必须 dev**：启动器被 `import.meta.env.DEV` 守卫，preview / 打包态不含它），
   用 `COLT_SMOKE="<名字>.png"` + `COLT_SMOKE_MODE="<模式>"` 选择，看 `out/<名字>.png.log` 末行的 `通过 N/M`。

| 模式 | 覆盖什么 | 打模型 / 计费 | 关键前置 |
|---|---|---|---|
| `fixture` | **浏览器能力本体**（改浏览器能力必跑） | 否 | 另开一个终端 `npm run fixture`；先停掉占用 5173 的开发实例 |
| `dock` | **右栏 ⑦ / ⑥ / 浏览器操作面**：主进程驱动渲染层**真派发鼠标事件**、并读原生视图状态（拖拽 / 折叠 / 宽度记忆 / 页签关闭与「+」新增 / 观测抽屉 / 原生视图与页面区域**逐像素对齐** / 任务摘要下钻 / 净值 / `/compact`·`/skill`·`/` 浮层） | 否 | 夹具站在进程内以 port 0 拉起；冒烟经 `pinVisibility` 把主窗口钉为「始终可见」并关掉后台节流 |
| `ask-user` | 提问**入队之后**的阻塞链路（卡片真出现 / 能点 / 多题翻页 / 自由输入 / 回车 / 超时收尾 / 不留悬空卡） | 否 | 走真实入队函数 `sessionManager.questions.enqueue()`；作成作答载荷用主进程打桩读回（只记账、不转发） |
| `ask-user-e2e` | 提问**入队之前**（模型是否看得见并调用 `ask_user`、是否被 `before_tool` 跳过闸门、全权模式下仍弹卡） | **是** | worker 生死交渲染层（`window.reload()` 等自动打开）；**别**自己抢 `session.open`（`AGENTS.md` §五末条） |
| `subagent` | 子代理呈现（④ 卡特化 + 有界预览 / 此刻动作只在 ④ / 「中止」在 ④ 卡面 / 不自动展开右栏 / 下钻子代理流） | 否 | 从主进程推**受控视图**驱动 |
| `subagent-e2e` | 子代理执行侧三事实（清单可见 / 免闸门 + 内部写弹卡带归属 / `fresh` 隔离） | 是（本地 Ollama 不计费） | 同 `ask-user-e2e`；小模型服从是概率事件，整条可重试 |
| `mcp-e2e` | MCP 只有真模型走得通的三段（提示词里可见 `mcp__` 工具 → 未知工具弹审批卡 → 批准后 stdio 真实往返） | 是（本地 Ollama 不计费） | `.colt/mcp.json` 用例现写；server 用 `ELECTRON_RUN_AS_NODE` 让 electron 按 Node 跑 |
| `mcp-reload` | MCP 热重载 + 设置页可见性的 **renderer → main → worker** 接线（冷启动装载 / 热加 / 热删 / 两个 IPC 形状 / 慢 server 不误判超时） | 否 | 夹具含一个**刻意全程不开会话**的项目专验退路与诊断 |
| `model` | 模型选择 / 会话生命周期六段（`[model]` / `fallback` / `keyless` / `no-usable` / `during-init` / `[session/draft]`） | 部分（含真调模型段） | 三段「这台机器上只有用例的服务」前提必须**显式建立**（`stashUsableProviders()`：带密钥的服务只删密钥、不删条目） |
| `memory` | 记忆检索**跨进程链路**（含项目隔离 / 关会话清上下文 / 二字词 LIKE 兜底） | 否 | **会话必须建在夹具项目下**，且跑完把仓库项目顶回 `project.list[0]`（最近打开优先） |
| `memory-e2e` | 记忆**行为质量**（固定 4 次真实调用） | 是 | 与 `memory` **相反**：夹具会话必须是渲染层自动打开的那个，**不要**顶回 `list[0]` |
| 其余（不给 `COLT_SMOKE_MODE` 时为 `basic`；`host` 最费） | — | **是** | 只想看界面时直接启动应用 + **系统级截图** |

⚠️ **关键前置（缺了会假红 / 污染用户数据）**：

- `model` 的「新建工作目录」落点由 harness 指到 `out/smoke-workspace`（`COLT_WORKSPACE_ROOT`，**固定路径**：override 原样使用，`upsertProject` 按 root_key 去重）；它默认落在**家目录**的 `~/.colt/<年月日-时分秒>/workspace`，那是用户真实工作产物目录，**自动跑时绝不能碰**（`AGENTS.md` §五⑩）。
- `memory`：用户级记忆**不注夹具**——真家目录 `~/.colt/memory.md` 不可写（写就是污染用户数据），其链路与项目级共用同一条消息路径，由单测覆盖。
- 冒烟把主窗口钉为「始终可见」并关掉后台节流（`src/dev/smoke/index.ts` 的 `pinVisibility`）——F11 之后「窗口不可见就停表」是产品行为，遮挡（Windows occlusion → `document.hidden`）期会假红；「不可见时暂停」本身由 `tests/visible-interval.test.ts` 单测覆盖。
- `npm run dev` 报 `Error: spawn UNKNOWN`（errno **-4094**）是本机「智能应用控制」拦了未签名的 `electron.exe`（与业务代码无关，`electron` 已精确 pin）；报 `does not provide an export named 'BrowserWindow'` 是 `ELECTRON_RUN_AS_NODE` 把 Electron 按成了 Node（**要 unset，设成空串没用**）——两条都见 `AGENTS.md` 最后一节。

**计费模式清单**：`dock`、`fixture`、`memory`、`perf`、`ask-user`、`mcp-reload`、`subagent` 是**不调用模型**的模式；其余模式（含不给 `COLT_SMOKE_MODE` 时的 `basic`）都会真实打模型并计费。`dock` 曾经的 `/compact` 段会把打桩转发给真实现而真发 prompt、写进用户真实会话历史，v1.41 起该段改为**只记账、不转发**（测试装置不许有副作用，`AGENTS.md` §五⑩）。

---

## 6. 推进节奏建议

- 一次一件事（仓库既有习惯：一个提交只做一件事）。**每件跑 §5 的 1**；
  改到 ⑦ / ⑥ / 浏览器就**同时跑 §5 的 2**（§5 每步都写了「什么时候必跑」）；
  改到会话流里的**阻塞态卡片**（授权卡 / 提问卡）或 `useBlockingCards.ts`，跑 `ask-user`；
  改到 MCP（配置 / 装载 / 热重载 / 设置页）先跑**免费**的 `mcp-reload`，动到审批闸门再跑 `mcp-e2e`（打模型）。
  ⚠️ `npm test` 里含**体量闸**：给已知大户加功能必须同时搬走等量旧代码，动手前先算
  净增行数（`AGENTS.md` §1.4）。
  ⚠️ 往 `dock` 加断言时**按批次分段、保留段头注释**（沿用现有写法）——它已有 200+ 条、
  单文件很长，**不要为了「整齐」顺手重构冒烟**；真要拆就单独一批做（`AGENTS.md` §1.1）
- **当前处于新一阶段的起点**：批次 A / B / C 全部收口（结论见 §2 与 §3.3；历史细节在 `docs/archive/`）；原 N1–N4 计划已删除，§3.1 暂空
- 另有一批**独立工作**「右栏工作现场重组」（⑦-G / ⑦-H）**四步已全部落地、已收口**
  （`UI-REGIONS` v1.29 / v1.30 / v1.31 / v1.32）——**不要再从那里接活**
- 动手前先做一件事：**确认相关「现状」还成立**（本文件的现状是 2026-09 读代码写的，代码会往前走）；
  若不成立，**先改本文件再动手**，别按过期描述实现
- 做完一件，**同时更新**：`UI-REGIONS` §六 版本表（区域规则）、本文档 §1 现状基线（若现状变了）。
  §5 相关计数（单测 / 冒烟条数）一并改——
  **别让文档里的数字落后于代码**（这是上一阶段反复吃过的亏）
- 任务跨会话时，把「已做到哪、下一步是什么」写回本文档（**这也是本文件存在的理由**）

> 上一阶段踩过的坑见 `AGENTS.md` §五（原生视图不参与 DOM 叠层、销毁路径必须判活、`capturePage` 拍不到原生视图、电平状态别用边沿事件同步、判据别用会被 `overflow` 钳住的量、「在 DOM 里」不等于「用户点得到」、写剪贴板要求文档聚焦、别断言内核错误字符串……）。
