# Banyan · 下一阶段计划（开发交接）

> 上一阶段（2026-09）已把设计稿与代码的差异**全部收敛**。原 `DESIGN-TO-CODE.md`（差异收敛清单）随之完成使命并删除，
> 其中仍然有约束力的「已定调」条目转记于 §2。**本文档是下一阶段的待办来源。**

**新会话接手阅读顺序**

1. `AGENTS.md` — 纪律。尤其 **3.5：动手前先 `read` 代码**；截图只作视觉参考，不作功能依据
2. `docs/UI-REGIONS.md` — 区域定义、⑦ 实现约束、§四 现状/违规清单、§六 版本记录
3. `docs/UI-DESIGN-v3.md` — 设计真源；§9 能力对照表、§10 优先级表当验收 checklist
4. 本文档
5. 需要视觉细节时：`docs/prototype-work-browser-hifi.html`（概念稿，顶部有「本稿 vs 产品现状」对照表，**它不等于产品现状**）
6. 改动浏览器能力时：`docs/BROWSER-TEST-CASES.md`

---

## 1. 上一阶段落地了什么（建立方位，细节仍以代码为准）

| 区域 | 现状 |
|---|---|
| ③ 左栏 | 项目 → 会话列表 → 会话分支树（`features/BranchTree.tsx`）；运行中会话带绿点与计时 |
| ② 会话头 | cwd + git 分支 chip（游离 HEAD 转琥珀色、窗口获焦刷新）；改动 / 用量 / 工具 / 规则四个入口 |
| ④ 会话流 | 思考轨、工具卡、授权卡、变更卡；工具卡默认折叠为一行 |
| ⑤ 输入区 | 模型选择、附件（图片 / 文件）、审批模式、发送 / 停止；Enter 发送或插话 |
| ⑥ Live Bar | 位于输入区**下方**，只读：上下文条（>70% 转琥珀并给「压缩上下文」按钮、>90% 转红）、成本、心跳 / 最后活动 / 「似乎卡住了」 |
| ⑦ 右栏 | **工作区容器**：页签「正在处理 / 浏览器」；浏览器是内嵌 `WebContentsView`（独立 partition），首次加载自动切页签 |
| 宿主能力 | 浏览器（`host/browser-host` + `browser-observe`）、桌面控制（`host/computer-host`）、输入合成（`host/input-keys`），统一经 `HostBridge` 路由 |
| 审批 | 按工具风险分级；会话级记忆规则可列出 / 删除，切 full-access 时清空 |
| 已有面板 | 改动 `ChangesPanel`、用量历史 `UsagePanel`、工具 `ToolsPanel`、审批规则 `RulesPanel` |

---

## 2. 已定调，不要重新讨论

- ⑦ 是**工作区容器**，不是浏览器专用栏；以页签切换视图，「正在处理」是默认视图且**不可关闭**（可折叠）
- 浏览器载体是 `WebContentsView`，**不回退到独立窗口**；页面用**独立 partition**
- 视图**懒创建**：未激活的页签不创建 WebContents
- ⑥ 是**只读区**，不放任何操作（中断属于 ⑤）
- ⑥ 的位置在输入区**下方**
- 会话语义模式选择器（原违规 #8）**暂不处理**
- ③ 的 L1（模式切换）/ L2（功能入口）分层：功能尚未落地，规则**暂无适用对象**

---

## 3. 下一阶段待办

### 批次 A —— 把右栏做成真正的工作区（承接刚完成的内嵌浏览器）

**A1 右栏拖拽调宽 + 宽度记忆**（建议先做）
- 依据：⑦-B 与 `UI-REGIONS` v1.5「宽度只由用户拖拽决定」；当前只按视图给建议值，该规则**只算半成立**
- 现状：`WorkspaceDock.tsx` 的 `DOCK_SUGGEST_WIDTH`（300 / 544）+ `Conversation/index.tsx` 的 `dockSpace` 钳制中栏 ≥360px，**没有拖拽把手**
- ⚠️ 动手前先读 `AGENTS.md` 3.3：拖拽位移算错过一次（`startVal + delta` 要拆成两个独立量、并代入具体数值验证）
- 验收：拖到下限 220 / 上限（中栏留 360）/ 窗口缩放后不溢出；切页签**不再覆盖**用户已拖的宽度

**A2 右栏折叠态（44px 图标条）**
- 依据：⑦-E 与 v1.4——折叠保留页签与活动指示，**不提供完全关闭**
- 现状：无折叠代码
- 验收：折叠后**原生浏览器视图必须同步收起**（否则会浮在界面上）

**A3 视图类型扩展：Markdown 阅读器 / 文件浏览**
- 依据：⑦-B「其他视图不限个数」；`prototype-work-browser-hifi.html` 已有「文件」视图稿
- 现状：只有「正在处理 / 浏览器」两个页签
- 复用：`Markdown.tsx` / `DiffView.tsx`（会话流已在用）

**A4 多视图资源上限与挂起**
- 依据：约束 ⑦-1——同时存活的重型视图限 2～3 个，超出**挂起**（销毁 `WebContentsView`，保留页签与 URL，切回时重建）
- 现状：每会话只有一个浏览器视图，暂无触发场景；**机制要先立**，否则加视图类型时会失控
- 验收：连开 4 个浏览器页签后最久未用的被挂起，切回能重建

### 批次 B —— 浏览器视图的操作面（当前是纯展示）

**B1 前进 / 后退 / 刷新**
- 依据：原型的 dock-head；`WebContentsView` 原生支持
- 现状：页面只能由 agent 通过 `browser_act navigate` 驱动，用户自己无法操作
- ⚠️ 这会引入一个新问题：**用户操作浏览器是否也要走审批**。动手前先定清楚

**B2 观测抽屉：console / network / downloads**
- 依据：⑦-B「外部世界」视图；`BROWSER-TEST-CASES.md` 已把这四类作为观测面验证
- 现状：数据已在 `browser-observe.ts` 的 `CaptureBuffer` 里，但**渲染层没有任何观测 UI**，只能靠 agent 调 `browser_read`
- 复用：`browser_read` 的 action 面（`console` / `network` / `downloads`）+ `panels/` 下现成样式
- 价值：这是 ⑦-A「现场 vs 叙述」里的「现场」那一半，目前缺一半

**B3 停靠 / 弹出双态**
- 依据：原型的 dock-popout
- 现状：已内嵌；直接「弹出」等于回到独立窗口，**与 ⑦-C 冲突**。需要重新设计（例如弹出仅用于全屏查看、且仍是同一个 view），**不要复用旧的 `BrowserWindow` 方案**

### 批次 C —— 状态语义补完

**C1 任务异常结束态**
- 依据：v3 §6「任务异常结束 → Live Bar 变灰『已中断 / 已结束』，清除所有转圈」
- 现状：`Conversation/index.tsx` 的非运行态**只渲染「空闲」**，没有失败 / 中断态

**C2 空闲态呈现**
- 依据：规则 ⑥-D「空闲态的呈现需明确设计（而非留空）」；`UI-REGIONS` 待决 #5
- 现状：与 C1 同一处，当前仅一个「空闲」文本
- 建议：C1 + C2 合并做一次，**先出设计再改代码**

### 批次 D —— 交互密度与适配

**D1 全局快捷键**（v3 §7）
- 现状：只有 textarea 的 `onKeyDown`（Enter 发送 / 插话）；`Esc` 中断、`⌘N` 新会话、`⌘⏎` 提交授权、`⌘I` / `⌘L` 折叠均**未实现**

**D2 响应式四档**（v3 §8：≥1360 三栏 / 1100–1360 右侧边缘标签 / 900–1100 浮层 + 左栏图标条 / <900 单栏）
- 现状：只做了**内容级**容器查询降级（Live Bar 与工具行 760 / 560 / 520 / 400），**没做布局级**
- ⚠️ ⑦ 现在是原生视图，任何布局级折叠都必须同步 `browser.bounds`，否则视图会浮在错误位置

**D3 `/` 命令菜单**
- 依据：v3 §7 已自注「后端尚未提供命令注册，列为待实现」；对齐 ACP `available_commands_update`
- **前置依赖在后端**，条件不具备前不要动 UI

---

## 4. 现成可复用的实现（别重写）

| 需要 | 已有 |
|---|---|
| 观测数据 | `host/browser-observe.ts` 的 `CaptureBuffer`（console / network / downloads，导航时清空） |
| 视图动作分发 | `HostBridge.handle` + `shared/worker-protocol.ts` 的 `HostCapability`（加动作只需加一个 `case`） |
| 原生视图摆放 | `host/browser-host.ts` 的 `#applyBounds`（视口覆盖 > 渲染层矩形 > 兜底矩形） |
| 跨进程契约 | `shared/protocol.ts` 的 `IPC_CHANNELS` / `IpcInvokeMap` / `IPC_EVENTS`——**编译期强制对齐**，两侧必须同时改 |
| Markdown / diff 渲染 | `Markdown.tsx` / `DiffView.tsx` |
| 中心列面板样式 | `features/Conversation/panels/` |
| 数字缩写 / 心跳点 / 窄栏降级 | `formatTokens` / `.live-dot` / `styles.css` 的容器查询 |

---

## 5. 验收手段（成本从低到高）

1. `npm run typecheck` + `npm test`（279 条纯逻辑单测）+ `npm run build`
2. **夹具端到端（改浏览器能力必跑）**：
   ```powershell
   # 终端 1
   npm run fixture
   # 终端 2（先停掉占用 5173 的开发实例）
   $env:BANYAN_SMOKE="e:/code/opensource/banyan/.smoke-fixture.png"
   $env:BANYAN_SMOKE_MODE="fixture"
   npm run dev        # npm start（preview）亦可
   ```
   看 `.smoke-fixture.png.log` 末行是否 `通过 22/22`
3. **应用内实测**：`BANYAN_SMOKE_MODE=host` 会真实调用模型并**产生计费**；只想看界面时直接启动应用 + **系统级截图**即可
4. 断言清单与手动用例：`docs/BROWSER-TEST-CASES.md`

---

## 6. 推进节奏建议

- 一次一件事（仓库既有习惯：一个提交只做一件事），每件都跑 §5 的 1 + 2
- 优先 **A1**：它让 ⑦-B 从「半成立」变完整，且风险局部
- **B3 / D2 涉及推翻既有结构，先出设计再改代码**
- 任务跨会话时，把「已做到哪、下一步是什么」写回本文档

---

## 7. 上一阶段踩过的坑（下一阶段别重踩）

- **原生视图不参与 DOM 叠层**：`WebContentsView` 浮在渲染层之上，切走页签 / 卸载会话时**必须上报隐藏**，否则会盖住别的内容
- **销毁路径必须判活**：`webContents` 一旦 destroyed，访问任何属性都会抛；顺序是「摘出视图 → 判活 → 关」
- **`capturePage` 拍不到原生视图**：验证内嵌浏览器必须用**系统级截图**，主窗口 `capturePage` 里不会出现它
- **容器查询要设在「中栏宽度」上**，而不是窗口宽度（`max-w-[796px]` 把内边距包进容器才对得上）
- **`viewport` 语义已变**：不再改窗口尺寸，而是给视图覆盖尺寸
- 通用纪律见 `AGENTS.md`（尤其 3.3 位移计算、3.5 设计前先读代码）
