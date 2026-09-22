# 贡献指南

> 这份文件面向**要改这个仓库的人**。只想跑起来用它，看 [`README.md`](README.md)；
> 动手之前**必读** [`AGENTS.md`](AGENTS.md)——那里记着已经犯过的错误与铁律。

---

## 环境

需要 **Node ≥ 22**。

```powershell
npm install
npm run dev
```

### ⚠️ 两个会拦住你的环境问题

1. **`electron` 被精确 pin 在 `44.2.0`，不要用 `^` 升它。** 本机开着 Windows「智能应用控制」（SAC）时会拦未签名的 `electron.exe`，症状是 `npm run dev` 报 `spawn UNKNOWN`（errno `-4094`），而 `build` / `test` 全绿。官方 Electron **本来就不签名**，SAC 按微软信誉库放行，实测阈值在发布后 **7~11 天**——所以「今天能跑」不代表「过几天能跑」。判据与处置见 `AGENTS.md` §五。
2. **预览本地 HTML 不能用 `file://`**，浏览器工具只接受 http/https——先 `python -m http.server` 或 `npm run fixture`。

---

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式启动（electron-vite） |
| `npm run typecheck` | 三个 tsconfig 全量类型检查（node / web / test） |
| `npm test` | 单测（node:test；**条数以运行输出为准**——不写死：每增删一条用例就变，写下来的当天就过期） |
| `npm run build` | 类型检查 + 构建产物到 `out/` |
| `npm run dist` | 打 Windows 安装包（electron-builder，不发布） |
| `npm run fixture` | 起浏览器测试用夹具站（默认 8787） |
| `npm run probe` | 运行时环境探针 |

---

## 冒烟自检

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
| `dock` | 右栏 ⑦ 全家桶（页签 / 拖拽 / 折叠 / 下钻 / 净值 / 任务摘要三段顺序 / 观测抽屉 / 前后退刷新 / 逐像素对齐 / 视口标记 / `/compact` / `/memory-tidy` / `/skill` / `/` 候选浮层 / 技能归属（卡不冒充用户）/ 技能工具卡标记 / 等待授权 / 装不下提示 / 适应宽度）+ ④ 的「从这里分叉」（落点是尖端就不给——含末轮被窗口切半截那一切法、位置、始终可见、不署名「Agent」、送出的是最终回复 id、运行中置灰） | **247** |
| `skills-reload` | 技能的**设置页可见性 + 热重载 + 启用/禁用**链路（冷启动装载 / **内置技能随包那份真的装上了** / 加技能不重启会话 / 超长正文的全文与告警 / 单个禁用落到项目级 `.colt/skills.json` 且 `/` 候选随之排除·启用后恢复 / `skills.status`·`skills.rescan`·`skills.setDisabled`·`skills.reveal` 的有会话与无会话形状；**不打模型**） | **18** |
| `model` | 模型解析与降级六段 | **46**（7/6/6/6/1/20） |
| `memory` | 记忆链路端到端（真实 worker → 索引落库 → 检索 → 项目隔离） | **11** |
| `memory-e2e` | 记忆**行为**端到端，真实调用（注入可见性 / 沉淀落盘+索引 / `/memory-tidy` 合并删过时+归档+通知 / 冷层检索） | **12** |
| `ask-user` | 模型提问（`ask_user`）阻塞链路——卡片、选项、多题翻页、自由输入与选项合并回传、空问卷不白屏、输入框回车（非末页翻页 / 末页提交，合成中的回车不算）、载荷、跳过 / 超时收尾、回收不留悬空卡（**不打模型**） | **39** |
| `ask-user-e2e` | 提问链路**真实模型**端到端（模型真的看见并调用 `ask_user` / 全权模式下不被静默放行 / 答案作为工具结果回到模型并接着往下做） | **11** |
| `subagent` | 子代理呈现链路（④ 卡特化 + 有界预览 / 卡面「中止」，右栏不再重复列此刻动作 / **不自动展开右栏** / 下钻的「运行中实时 vs 跑完完整流」分层；**不打模型**） | **21** |
| `subagent-e2e` | 子代理链路**真实模型**端到端（清单可见 / 免闸门但内部写弹卡 / fresh 隔离 / 递归无入口；**打模型**） | **22** |
| `perf` | 长会话渲染开销（rAF 采样最长帧）+ 消息窗口 / 只看问答折叠 / 目录与搜索（**不打模型**） | **31** |
| `host` | 宿主能力往返 | 7 |
| `advanced` / `approval` / `reenter` / `crash` | 长会话 / 审批四场景 / 重入 / 崩溃恢复 | 仅日志 |

> 📌 上表的断言条数**仅作量级参考、会随增删漂移**；验收一律以运行输出为准。

> ⚠️ **计费**：只有 `fixture`、`dock`、`skills-reload`、`memory`、`perf`、`ask-user` 与 `subagent` 这几个模式**不调用模型**；其余模式（含不给
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
> 详因见 `docs/NEXT-PHASE.md` §5 第 4 条。

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

## 提交之前

改动落地前，这两条要全绿：

```powershell
npm run typecheck
npm test
```

**体量闸是其中一条测试**（`tests/size-guard.test.ts`）：`src/` 下任何文件不超过 **2200 行**（`src/dev/` 除外，那是冒烟夹具），`Conversation/index.tsx` 的 hook 数不超过 **50**。闸只挡「又涨了」，不管「该不该拆」；已知大户的名单与原因登记在该文件的 `KNOWN_LARGE_FILES` 里——**碰它们之前先量一下净增行数**，理由见 `AGENTS.md` §1.4。

其余纪律（先读代码再动手、别用脚本反复改写同一个文件、写完清理调试残留……）都在 [`AGENTS.md`](AGENTS.md)，那里每条都对应一次真实事故。

---

## 许可证落点

项目是 [MIT](LICENSE)。MIT 要求「在软件的所有副本或实质部分中保留版权与许可声明」，所以 `LICENSE` 有三处落点：
仓库根、发布产物的 `app.asar` 内（`electron-builder.yml` 的 `files`）、
以及 Windows 安装向导的许可页（`nsis.license`）。源码文件顶部标 `SPDX-License-Identifier: MIT`，
无需读全文即可由工具识别许可。
