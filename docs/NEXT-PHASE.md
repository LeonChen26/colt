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
  验收基线：`typecheck` + **单测全绿**（条数以运行输出为准，当前 **1158**） + `build` + `fixture` **25/25** + `dock` **247/247** + `model` **61 条（7/6/6/6/3/33）**。
- **下一步做什么**：暂无排期——原 §3.1 的 **N1–N4 已按用户指令删除**（2026-09），
  新计划确定后再写回 §3.1。
- **别重开**：§2 的「已定调」条目（尤其 ⑦ 的宽度是**全局统一值**、⑥ 的**四态**语义）。
- **别引用旧结论**：§2 末尾的「已订正的事实」——那几条曾经写反过，别再照着做。
- **别重踩**：§7 的坑（原生视图不参与 DOM 叠层、电平状态别用边沿事件同步、判据别用会被钳住的量……）。

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

- **D3 `/` 命令菜单**：后端没有命令注册（对齐 ACP `available_commands_update`）。
  目前白名单里有**两条命令**，都由**前端本地识别**：`/compact`（**零参数**，必须独占整条输入，v1.34）
  与 `/skill <技能名> [额外指示]`（**必须给名字**，v1.42；v1.43 起名字不存在时**在渲染层就地拦下**、
  且**不清空输入**）。判据都从紧：`/compact` 要求**独占整条输入**，`/skill` 要求命令字**整段相等**
  且名字非空——两道阀都是为了别把 `/compact 一下` 这类正常提问静默吞掉。除此之外仍无注册机制。
  **条件不具备前不动 UI**——做了就是死菜单（`AGENTS.md` §3.6）：技能清单**曾经**在渲染层拿不到
  （`ConversationView` 无此字段），**v1.43 已补上 `skills`**；**v1.44 起做成了「敲 `/` 弹候选浮层」**
  （`slashCandidates`，见 `UI-REGIONS` v1.44）——这条路**不占工具行的常驻宽度**，于是「第 5 个
  控件装不下」那个障碍是被**绕开**的，不是被解决的。
  **仍然没有**的是「对齐 ACP `available_commands_update` 的动态命令菜单」：那需要后端注册机制，
  本仓没有、也不打算加。另一条告知渠道（会话启动通知里列出技能名）也保留着——
  浮层只在用户敲了 `/` 之后才出现。
- **事 B 浏览器多实例**：前置是 `UI-REGIONS` **§五** 待决 #7——agent 的 `browser_act` / `browser_read` 作用于**哪个**实例。
  且**必须与资源上限 / 挂起同时交付**（否则 5 个实例 = 5 个渲染进程）。
  账单提醒：`fixture` 25 条 + `dock` **235 条**都按 `sessionId` 驱动，协议一改两边都要重写。
  推荐方向（`UI-REGIONS` **§五** 待决 #7）：agent 固定绑定会话主视图，用户额外开的页签标记为「我的浏览」——这样 agent 工具面零改动
- **终端视图**（原型的「+」菜单画了它）：需要新的 host 能力（**PTY**），
  而本仓 `package.json` **没有任何 pty / 终端依赖**。这是后端活，不是 UI 活——**别照着菜单补页面**
  - ⚠️ **订正（2026-09，v1.48）**：本条原写「原型画了它和**任务摘要**」并把两者一起归入「需要 PTY」——
    **后半句不成立**：PTY 只有「终端」需要。「任务摘要（执行进展、产物汇总）」不需要新宿主能力，
    它的落地形态是**把 ⑦ 的默认视图从「正在处理」升为「任务摘要」并把计划清单放进去**，
    决定见 `UI-REGIONS` **v1.48**（2026-09 已落地）。**「任务摘要」不再是缺口。**
- **整项目树**（A3-4 的范围 B / C）：产品只做了「本次动过的文件」，而且它的落地形态在 v1.32 又变了一次——
  从「文件」视图右栏的树（`file-tree.ts`）改成「任务摘要」下钻的**一层目录分组清单**（`change-list.ts`）。
  要不要做整项目树**先看有没有人真的需要浏览项目**，不排期
- **预设（presets）——2026-09 已删除**（产品评估后拍板）。它此前**只有 schema 与字段搬运、没有任何读写
  代码**（无 list / save、无 IPC 通道），界面上也没有入口。删除时**连 `sessions.preset_id` 与那圈透传
  一并去掉**（只删表会留下一个指向不存在表的悬空引用，不自洽）：`db/index.ts`（建表 + 列）、
  `repo.ts`（SessionRow / toSession / createSession 签名与 INSERT）、`protocol.ts`（`SessionInfo.presetId`、
  `session.create` 的 `presetId`）、`ipc/index.ts`（草稿字段与透传）。
  为什么不是「留着以后做」——那七列里**五列今天没有对应的产品面**（`system_prompt` 无编辑入口、
  `enabled_tools_json` 无工具开关、`skills_json` 已被「技能放磁盘即装」取代），两列（`model_ref` /
  `thinking_level`）已由**会话级持久化**覆盖；而**最影响会话行为的审批模式它偏偏带不了**——那是
  `SECURITY.md` 明令不许持久化的一项。所以它不是「快到的预留位」，是**推测性的**。真想解决
  「每次新建会话要重挑模型」，正解是一条**全局默认模型设置**，不是预设这层抽象。
  迁移口径：**没有加迁移**（`SCHEMA_VERSION` 仍为 **9**）。删除只改基础 `SCHEMA`，于是**新库不再有**
  该列与该表、**旧库保留**（恒 NULL、无人读，无害）。两条路径都实测过：旧库（v6，带 `preset_id` 与
  `presets` 行）升级后数据不丢、建会话正常；全新库无该列 / 该表、建会话正常

- **扩展宿主层（加载第三方扩展）——2026-09 明确不做**（方案选型后拍板）。
  触发背景：评估过 Pi 生态（`pi-mcp-adapter` / `pi-web-access` / `pi-subagents` / `pi-lens` /
  `rpiv-ask-user-question` / `rpiv-todo`，**全部 MIT**、源码曾解包逐行复查——那份解包在本地
  私有目录里，**未随仓库分发**），结论是**抄设计、不装包、也不自建扩展宿主**。三条否决理由：
  ① **UI 挂载点对不上**——那些包依赖 `pi-coding-agent` 的 `ctx.ui`（`setStatus` / overlay，
  终端 TUI 抽象），Colt 是 React + IPC 双进程，装进来逻辑能跑、**画不出东西**，等于死入口
  （`AGENTS.md` §3.6）；Colt 用的是 `pi-agent-core`，不是 `pi-coding-agent`，本就没有那层 API。
  ② **绕过审批闸门**——扩展是**代码**，在 worker 内以完整权限运行，其副作用不是工具调用，
  天然躲开 `before_tool`；技能那条隐式信任通道之所以可接受，靠的是「只是文本、不改盘」
  （`SECURITY.md` §技能节），代码扩展连这个辩护都没有，会在 §零「这不是沙箱」上开口子。
  ③ **验收手段失效**——全部单测 + `dock` 246 条冒烟都是对**自己代码**的断言，
  对第三方扩展内容无效，而冒烟仅开发期存在，生产侧无兜底。
  **替代路径（已选定）**：能力**内建**（像 `browser` / `computer` / `memory` 一样进
  `AgentHarness.create({ tools: [...] })` 数组，每个都过审批闸门）；可编程的行为交给
  **已支持的 Agent Skills**（声明式 `SKILL.md`、社区包直接丢进 `.agents/skills`）。
  **复用 Pi 生态的正确姿势是读它的源码抄设计，不是加载它的包。**

- **能力补齐进度（方案 C 之下，2026-09 起）**。顺序与依据来自那轮 Pi 生态对比：

  | # | 能力 | 状态 | 落点 |
  |---|---|---|---|
  | ① | `ask_user` | **已实施**（2026-09-18；2026-09 加多题翻页与自由输入，见 `UI-REGIONS` v1.65） | 单测 `tests/ask-user.test.ts`（14 条）+ `tests/question-store.test.ts`（9 条）+ `tests/question-answer.test.ts`（10 条）；冒烟 `COLT_SMOKE_MODE=ask-user`（39 条，免模型）+ `ask-user-e2e`（11 条，**打模型**） |
  | ② | web 搜索 / 抓取 | 未开工 | 只读白名单免审批；provider 进设置 |
  | ③ | MCP | **已实施**（2026-09-19） | 设计 `docs/DESIGN-mcp.md`；配置的**纯解析层** `shared/mcp-config.ts`（worker 与主进程共用）；worker 侧 `lib/mcp-tools.ts`（官方 SDK **v2** 直连）+ `lib/mcp-reload.ts`（热重载写回）；配置 `<cwd>/.colt/mcp.json`。**原型边界已补齐**：传输 stdio + 远程（Streamable HTTP / SSE）、`listTools` 分页、`${VAR}` 插值、配置热重载（设置页「重新加载」，**不必重启会话**）、工具重名去重（内核见重名会 `TypeError`，必须在包装层挡）、设置页可见性（`McpSettings`）。单测 `tests/mcp-tools.test.ts`（**42 条**，真实 stdio / 真实 HTTP / 真实 SSE 往返，夹具 `helpers/mcp-fixture-server.mjs` / `mcp-paged-fixture-server.mjs` / `mcp-http-fixture-server.mjs` / `mcp-sse-fixture-server.mjs` / `mcp-crash-fixture-server.mjs` / `mcp-capabilities-fixture-server.mjs` / `mcp-cwd-fixture-server.mjs` 刻意用裸 JSON Schema 与生产方同构）；**连接生命周期**另有 3 条钉住「连失败的 server 热重载会重试」「连上后掉线 `status` 如实转 error 且可重载救回」「`transport: sse` 的成功路径」（此前 SSE 只验过失败分支——`reload` 原先**永不重试**失败态，等于设置页那个「重新加载」按钮对失败是死的）。**SDK 已迁 v2**（`@modelcontextprotocol/*@2.0.0`，官方 codemod 迁移，2026-09-19）：v2 **没有砍**旧式 SSE——`SSEClientTransport` 只是从 `client/sse.js` 子路径挪到了**包根导出**，服务端 `SSEServerTransport` 走 `@modelcontextprotocol/server-legacy/sse`（v1 冻结副本，仅夹具用），所以 `transport: "sse"` 能力**原样保留**（上条那条 SSE 用例在 v2 上仍绿）。工具名 `mcp__<server>__<tool>`，不在任何豁免名单 ⇒ **天然过 `before_tool` 审批闸门**，一行审批代码未改。**能力面也已接**（2026-09-19）：server 声明了 `resources` / `prompts` 就多出 `list_resources` / `read_resource` / `list_prompts` / `get_prompt`（**未声明就不加**，别放死入口；命名同款 ⇒ 同样天然过闸），二进制资源不展开成 base64、提示词交给**服务端**按参数渲染（设计 §3 决策 13）。**同轮修两处真缺陷**：① `ServerState.config` 改存**声明值**——原先连上的 server 存的是 `${VAR}` **解析后**的值，于是 `status().target` 把真实密钥画在设置页上、且每次「重新加载」都被判成「配置变了」白重连一次（决策 7 明说不该重连）；② v2 下 `listTools()` 不传 cursor 会**自己翻完所有页**，v1 时代那段按 `nextCursor` 的手工循环是**死代码**（`MAX_TOOL_PAGES` 从未被读到），已删，页数上限改钉 `ClientOptions.listMaxPages` 并由单测直接钉 SDK 契约。**再一补**（同日）：接 **server 自报的 `instructions`**——`composeMcpInstructions` 每请求拼进系统提示词（SDK 只给 `getInstructions()` 这个取值口、**一处都不替你调**，与技能清单同一个坑；决策 14）；并顺手把设置页那两条命令收进 `lib/mcp-reload.ts`，worker 入口**净减 2 行**（当时棘轮余量只剩 1 行，见 `AGENTS.md` §1.4）。冒烟 `COLT_SMOKE_MODE=mcp-e2e`（打模型；本地 Ollama 下不计费）**9/9 全绿**（2026-09-19，qwen3:0.6b 实测）；`mcp-real` 用**真实第三方 server**（官方 filesystem / pi-lens）跑同一条链路；热重载 + 设置页可见性的**接线**由**免费**冒烟 `COLT_SMOKE_MODE=mcp-reload`（9 条）覆盖（见 §5 3-g）。**收盘审计又修两处假信号**（2026-09-19）：① 主进程「等 MCP 回话」的预算原先是 **10s**（抄自 `branches` / 子代理那两条**快**操作），而 worker 侧光「连接」一步的上限就是 15s、会话没就绪时还要等 `ready`（上限 `READY_TIMEOUT_MS` 120s）——于是设置页会**假报**「查询 MCP 状态超时」，而 server 正在正常连接。现在预算按 `READY_TIMEOUT_MS + 2×MCP_STEP_TIMEOUT_MS` 推导，单步值进 `shared/limits.ts`（由 `limits.test.ts` 守「两侧不许各写一份」——这正是那条守卫针对的症状），并在免费冒烟里用一个**不说话的 server**（实测重载 **15035ms** 仍正常兑现）把这条判据钉住；② `declaredMcpServers` 原先把 `loadMcpConfig` 的 `diagnostics` **整包丢掉**，于是语法错的 `mcp.json` 被设置页渲染成「本项目未声明 MCP server」——把「你写错了」说成了「你没配」，恰好是反的；现在两条路都随响应带出诊断、设置页在列表**上方**单独画一块（不替换列表）。冒烟 `mcp-reload` 因此 9 条 → **12 条**。**同一轮还补了一处缺口**：server 连上后**掉线原先只是静默翻状态**（工具仍留在清单里、调用会失败，但用户只有自己点开设置页才知道）——现在 `onclose` 里同时发一条 security 类 notice（toast 之外**落 `session_events`**、可在「事件」里回查），并**只报一次**（HTTP 传输会重复触发 `onclose`）、**我们主动关的不报**；由真实自杀夹具 `mcp-crash-fixture-server.mjs` 钉住（断言通知恰好一条、点名 server、且重载救回后不再冒第二条；把 `notify` 摘掉这条立刻红）。**再往下还修了两处**（同日）：⑧ **stdio 子进程的工作目录**原先是**应用进程**的 cwd（worker 由 `utilityProcess.fork` 起、没带 `cwd`），于是 `args: ["."]` / `["src"]` 这类**最主流的相对写法**会静默指错、或直接 `Cannot find module`——现在传**会话的项目根**；物证是「把冒烟夹具的 `args` 改成**故意相对项目根**的路径」：修前 ① 组红、worker 打出 `Cannot find module 'E:\code\tests\helpers\…'`（从仓库根退两级），修后 12/12，另有一条单测逐字断言 `cwd === 项目目录`（摘掉 `cwd` 立刻红，实得 `E:\code\opensource\colt`）。⑦ **「答不回来的 MCP 查询」**原先只清空队列、指望「各自的超时会收敛」——预算抬到 150s 之后那就是设置页挂一条**假的**「重载中…」两分半；现在 `PendingMcpQuery` 带 `settle` / `fail` 两条口子，三处触发点（崩溃 / 回收 / init 失败）都调 `#drainPendingMcp` 当场失败。**⑦ 没有行为断言**（要造「有活 worker 且在飞查询时它死掉」，而现有注入器 t=0 就退出、落不进那个窗口），已如实记在设计决策 18。⑤ **并发重载**原先没有互斥——worker 命令入口 `void handle` **不排队**，两条 `mcpReload` 交错时同一台 server 会被连**两遍**（多出的 client 连带子进程只留在 `liveClients` 里，从工具清单 / 状态上都看不出来）；现在 `reload` 有在飞的就返回它（`reloadInFlight` + `doReload`）——重载幂等，复用同一次的结果对两个调用方都成立；判据是「并发两次只**起一个**进程」（夹具挂 `COLT_MCP_START_LOG`，见设计决策 19）。**产品评审后的五件事**（2026-09-19，决策 20–24）：⑤ **用户级配置** `~/.colt/mcp.json` 与项目级**合并**（同名项目级覆盖；诊断分别点名来源文件，`COLT_MCP_HOME` 作测试缝）；① **让 agent 自己安装 MCP**——配置格式与「密钥只写 `${VAR}` / 写完让用户点『重新加载』」两条纪律写进**基础系统提示词**（不新增会话级块，避开 `worker/entry.ts` 棘轮），写项目外的 `~/.colt/` 照常弹危险审批；② **展示名** `shared/mcp-label.ts` 把 `mcp__srv__tool` 翻成「MCP srv: tool」，接进审批摘要（`policy.buildSummary`）、审批卡 tooltip、工具卡、分析行（原先前端一律画原始注册名，`label` 定义了没人用）；③ **notice 按 `kind` 分流**——security 类走 warning 色、12s 才消，与普通成功提示（绿、5s）分开；⑥ **调用超时按 server / 工具可配**——配置 `timeout` / `toolTimeouts`（默认仍 60s），`timeout` 计入 `configKey` 故「重新加载」会重连生效。**仅剩**：worker 被强杀时**正在启动**的 MCP 子进程成孤儿（正常 dispose 走 `runtime.close()`） |
  | ④ | todo | **已实施**（2026-09-19） | 单测 `tests/todo-store.test.ts`（63 条）+ `tests/migration.test.ts` 的 v10；冒烟 `COLT_SMOKE_MODE=todo`（26 条，免模型）；设计 `docs/DESIGN-todo.md`；界面归属见 `UI-REGIONS.md` v1.48（⑦ 默认视图**任务摘要**，清单是它的第一段） |
  | ⑤ | 子代理 | **已实施**（2026-09-19） | 设计 `docs/DESIGN-subagents.md`（决策 D1–D10）；worker 侧 `lib/subagent.ts` + `lib/agent-defs.ts` + `lib/subagent-view.ts` + `lib/lane-ownership.ts`（新逻辑压进新文件，大户只留接线）；单测 `tests/lane-ownership.test.ts` + `tests/agent-defs.test.ts` + `tests/subagent-view.test.ts`；冒烟 `COLT_SMOKE_MODE=subagent`（免模型）。**执行侧三事实**（`subagent` 免闸门 / 内部写弹卡带归属、`fresh` 隔离真实效果、清单真进提示词）由 `subagent-e2e`（打模型）覆盖，**15/15 全绿**（2026-09-19，qwen3:0.6b 实测，见 §5 3-f）。**仍未覆盖**：子代理中止 / 超时墙钟的 e2e（abort 链路只走了单测与呈现层）；分支树排除的**会话级数据**由 `tests/lane-ownership.test.ts` 的纯函数覆盖（v1.66 起「列出全部分支」在应用里已无调用点，见 `UI-REGIONS` §四 第 3 条）。**导航守卫**（`session.navigate` 拒绝子 lane 节点、先挪指针后重拍快照、异常不吞）v1.66 起由 `tests/navigate.test.ts` 覆盖——原先它是 `worker/entry.ts` 里没法单测的一小段，现抽成 `worker/lib/navigate.ts` 的 `applyNavigate`；仍未走**真实** `session.branches` / 真实内核 `navigateTree` |
  | ⑥ | 写后诊断 | 建议后置 | `after_tool` 钩子；要先定「自动跑检查要不要过审批」 |

  ①的入口级遗留（别当成验过了）：worker 侧跳过闸门那条守卫与「全权模式下提问仍要弹」已由
  `ask-user-e2e`（打模型）覆盖；仍未覆盖的是 worker **意外崩溃**那一支的收尾、以及提问的
  桌面通知（`notifyQuestion`）。

  ④的入口级遗留（别当成验过了）：**镜像 → `transform_context` 的每请求注入**要走一次真实请求才到得了，
  `todo` 免模型冒烟不调模型 ⇒ 那个「模型在提示词里真的看得见清单」只有 `COLT_SMOKE_MODE=todo-e2e`
  （**打模型、计费**，尚未建）能覆盖；纯函数那半（截断 / 空清单不产出 / 已完成折一行）已由
  `tests/todo-store.test.ts` 逐条钉住。另外 **worker 意外崩溃**那一支的收尾同样未覆盖（同 ① 的缺口）。

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

### 3.4 上一阶段完成记录（可跳过）

> 批次 A / B / C **全部收口**（2026-09）。这里只留**结论、关键决定与订正**；
> 逐条的落地细节在 `UI-REGIONS` §六 对应版本里，末尾断言数都是当时的快照（验收以运行输出为准）。

**批次 A — 把右栏做成真正的工作区**

| 项 | 结果 | 关键决定 / 订正 | 版本 |
|---|---|---|---|
| A1 拖拽调宽 + 宽度记忆 | ✅ | 宽度 = 拖拽值 ?? 默认值，切页签不覆盖；钳制右栏 ≥220 / 中栏 ≥360；位移按 `startWidth − (clientX − startX)`（只对位移取负，AGENTS §3.3）。**记忆只在会话内**（切会话 / 重启即重置）。**后续修订**：宽度改**全局统一 544**，不再按视图取建议值 | v1.9 / v1.24 |
| A2 折叠态（44px 图标条） | ✅ | 折叠保留页签与活动指示、**不提供完全关闭**；折叠时**同步收起原生视图**（`bounds = null`）；⑦-F 折叠态下**同时自动展开**。冒烟当场抓出一个死控件：折叠态点图标只切不展开 | v1.10 |
| A3-1 页签实例模型 | ✅ | `DockKind` + `DockInstance`；⑦-F 改 `ensureDockInstance`（幂等）。**本批不渲染关闭按钮**——出口是 A3-3 的「+」，先给会造出「关了回不来」 | v1.12 |
| A3-2 文件预览 | ✅ | 新增 IPC `file.read`：根由主进程按 `sessionId → 项目 → root_path` 推出（`sessions` 表不存 cwd，故补 `repo.getProject`）；三层校验 + 上限 + 二进制嗅探。**契约订正**：入参改**相对/绝对皆收**（工具入参常是绝对路径），安全性靠「包含性判断先于任何 fs 访问」，不靠限制写法 | v1.13 / v1.14 |
| A3-3 页签关闭 + 「+」新增 | ✅ | 「+」菜单**由 `closable` 推导**，使「可关闭 ⟺ 有重开出口」结构恒等。菜单**只列真有的视图**（画了不存在的视图 = 死菜单项，同 ⑦-F 教训） | v1.15 |
| A3-4 内容树（范围 A） | ✅ | 设计稿画的是整项目树，与「不做整项目树」冲突 → 取**范围 A**：只列 `fileChanges`。**必须排除越界路径**（进树就是死条目） | v1.16 |
| A3-5 面板迁入页签 | ✅ | 改动 / 用量 / 工具 / 规则四个中栏面板迁入 ⑦ 成可关闭页签，消除「同一件事两处实现」；面板自身不再有「收起」（关闭交给页签 ×） | v1.17 |

**A3 的范围决定（2026-09，经产品 / 架构审视）**：❌ 不做整项目树；⏸ 浏览器多开后置（架构上按可多实例预留）；
⏸ `sessionId → instanceId` 协议迁移独立成批；⏸ 资源上限与多开绑定不拆。

### 批次 B — 浏览器视图的操作面（当前是纯展示）

**B1 前进 / 后退 / 刷新** — ✅ **已完成（2026-09）**

- **前置决策**：用户操作浏览器**不走审批**——审批裁决的是模型给的入参，这条链路每跳都由用户点击发起、没有模型参与（内嵌页是真实 `WebContentsView`，用户本来就能直接点它）。📌 **订正**：原先写的「用户自己无法操作」是错的。真问题是「页面被换掉后 agent 手里那份判断过期」→ 定案**「不走审批，但告知 agent」**。
- 契约：`BrowserViewState` 增 `canGoBack / canGoForward`，由主进程从 `navigationHistory` **现读**（渲染层不自己记历史，必与真实 webContents 走偏）；新增 `BrowserNavAction` + `browser.navigate`。
- 主进程：`BrowserHost.navigate` 走 `navigationHistory`（`goBack` / `goForward` / `reload`），**与 agent 的 `handle()` 分开**（不收任意 URL、不落盘，无越界）。目的页地址用 `getEntryAtIndex` **现取**（`goBack()` 异步，事后读 `getURL()` 只会拿到旧页）。
- 告知 agent：`WorkerCommand.browserNotice` → worker 暂存，在**下一次模型请求前**经内核 `transform_context` 注入（**不写进 transcript**，否则对话与分支树凭空多一轮假历史）；**只在 agent 正在跑时**转发（空闲时留一条会变噪声）。
- ⚠️ **这段没被冒烟覆盖**：`browserNotice → transform_context` 要真有 run 才走到（冒烟不调模型、会话也没 worker），目前只有 `formatNavigationNotice` 有单测。改它别以为冒绿就没事。

**B1 后续修复：原生视图错位 + 视口覆盖不可见** — ✅ **已完成（2026-09）**
（用户报「浏览内容溢出、显示不全：①侵占下方控制台 ②右边显示不全」，查下来是**两个独立缺陷**）

- **缺陷一：原生视图矩形是「电平」状态，同步却靠边沿事件。** 视图必须**一直**等于页面区域，而 `ResizeObserver` / `window resize` 都是边沿触发——**漏一次边沿就永久错位**（实测：页面区域 591 高、视图停在 723，压住观测抽屉）。长期没被发现是因为冒烟只验过「收起/展开高度**会变**」、**从没验过「与区域相等」**。修：可见时每 400ms 重申矩形 + 补「逐像素对齐、反复收起/展开 5 轮」断言。
- **缺陷二：`browser_act viewport` 的覆盖是隐形的。** `size = entry.viewport ?? 实际布局`：覆盖优先且**只在显式「恢复」时撤销**。实测停靠区 823×643 + 覆盖 1280×800 → 视图右边被窗口裁掉 209px、下方压住抽屉 157px，界面却毫无提示。（顺带订正：`#applyBounds` 原注释说「渲染层重报即让位」与实现相反。）修：`BrowserViewState` 增 `viewport`，头部显示「视口 1280×800 · 恢复」标记（地址栏加 `min-w-0 flex-1` 保证窄栏不被挤出）。
- **「bing 页面还是超出了」复核 → 视图侧没问题，「超出」有两条来源**：
  - **页面自己的最小宽度**（窄右栏）：bing `div.hp_body` 最小内容宽 **768**，停靠区 <783 就真溢出（779 溢 4px → 699 溢 84px），且 `<html>` 是 `overflow-x: hidden`（**无横向滚动条，裁掉的部分够不到**）。⚠️ **判据订正**：「bing 首页不会横向溢出」是错的——`documentElement.scrollWidth` 被 `overflow-x: hidden` 钳到 `clientWidth`，是**必然为真的假阴性**，须改用 `body.scrollWidth` 或「全元素最右边界」。另：右栏上限 = 窗口内容宽 − 601，**窗口 <~1384 时右栏到不了 783**。
  - **视口覆盖**（宽右栏）：右栏 1045 > 783 时页面本该装得下，唯一解释是有一个 1280 量级覆盖在生效（用户跑的是加标记之前的构建，所以既被裁、又看不到出口）。
- **「恢复」标记必须真的点得到**：标记从 `10.5px 浅底` 改为 `11.5px + 边框 + 实心按钮`。⚠️ 当场做出的新缺陷：标记变宽后仍是 `shrink-0`，窄栏下被地址栏顶出窗口右边，`elementFromPoint` 命中测试立刻变红（「看得见、点不到」的**假出口**）→ 改为标记可缩 + 文案 `truncate`、只有按钮 `shrink-0`。
- ⚠️ 读页面指标必须用**浏览器视图的 webContents**（用应用 UI 的 `run()` 只会读到窗口宽度——一度把「页面 1424」当页面读数）；对齐断言要在**不同栏宽**各验一次（只在 823 宽验过不够，最窄 219 也要对齐）。
- 教训（已进 `AGENTS.md` §5）：**电平状态别只用边沿事件同步**；`getBoundingClientRect` 与 `setBounds` 必须**逐像素相等**，只验「会变」等于没验；判溢出别用会被 `overflow` 钳住的量。

**B2 观测抽屉：console / network / downloads** — ✅ **已完成（2026-09）**

- 依据 ⑦-B「外部世界」；原状是数据已在 `browser-observe.ts` 的 `CaptureBuffer` 里，但**渲染层没有任何观测 UI**（⑦-A「现场 vs 叙述」缺的「现场」那一半）。
- 契约：`ConsoleEntry / NetworkEntry / DownloadEntry` 上移 `@shared/protocol`，新增只读通道 `browser.observe`；`CaptureBuffer` 加快照访问器（**返回副本**）；`BrowserHost.observe()` 对未建视图的会话返回空快照 + `loaded:false` 而非抛错（区分「还没开始」与「没输出」）。
- 渲染层：`ObserveDrawer.tsx` 挂在**浏览器页签内**、页面区域之下；三页签徽标读**问题条数**，**点已激活页签 = 收起/展开**。抽屉占的是**页面区域高度**，收起/展开经 ResizeObserver → `browser.bounds` 让原生视图变高。
- **轮询（1s，仅浏览器页签挂载时；窗口不可见时暂停，v1.51）而非主进程逐条推**：console / network 事件密集，逐条推就是 IPC 洪泛。
- ⚠️ 顺带修了一处**用例自身缺陷**：`dock` 原先按 `aria-pressed` 数页签，被抽屉的三个页签干扰 → 改按 `data-dock-tab` 认（产品没错，见 AGENTS §1.2）。

### 批次 C — 状态语义补完

**C1 任务异常结束态 + C2 空闲态呈现**（合并交付）— ✅ **已完成（2026-09）**

- 四态（抽成纯函数 `lib/format.ts` 的 `runStateOf`）：运行中（绿点脉动）/ **已中断**（灰点）/ **已失败**（红点 + 一行截断的 `error.message`，悬停看全文）/ **空闲**（灰点）。**正常跑完（`completed`）回「空闲」**，只有中断与失败单独留一行。
- ⚠️ **订正一处前置判断**：用 `faulted` 表达「异常结束」**不成立**——查内核后确认 `snapshot.faulted` 只在 harness `fault` 事件置位（`reducer.js`）且**从不复位**，是会话级硬故障标记。真正可用的是 `LaneSnapshot.lastResult`（`status: completed | declined | aborted | failed`，失败带 `error`；用户中断走 `session.abort → aborted`），故新增投影 `ConversationView.lastRun`（**只取 `kind === "run"`**，压缩 / 导航的终态答非所问）。
- 已知限制：`lastResult` 是 lane 生命期的记录，worker 被空闲回收后重建（切会话 / 重启）会丢 → 回落「空闲」。
- ⑥ 此前**没有任何冒烟覆盖**，本批补了第一批断言。

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

1. `npm run typecheck` + `npm test`（**条数以运行输出为准**）+ `npm run build`
2. **夹具端到端（改浏览器能力必跑）**：
   ```powershell
   # 终端 1
   npm run fixture
   # 终端 2（先停掉占用 5173 的开发实例）
   $env:COLT_SMOKE=".smoke-fixture.png"   # 只给文件名，产物固定落在 out/ 下
   $env:COLT_SMOKE_MODE="fixture"
   npm run dev        # 必须 dev：启动器被 import.meta.env.DEV 守卫，preview/打包态一律不含它
   ```
   看 `out/.smoke-fixture.png.log` 末行是否 `通过 25/25`
3. **工作区界面端到端（改右栏 ⑦ / ⑥ 必跑）**：`dock` 模式在主进程里驱动渲染层、**真派发鼠标事件**模拟拖拽，
   同时读主进程 `WebContentsView.getVisible()`——覆盖折叠/展开、拖拽上下限与方向、宽度记忆、双击复位、
   ⑦-F 自动展开、「折叠时原生视图必须收起」这条截图看不见的硬约束、**A3-2 的「点文件路径 → 预览」**
   （⑦-G 第四步后只剩消息流工具卡这一个入口，落点是「任务摘要」的**下钻内容层**；
   含越界路径被拒、工具卡传绝对路径两种边界），
   以及 **A3-3 的页签关闭与「+」新增视图**（关激活页签后激活位交还默认视图、关「浏览器」后原生视图
   收起 / 重开重新可见——⑦-G 后「浏览器」是唯一默认可关的页签），
   还有 **v1.32（⑦-G 第四步）的下钻清单层**（按目录一层分组、越界条目被排除**并如实计数**、清单头部口径、
   清单 → diff → 内容逐层下钻与三条回退出口：面包屑 / 层底「返回」/ ESC），
   以及 **A3-5 的面板迁入页签**（② 的入口点后面板确实渲染在 ⑦ 内、
   多开面板 `aside` 数不变——中栏浮层确已消失），还有 **B2 的观测抽屉**
   （先在夹具页上点出控制台报错 / 请求失败 / 下载，再断言抽屉三类都显示；其中
   「收起抽屉后原生视图 bounds 变高」同样是截图看不见的那一类），以及 **B1 的前进 / 后退 / 刷新**
   （先在夹具站真实加载第二页造出历史，再点界面按钮走「渲染层 → IPC → `navigationHistory`」，
   判据取主进程读到的**真实 URL**；按钮的可用性必须跟着历史走——退到最早一页时后退要变灰），
   还有 **C1 / C2 的 ⑥ 运行状态段**（经真实 `session.view` 通道推 `aborted` / `failed` / `completed` / `running`
   四种终态，读真实 DOM 断言「已中断」「已失败 + 错误摘要 + 红点」「跑完回到空闲」「运行中优先」——
   ⑥ 此前没有任何冒烟覆盖），以及 **⑦-G 的「任务摘要」与下钻**（推受控视图后断言：段一**不再列已完成文件**、
   底部总账的「N 处 · M 文件」双口径、无动作时的空闲空态、点总账落到**清单层**且**页签数不变**、
   工具卡路径落到**内容层**、切页签不丢下钻；
   越界拒绝改由**工具卡路径**驱动——越界条目在界面上已没有可点入口），
   还有 **v1.36 的净值场景**（多次改动后卡片给的是**净值**、改完又退回原样写「已还原」、
   **算不出（没有基线）时不显示数字**并在清单底部如实计数、展开里的「累计」档落到 diff 层且画「基线 → 当前」），
   以及 **⑦-H 的会话头收敛与「统计」视图**（② 只剩「统计」「规则」两个入口：「改动」「工具」的入口已**点不到**；
   **「工具」「改动」「文件」三个 kind 都已整体取消**，「+」菜单现为 4 项（`browser / usage / rules / events`，v1.50 起；三个被取消的 kind 打不开）；
   点「统计」后渲染的是新面板并给出**空态**——聚合内容在 `dock` 里喂不了数据，
   那部分由 `tests/lib.test.ts` 的单测覆盖），
   以及**观测条目详情**（v1.33；三个页签各点开一条，断言完整字段画出来、**没被截断**（量
   `scrollWidth <= clientWidth + 1`）、**自动滚进了可视区**、一次只展开一条、换页签即收起；
   最后**真的点一次「复制」，从主进程 `clipboard.readText()` 读回来核对**——
   ⚠️ 这一步前必须先 `window.focus()`：写剪贴板要求文档聚焦，否则 promise 静默 reject），
   以及 **`/compact` 斜杠命令**（v1.34：输入区有可点入口；真实派发 `Enter` 后
   **在 `sessionManager` 上打桩计数**判定「真的走了压缩、没被当成普通提问」；
   且**带正文的 `/compact …` 与以 `/` 开头的路径必须回落成普通提问**——
   误吞用户输入比不识别更糟，见 `UI-REGIONS` v1.34），
   以及 **`/skill` 斜杠命令**（v1.42 起，**v1.43 改为渲染层本地拦截**：判据同样落在 `sessionManager`
   的**打桩计数**上，**只记账、不转发**——报错文案本身由 `tests/skill-error.test.ts` 覆盖，
   不为此真拉一个 worker 进程。`/skill <未知名>` 必须**既不走技能 IPC、也不变成普通提问**
   （渲染层拿着本会话技能清单**就地拦下**），且**拦下时输入原样留着**——含名字之后那半句
   **额外指示**（改一个字母就能重敲，不必整句重打）、错误可见并**点出正确写法**；
   **裸 `/skill`（没给名字）回落成普通提问**（防误吞，与 `/compact …` 那条对称）。
   ⚠️ 这一段的**前置**是夹具的受控视图必须带 `skills`：`smokeView()` 经 `session.view` **整份替换**
   渲染层那份视图，少这个字段本地拦截会整条失效，而红字看起来像产品坏了——见 `AGENTS.md` ⑪），
   以及 **`/` 候选浮层**（v1.44：技能**唯一**的可发现入口。推一份**带技能**的受控视图后敲 `/`，
   断言候选正好是 `/compact` + 每个技能一项；再逐环走完**弹出 → 选中 → 写入 → 回车真走技能 IPC**
   ——少一环它就是个死入口。四条边界都钉住了：**浮层开着时 Enter 是「选中」而不是发送**
   （不拦这一下，用户选技能的那次回车会把半截命令当正文发出去）、选中后输入框带尾随空格且
   **光标停在末尾**、整条命令敲全后**浮层让开**（否则敲对了 `/compact` 反而发不出去）、
   `/usr/...` 这类路径**不弹浮层**。另外做了一次**命中测试**：浮层是绝对定位、祖先里还有
   `overflow-hidden`，「在 DOM 里」不等于「用户点得到」。
   ⚠️ 这条给 `textarea` 套了一层定位容器，顺手把两处「拿 `textarea.parentElement` 当输入卡片」的
   探针改成按 `[data-conv-card]` 认——那种**靠层级猜结构**的写法会静默指向错的元素，断言变松
   却看不出来；其中一处就在 `model` 模式里，而那一模式**不在**本段覆盖范围内），
   以及 **v1.39 的三条体验反馈**（① 有待审时侧栏标出「等待你的授权」、清空后自行摘掉——
   走真实 `approval.pending` 事件通道推，不去改 DOM；② 拖入非图片时提示**落在输入卡片内**
   并点名被跳过的文件，同时图片仍照常进附件；③ 窄栏遇上固定宽度页面
   （夹具 `/narrow.html`：700px 内容 + `overflow-x: hidden`）时横条如实给出
   「需要 700px / 可视区 219px」、原生视图跟着收，右栏拉宽到装得下后**自行消失**
   ——这一条防的是「栏一窄就挂一条常驻灰条」，那种提示永远为真，比没有提示更糟），
   以及 **v1.40 的「适应宽度」**（点横条上的「适应宽度」把整页等比缩小：判据取**页面自己的
   `innerWidth`**——最窄栏 219 下应得 365（=219÷0.6，顶到可读下限）、拉到 500 宽栏后比例自动重算、
   页面应得 700 = 需要宽；顶到下限时横条改写「已缩到 60%」且**撤掉按钮**（不留死控件）、
   「还原」出口**常驻工具条**（横条缩到装下就消失了，挂它上面等于回不去）；
   缩放期间每一步都复核**原生视图仍与页面区域逐像素对齐**——缩放只改页面 CSS 视口、不动视图矩形）。
   ```powershell
   $env:COLT_SMOKE=".smoke-dock.png"   # 只给文件名，产物固定落在 out/ 下
   $env:COLT_SMOKE_MODE="dock"
   npm run dev        # 夹具站在进程内以 port 0 拉起，无需另开终端
   ```
   看 `out/.smoke-dock.png.log` 末行是否 `通过 235/235`（2026-09-19 从 211 涨到 216：
   F3 的「事件」页签 + 子代理批的断言；「+」菜单断言已按 4 项改。2026-09-22 复跑为 **235**
   ——中间几批断言增补（含「移除工作区」的连锁断言）没跟着改这里）。
   ⚠️ **环境前提（v1.51 起）**：冒烟把主窗口**钉为「始终可见」并关掉后台节流**
   （`src/dev/smoke/index.ts` 的 `pinVisibility`）——F11 之后「窗口不可见就停表」是产品行为，
   而断言依赖的 400ms 电平重申 / 1s 观测轮询在遮挡（Windows occlusion → `document.hidden`）
   期间会停摆，红的是环境不是产品（2026-09-19 实测交互桌面上 3 红，全因遮挡）。
   「不可见时暂停」行为本身由 `tests/visible-interval.test.ts` 单测覆盖，冒烟不再重复验。
   ⚠️ **计费**：`dock`、`fixture`、`memory`、`perf`、`ask-user`、`mcp-reload` 与 `subagent` 是**不调用模型**的模式（其余模式、含不给
   `COLT_SMOKE_MODE` 时的 `basic`，都会真实打模型并计费）。`dock` 曾经也会：它的 `/compact`
   段把打桩转给了真实现，会真发 `/compact 帮我看看` 与 `/usr/local/bin/node` 两句 prompt、
   计一次费，并把它们写进用户真实项目里的真实会话历史——v1.41 起该段改为**只记账、不转发**。
  若 `npm run dev` 直接报 `Error: spawn UNKNOWN`，**先看 `AGENTS.md` 最后一节**——
   那是本机「智能应用控制」拦了未签名的 `electron.exe`，与业务代码无关（`electron` 已精确 pin）。
  若它报的是 `does not provide an export named 'BrowserWindow'`，看 `AGENTS.md` 同一节的
  `ELECTRON_RUN_AS_NODE` 那条（那个环境变量会把 Electron 按成 Node，**要 unset，设成空串没用**）。

   **3-b. 提问（ask_user）端到端：改会话流里的阻塞态卡片、或改 `main/question-store.ts` /
   `renderer/.../QuestionCard.tsx` / `renderer/src/lib/question-answer.ts` / `useBlockingCards.ts`、
   或改 `session-manager.ts` 里「worker 没了要收尾」那几处时必跑**（2026-09 加，**39 条**——
   v1.65 起含「多题翻页」「每题自由输入」「空问卷不白屏」与「输入框回车」四项）：

   ```powershell
   $env:COLT_SMOKE="ask-user.png"
   $env:COLT_SMOKE_MODE="ask-user"
   npm run dev
   ```

   看 `out/ask-user.png.log` 末行是否 `通过 39/39`。它验的是**静默失败高发区**：卡片是否真的出现、
   选项是否真的能点（不是死按钮）、提交后主进程收到的载荷键值对不对（多选以「、」相连）、
   跳过是否走 `skipped` 而不是 `cancelled`、超时是否自己收尾、`full-access` 下是否照样弹、
   以及全程不留悬空卡（**含 worker 被回收那一段**——审批与提问的收尾必须成对，漏一处就是
   卡片留到 5 分钟超时 + 任务栏一直闪）。v1.65 起另钉两组：**翻页**（首屏只渲染第 1 题、
   第 2 题的选项不在 DOM、页码与「到头禁用」、翻回去先前的选择还在、答完判定跨页累计、单题不出
   翻页控件）与**自由输入**（自填进输入框、**不清空**已选、合并成「选中的、选中的、自填」回传；
   单题不选任何选项、只输入也能提交）、以及**空问卷**（worker 校验强制 1~4 题、这条路走不到，
   但卡片必须早退成 `null` 而不是白屏；判据取「卡片 0 张 **且** 主界面仍在」——只看卡片数会把
   「整棵树崩掉」也算通过）。**回车**单独钉三条（非末页翻页 / 单题末页提交 / **合成中的回车不翻页**）
   ——最后一条只在中文环境下才会暴露：输入法里回车是「确认候选词」，靠 `KeyboardEventInit.isComposing`
   显式构造来验（英文环境测不出来）。自填那条必须**真派发 `input` 事件**——React 受控 input
   直接改 `value` 收不到，会「看着有字、state 是空的」（`typeAnswer` 的注释）。不跑模型、不计费。

   **3-c. 提问（ask_user）真实模型端到端：改 `worker/lib/ask-user-tool.ts` 的注册/校验、
   或 `worker/entry.ts` 里 `before_tool` 跳过 `ask_user` 的那条守卫、或审批与提问的边界时必跑**
   （2026-09 加，11 条，**打模型、计费**）：

   ```powershell
   $env:COLT_SMOKE=".smoke-ask-user-e2e.png"
   $env:COLT_SMOKE_MODE="ask-user-e2e"
   npm run dev
   ```

   看 `out/.smoke-ask-user-e2e.png.log` 末行是否 `通过 11/11`。免费的 `ask-user` 从
   `sessionManager.questions.enqueue()` **直接入队**，验的是入队之后的一切；**入队之前**那段
   （模型是否看得见并调用 `ask_user`、是否被 `before_tool` 当待审工具弹卡）只有真模型能走到。
   它在 `full-access` 下让模型自己发起提问，断言：模型真的调用了 `ask_user` 且问卷内容对得上、
   提问**没有**流进审批通道（`approvals.listPending` 为空）、作答后出队、答案作为工具结果回到
   模型（含「用户已回答」与所选 label）、模型接着往下做并复述所选项。夹具在
   `out/smoke-ask-user-e2e-fixture/`，worker 的生死交给渲染层（同 `memory-e2e`，`window.reload()`
   等它自动打开、worker 就绪）——**别**自己抢 `session.open`（`AGENTS.md` §五末条）。
   **它测不到** worker **意外崩溃**那一支的收尾与提问的桌面通知（`notifyQuestion`）。

   **3-d. 子代理呈现（subagent）：改 ④ 的工具卡 / `MessageList.tsx` / `SubagentPreview.tsx` /
   `FollowPanel.tsx` / `ChangeDrilldown.tsx` / `panels/SubagentStream.tsx` / `use-stableView.ts` /
   `lib/stable-view.ts`，或改 `ConversationView.subagents` 的形状时必跑**（2026-09-19 加，免模型）：

   ```powershell
   $env:COLT_SMOKE=".smoke-subagent.png"
   $env:COLT_SMOKE_MODE="subagent"
   npm run dev
   ```

   看 `out/.smoke-subagent.png.log` 末行是否 `通过 21/21`。它从主进程推**受控视图**驱动（同
   `todo` / `dock`），不跑模型、不计费：④ 卡特化 + 有界预览（如实说「最近 12 / 共 20 步」）、
   **此刻动作只在 ④**（右栏不再重复列）、**「中止」在 ④ 的卡面上**（命中测试）、**不自动展开右栏**（决策三 D5）、
   已结束后不再给「中止」而 ④ 卡保留、点 ④ 卡「在右栏查看完整过程」→ 下钻子代理流（面包屑 + ESC）、
   不存在的子代理回空而非报错。**它测不到**：`subagent` 免闸门 / 内部写弹卡的**执行侧**、
   `fresh` 隔离的**真实效果**，以及**「模型真的在系统提示词里看得见子代理清单」**——最后一条与
   `todo` 同源（§3.2 提到）：免模型冒烟只能验**目录块拼得出来**（`tests/agent-defs.test.ts`
   断言最终字符串里有 `<available_subagents>`），验不了它**真的进了模型那次请求的提示词**。
   三者都由 `subagent-e2e`（打模型）覆盖，见 §5 **3-f**；
   分支树排除与导航守卫的**判据**同源自 `lib/lane-ownership.ts` 与 `worker/lib/navigate.ts`（都有单测）；
v1.66 起左栏那棵树已删，导航决策由 `tests/navigate.test.ts` 覆盖，仍**未**走真实内核 `navigateTree`。

> **3-e. MCP 工具真实模型端到端：改 `shared/mcp-config.ts` 的配置解析、
>   `worker/lib/mcp-tools.ts` / `mcp-reload.ts` 的装载/包装/热重载、
>   或 `worker/entry.ts` 里 MCP 接线、或 MCP 与审批闸门的边界时必跑**
>   （2026-09-19 加，**打模型、计费**，2 次调用左右）：
>
>   ```powershell
>   $env:COLT_SMOKE=".smoke-mcp-e2e.png"
>   $env:COLT_SMOKE_MODE="mcp-e2e"
>   npm run dev
>   ```
>
>   看 `out/.smoke-mcp-e2e.png.log` 末行。免费的 42 条单测覆盖装载 / 包装 / 分页 / 远程（真实 HTTP / SSE）
>   / 失败重试 / 掉线上报 / 重名去重 / **stdio 子进程的 cwd** / **并发重载互斥** / 配置纯函数，但都停在「工具包装与往返」这一层
>   （**热重载与设置页可见性的接线**——renderer → main → worker 那条 IPC 链——由**免费**的 3-g 覆盖），
>   本模式验**只有真模型才走得到的三段**：① 模型在提示词里真的看得见 `mcp__` 工具
>   （看不见就不会调用，待审队列不会出现它——快速失败并报出本轮终态）；
>   ② 未知 MCP 工具走 `before_tool` 弹审批卡（approval 档，risk=moderate，
>   不静默放行），卡真画在界面上且「允许一次」**命中测试**可点（批准确走 UI 路径）；
>   ③ 批准后夹具 stdio server 真实往返，`echo:<nonce>` 作为工具结果回到模型。
>   夹具项目 `out/smoke-mcp-e2e-fixture/`（gitignored），`.colt/mcp.json` 由用例现写，
>   server 进程用 `ELECTRON_RUN_AS_NODE` 让 electron 按 Node 跑——不依赖 PATH 里有 node。
>   判据同 ask-user-e2e：一律取自主进程（待审队列 / 视图 / 事件库）。
>   **已实测**（2026-09-19，本地 Ollama qwen3:0.6b，9/9 全绿）：模型真的调用
>   `mcp__fixture__echo` → 未知工具弹审批卡（risk=moderate「未知工具，按需确认」）→
>   点「允许一次」→ `echo:<nonce>` 经真实 stdio 往返作为工具结果回到模型、模型复述 nonce。
>   （首次跑时 GLM 账户 429 余额不足未跑成；换成本地 Ollama 后复跑通过——本地模型不计费。）

> **3-f. 子代理真实模型端到端：改 `worker/lib/subagent.ts` 的编排 / 闸门归属
>   （`request.subagent`）/ `lib/agent-defs.ts` 的清单注入、或 `fresh` 隔离边界时必跑**
>   （2026-09-19 加，**打模型**，本地 Ollama 不计费）：
>
>   ```powershell
>   $env:COLT_SMOKE=".smoke-subagent-e2e.png"
>   $env:COLT_SMOKE_MODE="subagent-e2e"
>   npm run dev
>   ```
>
>   看 `out/.smoke-subagent-e2e.png.log` 末行是否 `通过 22/22`（**数字会随断言增补而漂，以运行输出为准**）。它验 §3.2 ⑤ 里三个
>   **只有模型真调用工具才走得到**的执行侧事实：① **清单可见**——模型按名调用
>   `subagent(agent=demo)`，视图出现 demo 活条目（看不见清单就不会按名调）；
>   ② **免闸门 / 内部写弹卡**——`subagent` 调用本身不进审批队列，而子 lane 里那次
>   `write` 照常进闸，且待审项带「来自 demo」归属（`request.subagent`，④ 卡 chip 数据源），
>   批准确走真实 UI（「允许一次」+ 命中测试）；③ **fresh 隔离**——prompt A 先把随机密语
>   钉进主 transcript，再断言它绝不出现在子代理 transcript（判据是「缺席」，确定性）。
>   write 的真实产物（文件落盘 + 内容）从审批请求实际入参验，不猜模型选了什么文件名。
>   夹具项目 `out/smoke-subagent-e2e-fixture/`（gitignored），`.agents/agents/demo.md`
>   由用例现写；worker 的生死交给渲染层（同 ask-user-e2e，`window.reload()` 等自动打开）。
>   **小模型服从是概率事件**（0.6b 实测过三种失败形态：不调工具、子代理假装写了、
>   绕过委派自己直接 write），故「发 prompt B → 等内部 write」整条可重试至多 3 次：
>   主 lane 绕过委派的直接 write 会被**拒掉并在理由里指路**，断言一条不放水。
>   **已实测**（2026-09-19，本地 Ollama qwen3:0.6b，15/15 全绿）：密语进主对话 →
>   模型按名调 demo → 内部 write 带归属进闸（risk 有值）→ 点「允许一次」→ 文件真实落盘 →
>   子代理 completed、结论回主模型 → 密语缺席子代理 transcript → 全程无未捕获异常。

> **3-g. MCP 配置热重载 + 设置页可见性端到端：改 `shared/mcp-config.ts`、
>   `worker/lib/mcp-tools.ts` / `mcp-reload.ts` / `lane-heal.ts`、`worker/entry.ts` 的
>   `mcpStatus` / `mcpReload`、`main/session-manager.ts` / `main/ipc` 的
>   `mcp.status` / `mcp.reload`、或 `Settings.tsx` 的 `McpSettings` 时必跑**
>   （2026-09-19 加，**不调模型、不计费**）：
>
>   ```powershell
>   $env:COLT_SMOKE=".smoke-mcp-reload.png"
>   $env:COLT_SMOKE_MODE="mcp-reload"
>   npm run dev
>   ```
>
>   看 `out/.smoke-mcp-reload.png.log` 末行是否 `通过 13/13`。免费的 42 条单测覆盖 runtime 的
>   装载 / 分页 / 远程（HTTP + SSE）/ **失败重试** / **掉线上报** / reload 与配置纯函数
>   （含「`${VAR}` 服务器不泄露解析后密钥、配置没变不重连」「单次 `listTools()` 就收全所有页」
>   与「**并发两次重载只起一个进程**」三条），以及 **resources / prompts 能力面**（`mcp-capabilities-fixture-server.mjs` 的真实
>   stdio 往返：列资源/读文本资源/二进制不展开/列提示词/按参数取提示词、未声明就不加工具）、
>   **server 自报的 `instructions` 拼进提示词的最终产物**，
>   但都停在 worker **之内**；本模式补的是
>   **renderer → main → worker → 绕回** 这一段**「名字对不上就静默失效」的接线**——
>   `mcp.status` / `mcp.reload` 两个 IPC → `SessionManager` 的 FIFO 兑现 → worker 的
>   `mcpReload` 命令 → 工具清单写回 harness 与主 lane。五组断言：
>   ① **冷启动装载**：`alpha`（3 工具的 stdio 夹具）已连接、工具名逐字正确。
>   ⚠️ 它的 `args` 是**故意相对夹具项目根**的（`relative(fixtureDir, …)`，不是绝对路径）——
>   顺带把「stdio server 的工作目录 = 项目根」钉住：工作目录若退回成应用自己的 cwd（仓库根），
>   这条相对路径会指到仓库外面、alpha 连不上，① 组当场红（见 ③ 行的 ⑧）；
>   ② **热加 server**：`beta`（分页夹具）的 5 个工具一个不少，且**会话没重启**（同一个 worker）；
>   ③ **热删 server**：`alpha` 连工具一起消失——验 `lane-heal.ts` 那支「删掉 server 的老会话
>   不会 brick」（`generation.js` 见清单里有内核不认识的工具名会 `configured_tools_unavailable`
>   硬失败，所以清单必须与 harness **同时**对齐）；
>   ④ **两个 IPC 的形状**（设置页看到的就是它们），含**没有活 worker** 的项目回
>   `live:false` + `status:idle` 的退路（「没打开会话」≠「没连上」），以及**随响应带出的配置诊断**
>   ——那个没会话的项目里故意放了一条坏声明（`broken` 既没 command 也没 url），断言诊断里
>   指名道姓提到了它（否则设置页会把「你写错了」显示成「你没配」，见 ③ 行的审计记录）；
>   ⑤ **「慢 server 不该被判成超时」**：配置里放一个**起来后一句话不说**的子进程，把「连接」
>   这一步耗到 worker 侧的上限（15s），断言这次 `mcp.reload` **真的等过了 10s 仍正常兑现**
>   （实测 15035ms，返回该 server 的 `error` 态）——这条正是「主进程的等待预算必须盖住
>   worker 侧单步上限」的判据，把预算改回 10s 它就红。
>   夹具 `out/smoke-mcp-reload-fixture/`（含分页 server 与那个不说话的 server）与
>   `out/smoke-mcp-reload-other/`（**刻意全程不开会话**，专验退路与诊断），都 gitignored；
>   server 用 `ELECTRON_RUN_AS_NODE`
>   让 electron 按 Node 跑（不依赖 PATH 里有 node，同 mcp-e2e）。worker 的生死交给渲染层
>   （同 mcp-e2e：`window.reload()` 等它自动打开夹具会话）。
>   **不含设置页 DOM 断言**：设置页跟着渲染层的 `activeProject` 走（渲染层是**并发参与者**），
>   界面层的判据落在这两个 IPC 上——组件只是把它们画出来，DOM 那一半靠人工看一眼截图。
>   **已实测**（2026-09-19，12/12 全绿）。

4. **模型选择 / 会话生命周期端到端（改 `model-ref` / provider / `session.create` 必跑）**：
   ```powershell
   $env:COLT_SMOKE="model.png"
   $env:COLT_SMOKE_MODE="model"
   npm run dev
   ```
   一次跑六段，按日志标签看各自的行：`[model]` **7** 条（会话未打开也能显示 / 切换已落库的模型）、
   `[model/fallback]` **6** 条（没有 DeepSeek 密钥时，默认解析落到已配密钥的自定义服务）、
   `[model/keyless]` **6** 条（**只配了无需密钥的本地 endpoint 也必须能用**：默认解析落到它、
   界面不出现「尚未配置 API Key」、下拉不标「（未配置密钥）」、会话真的开得起来）、
   `[model/no-usable]` **6** 条（**一个可用的模型服务都没有**时，主区黄条与对话区共存：
   对话区底边与主区底边相等、输入卡片的下半行（工具行 / 模型选择 / 发送）必须完整落在窗口内
   ——回归：黄条把 h-full 的对话区顶出主区、被 overflow-hidden 从底部裁掉。
   用例会临时把本机真实的服务与密钥挪开，跑完在 finally 里原样还原）、
   `[model/during-init]` **1** 条（worker 未就绪时下发命令不被「会话尚未初始化」拒绝）、
   `[session/draft]` **20** 条（**空项目直接给输入框**：一个会话都没有的项目，中间区自动给一条
   草稿，「一个按钮都没点输入框就已经在」；**草稿不进侧栏**：自动建的那条不落库、点侧栏「+」
   也不多出会话行；**转正**：首次发消息（`session.prompt`）才落库并拉起 worker，落库后侧栏
   **立刻**出现这条会话——判据是进程状态推送，不依赖模型回话；**起手态排布**：提示块与输入卡片
   是一个整块、卡片底边到会话区底边的留白**远大于贴底时的固定量**（几何判据，不看 class）；
   **新建工作目录**：点一下真的在磁盘上建出目录、登记成项目、界面切过去且仍是起手态）。
   用例另起一个**空夹具项目**（`out/smoke-draft-empty-fixture/`，跑前清空、跑完清空并还回
   `project.list[0]`）——「打开就见输入框」只有在项目真的空时才成立，这个前提必须**显式建立**
   （`AGENTS.md` §五⑬）。
   「新建工作目录」的落点由 harness 指到 `out/smoke-workspace`（`COLT_WORKSPACE_ROOT`，**固定路径**：
   override 原样使用、不拼时间戳，`upsertProject` 因此按 root_key 去重，跑多少遍都只留一行项目）——
   它默认落在**家目录**的 `~/.colt/<年月日-时分秒>/workspace` 下，那是用户真实的工作产物目录，
   自动跑时绝不能碰（§五⑩）。
   用例会临时改动 `deepseek` 密钥与临时 provider，跑完自行恢复。
   ⚠️ **这三段的「环境前提」都必须显式建立**（2026-09 修）：它们假定的都是「这台机器上只有用例造的
   那个服务」，而默认解析（`resolveSessionModel`）是从**整份** provider 列表里挑的。原先只有
   `[model/no-usable]` 做了这件事（把真实服务挪开、`finally` 还回去），另两段则只挪得动内置
   `deepseek`——于是本机那个自己配的 `glm`（带密钥）抢走了默认解析，`[fallback]` / `[keyless]`
   **各红 2 条**，而红字看上去像产品坏了（那两段**其余**断言全绿：界面无报错、会话开得起来、
   消息发得出去——正是「落到了另一个**可用**的服务」而不是解析坏了）。
   现统一走 `stashUsableProviders()`（`smoke.ts`）：**带密钥的服务只删密钥、不删条目**，
   免密钥的条目才整条挪走，`finally` 里先还全部密钥、再写回被挪走的条目。
   已实测：三段全绿（**34/34**），且跑完后用户的 `providers` 行与 `secrets.json` 的键都逐项核对过、
   与原值一致（`created_at` 都没变）。
5. **记忆检索端到端（改 `memory-index` / `memory-host` / worker 启动装载必跑）**：
   ```powershell
   $env:COLT_SMOKE=".smoke-memory.png"
   $env:COLT_SMOKE_MODE="memory"
   npm run dev
   ```
   看 `out/.smoke-memory.png.log` 末行是否 `通过 11/11`。不调用模型、不计费：真实 worker
   起动即上报 `memoryIndex` → 主进程落派生库（`data/memory.db`）→ `hostBridge` memory 检索；
   另验二字词 LIKE 兜底（FTS trigram 3 字下限）、项目隔离（对照条目在库里但检索不可见——
   证明隔离是路由层强制而非空库巧合）、关会话清检索上下文（关闭后检索被拒）。
   夹具在 `out/smoke-memory-fixture/`（gitignored，条目 upsert 幂等，可重复跑）。
   ⚠️ **会话必须建在夹具自己的项目下**，且跑完前把仓库项目顶回 `project.list[0]`（最近打开优先）：
   渲染层挂载会自动打开「当前项目」的最新会话并以项目 rootPath 为 cwd，卸载时还会
   `session.close`（StrictMode 下挂载→卸载→重挂载）——会话若挂在仓库项目下、或夹具项目
   恰好成了最近打开，worker 就会**就绪前被杀**或带着错误 cwd（2026-09 实测两轮翻车）。
   ⚠️ 用户级记忆不注夹具：真家目录 `~/.colt/memory.md` 不可写（写就是污染用户数据），
   其链路与项目级共用同一条消息路径，由单测覆盖。
6. **记忆行为端到端（真实调用、计费；改注入 / 沉淀 / `memory-tidy` 必跑）**：
   ```powershell
   $env:COLT_SMOKE=".smoke-memory-e2e.png"
   $env:COLT_SMOKE_MODE="memory-e2e"
   npm run dev
   ```
   看 `out/.smoke-memory-e2e.png.log` 末行是否 `通过 12/12`。免费的 `memory` 模式只验
   **跨进程链路**，本模式验**行为质量**，固定 4 次真实调用：①注入可见性（明令禁止工具，
   模型不读文件也答出记忆里的密语——工具动用单独断言，读了文件就不算注入生效）；
   ②沉淀真的写进 `.colt/memory.md` 且新条目可被检索（active）；③`/memory-tidy` 从渲染层
   输入框真实进入（子 lane 对主视图不可见，以**文件落盘**为完成信号，并行盯完成通知与
   可见报错两类瞬时 DOM）：重复合并（pnpm 2→1）、过时删除（old-server）、有效保留、
   完成通知出现在界面、被删条目就地归档（archived 仍可检索）、改写进了会话的文件改动；
   ④冷层检索：现行文件已无部署条目时，`memory_search` 仍能答出原文。
   夹具在 `out/smoke-memory-e2e-fixture/`，条目跑完按 project_key 整段清理（派生库，可重建）。
   ⚠️ 夹具技巧与 `memory` 模式**相反**：刻意**不**把仓库项目顶回 `list[0]`——`/memory-tidy`
   从输入框走的是「当前会话」，夹具会话必须是渲染层自动打开的那个（无竞争者，StrictMode
   杀一次就绪前的 worker 后会自行收敛）。
   首跑（2026-09-17）：12/12 全绿；冷层条目的回答连归档状态与日期都如实引用了。
7. **应用内实测**：除 `fixture` / `dock` / `memory` / `perf` / `ask-user` / `mcp-reload` 外，各模式（含不给
   `COLT_SMOKE_MODE` 时的 `basic`）都会真实调用模型并**产生计费**，`host` 只是其中最费的一个；
   只想看界面时直接启动应用 + **系统级截图**即可

---

## 6. 推进节奏建议

- 一次一件事（仓库既有习惯：一个提交只做一件事）。**每件跑 §5 的 1**；
  改到 ⑦ / ⑥ / 浏览器就**同时跑 §5 的 2 或 3**（§5 每步都写了「什么时候必跑」）；
  改到会话流里的**阻塞态卡片**（授权卡 / 提问卡）或 `useBlockingCards.ts`，跑 §5 的 3-b。
  改到 MCP（配置 / 装载 / 热重载 / 设置页）先跑**免费**的 §5 3-g，动到审批闸门再跑 §5 3-e（打模型）。
  ⚠️ `npm test` 里含**体量闸**：给已知大户加功能必须同时搬走等量旧代码，动手前先算
  净增行数（`AGENTS.md` §1.4）。
  ⚠️ 往 `dock` 加断言时**按批次分段、保留段头注释**（沿用现有写法）——它已有 200+ 条、
  单文件很长，**不要为了「整齐」顺手重构冒烟**；真要拆就单独一批做（`AGENTS.md` §1.1）
- **当前处于新一阶段的起点**：批次 A / B / C 全部收口（见 §3.4 索引）；原 N1–N4 计划已删除，§3.1 暂空
- 另有一批**独立工作**「右栏工作现场重组」（⑦-G / ⑦-H）**四步已全部落地、已收口**
  （`UI-REGIONS` v1.29 / v1.30 / v1.31 / v1.32）——**不要再从那里接活**
- 动手前先做一件事：**确认相关「现状」还成立**（本文件的现状是 2026-09 读代码写的，代码会往前走）；
  若不成立，**先改本文件再动手**，别按过期描述实现
- 做完一件，**同时更新**：`UI-REGIONS` §六 版本表（区域规则）、本文档 §1 现状基线（若现状变了）。
  §5 相关计数（单测 / 冒烟条数）一并改——
  **别让文档里的数字落后于代码**（这是上一阶段反复吃过的亏）
- 任务跨会话时，把「已做到哪、下一步是什么」写回本文档（**这也是本文件存在的理由**）

---

## 7. 上一阶段踩过的坑（下一阶段别重踩）

- **原生视图不参与 DOM 叠层**：`WebContentsView` 浮在渲染层之上，切走页签 / 卸载会话时**必须上报隐藏**，否则会盖住别的内容
- **销毁路径必须判活**：`webContents` 一旦 destroyed，访问任何属性都会抛；顺序是「摘出视图 → 判活 → 关」
- **`capturePage` 拍不到原生视图**：验证内嵌浏览器必须用**系统级截图**，主窗口 `capturePage` 里不会出现它
- **容器查询要设在「中栏宽度」上**，而不是窗口宽度（`max-w-[796px]` 把内边距包进容器才对得上）
- **`viewport` 语义已变**：不再改窗口尺寸，而是给视图覆盖尺寸
- **渲染层传下来的 `cwd` 不能直接当「读文件的根」**：`cwd` 由渲染层交给主进程（`Conversation` 的 prop）。
  读文件能力必须由**主进程按 `sessionId` 查 DB 取根**，渲染层给的路径**必须落在根内**
  （相对/绝对皆可——工具入参里的 path 由模型给出，可能是绝对路径；关键是**越界判断先于任何 fs 访问**，
  这样根外路径不会变成「存在性探测」的口子）。
  **已按此落地**（A3-2，`src/main/file-read.ts`）；另更正两处事实：
  ① 根**不在 `sessions` 表**（它不存 cwd），只在 `projects.root_path` 上；
  ② 原「只收相对路径」在实测中站不住——`read` 既不产生改动记录、入参又可能是绝对路径
- **待决（事 B 前置）**：agent 的 `browser_act` / `browser_read` 作用于**哪个**浏览器实例。推荐「agent 固定绑定一个会话主视图，用户额外开的页签标记为『我的浏览』」——这样 agent 工具面零改动，⑦-A 仍成立
- **电平的状态别只用边沿的事件去同步**（B1 后续修复）：原生视图的矩形必须**一直**等于页面区域，而
  `ResizeObserver` / `window resize` 都是**边沿触发**——**漏一次边沿就永久错位**（实测抓到过 132px）。
  教训两条：电平状态要**周期性重申**兜底；**只验「会变」不验「相等」等于没验**。
  **同一个不变量要在不同「栏宽」下各验一次**（823 宽下验过，问题偏偏出在窄栏）
- **判「有没有溢出」别用会被 `overflow` 钳住的量**：`documentElement.scrollWidth` 在页面自带
  `overflow-x: hidden` 时**恒等于 `clientWidth`**（必然为真的假阴性）。要用 `body.scrollWidth` 或
  「遍历全元素取 `getBoundingClientRect().right` 的最大值」。
  另：「超出 / 显示不全」有**两种来源**——① 原生视图比页面区域大（覆盖）vs ② 页面自己比视口宽，
  **分开量**，别听描述就改代码
- **「在 DOM 里」不等于「用户点得到」**：小目标入口（徽标、按钮、页签）的断言要做**命中测试**
  （`document.elementFromPoint(中心)`），否则「字号看得见、按钮点不到」的假出口永远发现不了
- **信号对了但含义不对，比没有信号更糟**（C1 那次）：`faulted` 看着像「任务失败了」，其实是**会话级硬故障且不复位**。
  用内核字段前先读它的**定义与写入点**（`reducer.js` / `lane.js`），别按字段名猜语义
- **写剪贴板要求文档处于聚焦状态**（N1 那次）：`navigator.clipboard.writeText` 在文档未聚焦时会直接
  reject（Chromium 硬规则），而冒烟跑的时候焦点在终端上——**静默失败**，表现是「点了没反应、剪贴板里还是旧内容」。
  断言剪贴板内容前必须先 `window.focus()`（真实用户点按钮时窗口必然聚焦，所以这不是产品缺陷）
- **别断言内核给出的错误字符串**（N1 那次）：Chromium 的网络错误码随 URL 而变——
  实测 `http://127.0.0.1:9/refused` 报的是 `net::ERR_UNSAFE_PORT`（9 在受限端口名单里），
  不是想当然的 `ERR_CONNECTION_REFUSED`。只认 `net::ERR_` 前缀（`fixture` 模式既有那条就是这么写的）
- **别把设计稿当能力清单**：原型的「+」菜单画了 终端 / 任务摘要 / 代码变更，产品里前两个**根本不存在**
  （「代码变更」当时是独立侧栏面板、不是页签；⑦-G 之后它成了「任务摘要」的下钻——**都不是菜单项**）。
  做入口（菜单项 / 图标 / 按钮）前先问：**这东西现在真的存在吗？
  点下去有可见反馈吗？** 不存在的能力宁可不放（`AGENTS.md` §3.6）
- **本机「智能应用控制」会拦未签名的 `electron.exe`**（2026-09 实测）：`npm run dev` 报
  `Error: spawn UNKNOWN`（errno **-4094**），而 `npm run build` / `npm test` 反而全绿
  （它们不拉起 Electron）。判据：`& .\node_modules\electron\dist\electron.exe --version` 报「**已阻止**」。
  **根因是信誉而非签名**（官方 Electron 本来就不签名），SAC 按微软信誉库放行，阈值在 7~11 天之间——
  所以**停在新版本上会「今天能跑、过几天又跑不了」**。铁律：`electron` **精确 pin**（现为 **44.2.0**，别用 `^`）、
  **升版本后必须真起一次**。报这个错先按上面两条量，**别去改业务代码**（与业务代码无关）
- **用例也可能量错对象**（v1.36 那次）：净值那条断言首跑变红，是因为用例拿**整行文字**去比 `−1`，
  产品并无问题。**红了先怀疑用例的判据**，别去改产品（`AGENTS.md` §1.2）
- 通用纪律见 `AGENTS.md`（尤其 3.3 位移计算、3.5 设计前先读代码、3.6 别做死控件）
