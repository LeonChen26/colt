# Colt

本地 AI Agent 工作台。每会话一个独立进程，agent 在**你的项目目录里**读文件、改文件、跑命令、开浏览器，所有动作都在界面上可见、可拦、可回退。

---

## 这是什么

一个 Electron 桌面应用，把「让 AI 在你机器上干活」这件事做成**可旁观、可干预**的过程：

- **会话 = 一个工作现场**，不是一个聊天窗。界面围绕现场状态组织：模型与上下文占用、成本、心跳、运行态。
- **模型可换**：内置 DeepSeek，也可接任意 OpenAI 兼容 endpoint（含本地服务）。
- **全程本地**：密钥用 Electron `safeStorage` 加密后落盘，明文只在内存与 worker 进程环境变量里；会话数据存在本机 SQLite。
- **能力有闸门**：写文件、跑命令、开浏览器、控制桌面都要过审批，可记住放行规则。
- **技能可继承**：按 Agent Skills（agentskills.io）开放标准，从项目级 `.agents/skills` 与用户级 `~/.agents/skills` 装载 `SKILL.md`，另有一层**内置技能**随应用分发（优先级最低，磁盘上同名可盖它）。进系统提示词的是**清单**（名字 / 说明 / 文件位置），正文由模型按需去读，不占常驻上下文。技能是**声明式文本、不经审批闸门**——这条边界的理由见 `docs/SECURITY.md`。
- **MCP 可扩展**：用 `.colt/mcp.json` 声明 MCP server（本地进程或远程），其工具以普通内核工具进入、**照常过审批闸门**，不是给 agent 开的旁路。配置格式见 [`docs/MCP.md`](docs/MCP.md)。

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

常用命令、开发环境的两个坑（`electron` 的 pin 与 SAC、`file://` 预览）、测试与冒烟自检、代码地图——都在 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## 当前状态

已经能用：项目管理、会话与分支树、对话流（思考轨 / 工具卡内嵌 diff / 授权卡）、模型与思考等级切换、审批三模式与记忆规则、Live Bar 运行态、右栏四页签 + 下钻（清单 / diff / 文件内容）+ 浏览器观测抽屉、内嵌浏览器（含前进后退刷新、上传下载、视口联调标记）、电脑控制、**净值**（基线 → 现在）、统计与规则面板、主题、设置、**MCP 接入**（本地 / 远程，项目级 + 用户级）。

已知缺口记在 `docs/NEXT-PHASE.md` §1、明确不做记在 §3.2。

---

## 文档怎么读

| 文档 | 什么时候读 |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 要改这个仓库时：环境、命令、测试与冒烟、代码地图、提交前检查 |
| [`AGENTS.md`](AGENTS.md) | **动手之前必读**。已犯过的错误与铁律，每条都对应一次真实事故 |
| `docs/PRINCIPLES.md` | **动手前**。设计原则 + 逐条现状，改动是否违背一眼可查 |
| `docs/ARCHITECTURE.md` | 跨进程改动、加 IPC 通道 / 加工具 / 加表字段之前；**升级 pi 依赖之前**（§四） |
| `docs/SECURITY.md` | 碰审批、文件读写、浏览器/电脑控制、密钥之前 |
| `docs/ERRORS.md` | 写任何可能失败的路径之前（失败可见性铁律） |
| `docs/MCP.md` | 接 MCP server 时（配置格式、两个位置、`${VAR}` 与热重载） |
| `docs/UI-REGIONS.md` | 改界面区域时。**界面现状的真源**（逐区域定义 + 版本表） |
| `docs/NEXT-PHASE.md` | 想知道现状基线、哪些明确不做、怎么验收 |
| `docs/DESIGN-todo.md` · `docs/DESIGN-mcp.md` · `docs/DESIGN-subagents.md` | 动这三条线之前。设计决策记录（**均已实施**，含未覆盖项的如实标注） |
| `docs/GLOSSARY.md` | 看不懂某处的编号（`⑦`、`A3-4`、`N1`、`事 B`）时 |
| `docs/archive/` | 已完结的历史文档与概念稿，只在追溯历史时看 |

---

## 许可证

[MIT](LICENSE) © 2026 Colt

`LICENSE` 有三处落点（仓库根、发布产物的 `app.asar` 内、Windows 安装向导的许可页），源码文件顶部标 `SPDX-License-Identifier: MIT`。细节见 [`CONTRIBUTING.md`](CONTRIBUTING.md) §许可证落点。
