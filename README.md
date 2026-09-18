# Colt

本地 AI Agent 工作台。每会话一个独立进程，agent 在**你的项目目录里**读文件、改文件、跑命令、开浏览器，所有动作都在界面上可见、可拦、可回退。

---

## 这是什么

一个 Electron 桌面应用，把「让 AI 在你机器上干活」这件事做成**可旁观、可干预**的过程：

- **会话 = 一个工作现场**，不是一个聊天窗。界面围绕现场状态组织：模型与上下文占用、成本、心跳、运行态。
- **模型可换**：内置 DeepSeek，也可接任意 OpenAI 兼容 endpoint（含本地服务）。
- **全程本地**：密钥用 Electron `safeStorage` 加密后落盘，明文只在内存与 worker 进程环境变量里；会话数据存在本机 SQLite。
- **能力有闸门**：写文件、跑命令、开浏览器、控制桌面都要过审批，可记住放行规则。
- **技能可继承**：按 Agent Skills（agentskills.io）开放标准，从 `<项目>/.agents/skills`（项目级）与 `~/.agents/skills`（用户级）装载 `SKILL.md`；同名时**项目级胜出**，装了什么、跳过了什么都如实提示。进系统提示词的是**清单**（名字 / 说明 / 文件位置），正文由模型按需去读那个文件，不占常驻上下文。技能在**新建会话**时装载。技能是**声明式文本、不经审批闸门**——这条边界的理由见 `docs/SECURITY.md`。

## 这不是什么

写下「不做什么」比「做什么」更能约束后续开发：

- **不是云端服务**。没有账号、没有服务端、不上传会话数据。
- **不是沙箱**。审批是一层**提醒**，判定基于工具名 / 参数 / 命令文本的启发式匹配，**无法对抗刻意构造的绕过**；真正的隔离要靠操作系统权限或容器，本项目不承担该职责（见 `src/main/approval/policy.ts` 的模块说明）。
- **不是通用终端**。命令执行是 agent 的一个工具，不是给用户用的 shell（没有 pty、没有终端视图）。
- **不是多用户协作工具**。多实例、多会话监控明确不在计划内（见 `docs/NEXT-PHASE.md` §3.2）。

---

## 跑起来

需要 **Node ≥ 22**。

```powershell
npm install
npm run dev
```

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式启动（electron-vite） |
| `npm run typecheck` | 三个 tsconfig 全量类型检查（node / web / test） |
| `npm test` | 单测（node:test；**条数以运行输出为准**——不写死：每增删一条用例就变，写下来的当天就过期） |
| `npm run build` | 类型检查 + 构建产物到 `out/` |
| `npm run dist` | 打 Windows 安装包（electron-builder，不发布） |
| `npm run fixture` | 起浏览器测试用夹具站（默认 8787） |
| `npm run probe` | 运行时环境探针 |

### ⚠️ 两个会拦住你的环境问题

1. **`electron` 被精确 pin 在 `44.2.0`，不要用 `^` 升它。** 本机开着 Windows「智能应用控制」（SAC）时会拦未签名的 `electron.exe`，症状是 `npm run dev` 报 `spawn UNKNOWN`（errno `-4094`），而 `build` / `test` 全绿。官方 Electron **本来就不签名**，SAC 按微软信誉库放行，实测阈值在发布后 **7~11 天**——所以「今天能跑」不代表「过几天能跑」。判据与处置见 `AGENTS.md` §五。
2. **预览本地 HTML 不能用 `file://`**，浏览器工具只接受 http/https——先 `python -m http.server` 或 `npm run fixture`。

### 冒烟自检

冒烟是主进程里的真实验证装置（`src/dev/smoke/`），能在渲染层**真派发事件**并断言截图看不见的状态（原生视图矩形、页签数、IPC 落点）。**仅开发期存在**：用 `import.meta.env.DEV` 守卫，生产构建会把整段树摇掉。

```powershell
$env:COLT_SMOKE="dock.png"      # 产物文件名，固定落在 out/
$env:COLT_SMOKE_MODE="dock"     # 选模式
npm run dev
```

| 模式 | 内容 | 断言数 |
|---|---|---|
| `basic` | 主界面自检 | 仅日志 |
| `fixture` | 浏览器能力本体 | **25** |
| `dock` | 右栏 ⑦ 全家桶（页签 / 拖拽 / 折叠 / 下钻 / 净值 / 观测抽屉 / 前后退刷新 / 逐像素对齐 / 视口标记 / `/compact` / `/memory-tidy` / `/skill` / `/` 候选浮层 / 等待授权 / 装不下提示 / 适应宽度） | **211** |
| `model` | 模型解析与降级六段 | **34**（7/6/6/6/1/8） |
| `memory` | 记忆链路端到端（真实 worker → 索引落库 → 检索 → 项目隔离） | **11** |
| `memory-e2e` | 记忆**行为**端到端，真实调用（注入可见性 / 沉淀落盘+索引 / `/memory-tidy` 合并删过时+归档+通知 / 冷层检索） | **12** |
| `ask-user` | 模型提问（`ask_user`）阻塞链路——卡片、选项、载荷、跳过 / 超时收尾、回收不留悬空卡（**不打模型**） | **23** |
| `ask-user-e2e` | 提问链路**真实模型**端到端（模型真的看见并调用 `ask_user` / 全权模式下不被静默放行 / 答案作为工具结果回到模型并接着往下做） | **11** |
| `host` | 宿主能力往返 | 7 |
| `advanced` / `approval` / `reenter` / `crash` | 长会话 / 审批四场景 / 重入 / 崩溃恢复 | 仅日志 |

> ⚠️ **计费**：只有 `fixture`、`dock`、`memory` 与 `ask-user` 四个模式**不调用模型**；其余模式（含不给
> `COLT_SMOKE_MODE` 时的 `basic`）都会真实打模型并产生费用。`memory-e2e` 是记忆的
> **行为**验证，固定打 4 次真实调用——只想验链路别跑它，跑 `memory`。`ask-user-e2e`
> 同理：`ask-user` 已覆盖入队之后的一切，只有「模型自己发起提问」那一段需要打模型。
> `dock` 此前不在此列——它的 `/compact` 段把打桩转给了真实现，会真发两句测试 prompt、
> 计一次费，还把这两句写进用户真实项目的会话历史；v1.41 起该段**只记账、不转发**。
>
> 📌 **`model` 模式会临时改动你的 provider 配置**：`[model/fallback]` / `[model/keyless]` /
> `[model/no-usable]` 三段都要造出「这台机器上只有 XX 服务」的环境（默认解析是从整份列表里挑的），
> 跑完在 `finally` 里原样还回去。做法取**最小副作用**——带密钥的服务**只删密钥、不删条目**
> （万一硬崩，丢的也只是一个密钥值，重填即可），只有免密钥的条目会被整条挪走。
> 详因见 `NEXT-PHASE.md` §5 第 4 条。

---

## 代码地图

```
src/
├─ main/       主进程：窗口、DB、IPC 路由、审批、宿主能力、worker 进程池
│  ├─ approval/   审批闸门：策略判定 / 待审队列 / 大模型分析器 / 可配置项
│  ├─ host/       宿主能力：内嵌浏览器（原生 WebContentsView）、电脑控制、观测
│  ├─ db/         SQLite（schema + 迁移 + DAO）
│  └─ ipc/        渲染层所有调用的落点
├─ preload/    contextBridge 白名单桥（按通道名白名单暴露）
├─ renderer/   React 渲染层
│  └─ src/
│     ├─ features/Conversation/   对话面板：消息流、右栏工作区、授权卡、观测抽屉
│     ├─ components/              通用展示件（Markdown / Diff / 代码 / 终端输出）
│     └─ lib/                     纯函数（diff 分类、清单分组、统计、语言识别…）
├─ shared/     跨进程契约与纯逻辑（IPC 协议、worker 协议、只读白名单、思考等级）
└─ worker/     每会话一个 utilityProcess，持内核 harness/lane
```

四条**边界**值得先记住（详见 `docs/ARCHITECTURE.md`）：

- **内核在 worker 里**，主进程不直接调模型。
- **窗口与 OS 权限在主进程里**，worker 只能发命令、等结果（`toolRpc`）。
- **契约只有一个真源**：`src/shared/protocol.ts` 与 `worker-protocol.ts`。
- **纯逻辑抽进 `lib/`**，因为它们可单测；碰 electron 的留在原处。

---

## 文档怎么读

| 文档 | 什么时候读 |
|---|---|
| `docs/PRINCIPLES.md` | **动手前**。设计原则 + 逐条现状，改动是否违背一眼可查 |
| `docs/ARCHITECTURE.md` | 跨进程改动、加 IPC 通道 / 加工具 / 加表字段之前；**升级 pi 依赖之前**（§四） |
| `docs/SECURITY.md` | 碰审批、文件读写、浏览器/电脑控制、密钥之前 |
| `docs/ERRORS.md` | 写任何可能失败的路径之前（失败可见性铁律） |
| `docs/GLOSSARY.md` | 看不懂某处的编号（`⑦`、`A3-4`、`N1`、`事 B`）时 |
| `docs/UI-REGIONS.md` | 改界面区域时。**界面现状的真源**（逐区域定义 + 版本表） |
| `docs/NEXT-PHASE.md` | 想知道下一步做什么、哪些明确不做、怎么验收 |
| `docs/UI-DESIGN-v3.md` | 想知道**为什么**这么设计。⚠️ 它是设计意图，**不是验收清单**（文首有「本稿 vs 产品现状」表） |
| `docs/UI-RESEARCH.md` | 设计依据：竞品格局、六大用户痛点、ACP 协议模型 |
| `docs/BROWSER-TEST-CASES.md` | 验收浏览器能力时 |
| `AGENTS.md` | **已犯过的错误**与铁律。在这个仓库里动手之前必读 |

---

## 当前状态

已经能用：项目管理、会话与分支树、对话流（思考轨 / 工具卡内嵌 diff / 授权卡）、模型与思考等级切换、审批三模式与记忆规则、Live Bar 运行态、右栏四页签 + 下钻（清单 / diff / 文件内容）+ 浏览器观测抽屉、内嵌浏览器（含前进后退刷新、上传下载、视口联调标记）、电脑控制、**净值**（基线 → 现在）、统计与规则面板、主题、设置。

已知缺口与下一步排在 `docs/NEXT-PHASE.md` §3.1（`N1`~`N4`）与 §3.2（明确不做）。
