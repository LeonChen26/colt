# 设计稿 → 代码：待落地的差异

> **用途**：新会话接手开发时的入口文档。
> **前置**：先读 `AGENTS.md`（尤其 3.5：设计前先读代码确认现状）和 `docs/UI-REGIONS.md`（区域定义与规则）。
> **稿子**：`docs/prototype-work-browser-hifi.html`（概念稿，含顶部状态说明）

---

## 一、当前差异总览

设计稿与代码的差异**已全部收敛**（三项均于 2026-09 落地）：

| # | 项 | 稿子 | 代码现状 | 优先级 | 风险 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 观测栏位置 | 输入框**下方** | 输入框**下方** | P1 | 低（纯前端） | ✅ 已落地 |
| 2 | git 分支 | 会话头显示 `⎇ main` | 会话头显示分支；游离 HEAD 转警示色 | P1 | 中（新增 IPC） | ✅ 已落地 |
| 3 | 浏览器载体 | **内嵌**右栏 | **内嵌**（`WebContentsView` 挂在主窗口右栏） | P2 | **高（需重构）** | ✅ 已落地 |

落地情况与实测证据见下方各节的状态说明。

---

## 二、逐项说明

### 1. 观测栏位置

> **状态（2026-09）：已落地。** Live Bar 已移到输入框下方并去掉自身边框；其中的模型选择器已移回 ⑤ 输入区（会话级模式选择器一并移到 ⑤，与原型 `.tools` 一致）；并按原型补上「上下文」标签、64px 占用条、数字缩写（`69.7k / 1.0M`）与容器查询窄栏降级。下列步骤保留作实现记录。

**稿子**：Live Bar 在输入框**下方**（`docs/prototype-work-browser-hifi.html` 搜索 `live-bar`）。

**代码**：`src/renderer/src/features/Conversation/index.tsx`，在输入区**上方**
（`col-start-1 row-start-3` 的 `border-t border-p-3` 块内，约 520 行）。

**改动**：
- 把状态栏那段 JSX 移到 `<textarea>` 之后
- 样式从"上方带下边框"改为"下方无边框"（稿子里是 `padding:7px 2px 0`，无背景无边框）

**依据**：⑥-E（位置在输入区下方）——与"交办"动作相邻，发完即可观察状态。

**已完成的部分（不要重做）**：
- 稿子里已移除模型选择器、会话级模式选择器（违反 ⑥-A 只读区不放操作）
- 代码里这两个 Picker 仍在 Live Bar 内，需要一并移除
  - 模型选择 → 应保留在输入区（⑤）
  - 会话级模式 → **已决定暂不处理**，保留现状

---

### 2. git 分支

> **状态（2026-09）：已落地，且在运行的应用里实测通过。** `git.status` 通道已加（`protocol.ts` 的 `IPC_CHANNELS` 与 `IpcInvokeMap` 同步）；主进程读 `.git/HEAD`，兼容 worktree / submodule 的 `gitdir:` 指针（实测：普通仓库 / 关联 worktree / `--separate-git-dir` / 游离 HEAD 均正确）；会话头出分支 chip，游离 HEAD 转警示色，窗口重新获焦时刷新。
>
> **应用内实测（2026-09）**：① 窗口开着时把 HEAD 切到临时分支 `zz-probe-tmp`，窗口失焦再获焦后 chip 由 `main` 变为 `zz-probe-tmp` —— **获焦刷新生效**；② `git checkout --detach` 后同样操作，chip 变为琥珀色「游离 HEAD」—— **游离态显示生效**（测完已还原 `main` 并删除临时分支）。
>
> **未做**：异常回退到 `git` 命令（`.git` 指针已覆盖全部实测场景，失败即隐藏分支）；chip 点击切分支（原型标为「预留」，属新功能，另起一轮）。

**稿子**：会话头显示 `📁 E:/code/opensource/banyan  ⎇ main ▾`

**代码**：会话头有 cwd（`index.tsx:365`），**没有 git 分支**。

**需要做的事**：

**(a) 新增 IPC**（你们的契约是编译期强制的，两处必须同步改）

```
src/shared/protocol.ts
  - IPC_CHANNELS 数组加 "git.status"
  - IpcInvokeMap 加 "git.status": { request: {cwd}, response: {branch, detached, isRepo} }

src/main/ipc/index.ts
  - 注册 handler

src/main/ 新增实现
  - 读 git 分支
```

**(b) 实现选型**

| 方案 | 优点 | 缺点 |
|---|---|---|
| 读 `.git/HEAD` | 快，无子进程 | worktree / submodule 要额外处理 |
| `git rev-parse --abbrev-ref HEAD` | 准确 | 有进程开销 |

**建议**：读 `.git/HEAD` 为主，异常时回退到命令，失败则隐藏分支。

**(c) UI**

- 等宽字体 + 分叉图标 + 下拉箭头
- **带边框**（可点击，预留切换分支）；cwd 不带边框（只读信息）
- 窄栏降级：`>900px` 完整 → `620–900px` cwd 截断 → `<620px` **隐藏 cwd，保留分支**
  - 依据：改错分支出事，比看错目录严重

**依据**：②-B（会话上下文必须可见）

---

### 3. 浏览器内嵌（高风险，单独一轮）

> **状态（2026-09）：已落地。** 浏览器由独立 `BrowserWindow` 改为挂在主窗口上的 `WebContentsView`；右栏成为工作区容器（页签「正在处理」/「浏览器」）；新增 `browser.bounds` / `browser.state.get` 通道与 `browser.state` 事件；页面走独立 partition `persist:banyan-browser`。
>
> **未做（明确留作后续）**：弹出/停靠双态、前进后退刷新按钮、观测抽屉（console/network/downloads 面板）、右栏拖拽调宽（当前按视图给建议值 300 / 544 并钳制中栏 ≥360px）、折叠态 44px 图标条、同时存活视图数上限与挂起（约束 ⑦-1，当前每会话仅一个浏览器视图，暂无触发场景）。

**稿子**：浏览器内嵌在右栏，作为工作区的「浏览器」视图。

**代码（改造前）**：`src/main/host/browser-host.ts` 的 `#windowFor()` 创建独立 `BrowserWindow`。

**实际改动**：

| 文件 | 改动 |
|---|---|
| `browser-host.ts` | `BrowserWindow` → `WebContentsView`（`#windowFor` → `#viewFor`）；新增 `attachWindow` / `setBounds` / `stateOf` / `onState`；`#applyBounds` 按「视口覆盖 > 渲染层矩形 > 兜底矩形」摆放；网络/下载观测改挂浏览器专属 partition |
| `host/index.ts` | `attachWindow` / `onBrowserState` / `setBrowserBounds` / `browserState` 转发 |
| `main/index.ts` | `attachWindow()` 内同时登记 `sessionManager` 与 `hostBridge` |
| `session-manager.ts` | `attachWindow` 里把浏览器视图状态接到 `browser.state` 推送出口 |
| `shared/protocol.ts` | 新增 `browser.bounds` / `browser.state.get` 通道与 `browser.state` 事件 |
| `main/ipc/index.ts` | 注册两个通道 |
| 渲染层 | 新增 `WorkspaceDock.tsx`（页签 + 浏览器面板 + 矩形上报）；`Conversation/index.tsx` 接入自动切页签（⑦-F）与右栏宽度建议值 |

**核心技术难点：bounds 同步（实测已解决）**

`WebContentsView` 不在网页流里，位置大小靠 `setBounds({x,y,width,height})` 用**窗口内容坐标**指定。实现方式：

- 渲染层放一个「页面区域」占位 div，用 `getBoundingClientRect()` 量出矩形
- 经 `browser.bounds` 发给主进程 → `view.setBounds(rect)`
- 布局变化（页签切换 / 窗口缩放 / 右栏调宽）由 `ResizeObserver` + `window resize` + effect 依赖变化三路覆盖
- **切走页签 / 卸载组件时必须上报 `null`**：原生视图不参与 DOM 叠层，不隐藏就会浮在界面上盖住别的内容

**`viewport` 动作语义变化**（原实现改窗口内容尺寸，内嵌后无「窗口」可改）：
改为给视图**临时覆盖尺寸**（锚点仍是面板左上角），「恢复默认」= 撤销覆盖、交还给面板实测矩形。
据此 `smoke.ts` 里 `已恢复默认视口：\d+x800` 的断言放宽为 `\d+x\d+`。

**❗ 风险提醒（已处理）**：`docs/BROWSER-TEST-CASES.md` 有 **22 条断言**，
其中部分依赖 `BrowserWindow` 的行为（如"未新开窗口"）。

**实测结果（2026-09）**：
- **夹具 22 条断言：22/22 通过**（含 viewport 窄屏/恢复、弹窗接管、「未新开窗口」、「关闭会话未抛未捕获异常」）
- **应用内**：模型驱动 `browser_act navigate` → 右栏自动切到「浏览器」页签（⑦-F）→ 夹具页在右栏内正常渲染、URL 条与页面区域对位无偏移；日志 `窗口数：1`（无独立窗口）；`浏览器视图：{"loaded":true,"url":"http://127.0.0.1:8787/"}`

**已完成的设计决策（已按此实现，不要重新讨论）**：
- 新视图是 `WebContentsView`（Electron 44 正式 API）
- 页面用**独立 session/partition**，与应用自身隔离（网络/下载观测因此不再需要 webContentsId 过滤）
- 视图级懒创建：未激活的页签不创建 view
- 同时存活的重型视图限 2～3 个，超出挂起（见 `UI-REGIONS.md` 约束 ⑦-1）

---

## 三、可直接复用的现成实现

**不要重写这些**，它们已经在代码里且质量良好：

| 能力 | 位置 |
|---|---|
| Markdown 渲染 + 代码高亮 | `components/Markdown.tsx`（react-markdown + rehype-highlight + `--color-code-*` 令牌） |
| Diff 对比 | `components/DiffView.tsx` |
| 终端输出 | `components/TerminalOutput.tsx` |
| 工具卡 | `features/Conversation/MessageList.tsx` 的 `ToolCard` |
| 思考轨 | 同上，`ThinkingRail` / `ThoughtBlock` |
| 授权卡 | `features/Conversation/ApprovalCard.tsx` |
| 跟随线 | `features/Conversation/FollowPanel.tsx` |
| 分支树 | `features/BranchTree.tsx` |

---

## 四、务必遵守的约定

1. **改前先读代码**（`AGENTS.md` 3.5）——不要对着截图推测功能
2. **新增 UI 先在 `UI-REGIONS.md` 找归属区域**，不符合任何区域就不要加
3. **IPC 契约是编译期强制的**：`IPC_CHANNELS` 数组与 `IpcInvokeMap` 必须同步改，否则 typecheck 失败
4. **只读区（⑥）不放操作**、**只读视图不提供编辑**（文件阅读器）
5. 改完跑：`npm run typecheck` && `npm test`

---

## 五、未决 / 已知事项

| 项 | 状态 |
|---|---|
| 权限模式（会话级模式）归属 | **暂不处理**（用户已决定） |
| 左栏 L1/L2 分层 | **不适用**——那两个 UI 是计划中功能，短期不做 |
| 观测栏是否移到会话头 | 已决定**不动**（不会看不到） |
| 文件树折叠 | 稿子已实现，**使用频率可能低**，可考虑去掉 |
