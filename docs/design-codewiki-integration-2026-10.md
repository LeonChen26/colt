# Colt × CodeWiki 集成方案

> **状态**：P2（只读浏览 + 注入）与 P1（内置可选安装目录）**已实施**，见 §4 各节的状态段；
> P0 是配置级方案（不写进本仓库的代码），P3 未做。
> **设计输入**：2026-10-17 在**本仓库**上完整试跑过一次 CodeWiki 2.0（产物见 `docs/wiki/`，MCP 模式、零 API 花费）。文中的「实测」都指那一次，不是推演。
> **本文回答三件事**：能不能接、接哪一层、分几步接。实施步骤落地时另开 impl-plan，不写在这里。

---

## 0. 结论

**能接，而且 Colt 的扩展面几乎正好对上**：MCP 客户端、右栏容器、IPC 契约、只读白名单、子代理 lane、`transform_context` 注入——CodeWiki 缺的「被消费」那一侧，Colt 全有。

但「支持 CodeWiki」有三种含义，成本差一个数量级，价值也差一个数量级：

| 含义 | 本质 | 新增代码 | 是否值得做 |
|---|---|---|---|
| A. 接一个 MCP server | 用户在 `.colt/mcp.json` 里加一条 | **0** | 先做，但它只是「能用」 |
| A′. **内置可选安装** | 设置页里一行「装/不装」，内置目录 + 运行时探测 | ~600 行（不做下载则 ~30 行） | **接入形态选它**，见 §2.5；✅ 已实施（§4 P1） |
| B. 消费侧整合 | 右栏能读、上下文能看到 | ~600 行 | **最该做**，收益在这里 |
| C. 生产侧整合 | 面板里能一键生成/增量更新 | ~800 行 + 分发问题 | 可延后（MCP 已能写，只是体验差） |

三条判断决定了整个方案的形状：

1. **生成不能放进主会话**。一次全量是「每叶子一页」的 N 次写作，Claude 上下文与审批卡都撑不住（见 §1.3）。
2. **产物就是契约**。主进程、worker、面板都只读 `docs/wiki/` 下的三个文件（`module_tree.json` / `metadata.json` / `*.md`），不各自解析源码——与仓库「契约只有一个真源」的纪律同构。
3. **只读整合先于生产整合**。wiki 可以是 CI 生成的、别人提交的、上一次会话生成的；能读能查，价值已经成立。

---

## 1. 事实基线

### 1.1 CodeWiki 2.0 到底提供了什么

| 能力 | 实现 | 是否要 LLM | 对我们的意义 |
|---|---|---|---|
| 代码分析 | tree-sitter，8 种语言，产出组件 + 依赖图 | **否** | 免费、可反复跑，可以当「结构索引」用 |
| 模块聚类 | 组件 → 模块树（`module_tree.json`） | 否 / 可交模型 | 面板的导航骨架 |
| 页面写作 | 每叶子模块派一个 agent 写一页 + Mermaid | 是 | 唯一花钱的部分 |
| 增量更新 | `generate --update`，按**组件**（非文件）做 diff | 是（只跑受影响的叶子） | 面板「刷新」按钮的底座 |
| 静态查看 | `--github-pages` → `index.html` | 否 | 我们**不**用它（Electron 里没必要再嵌一个浏览器） |
| MCP server | `codewiki mcp`，10 个工具（8 精细 + 2 legacy） | 精细模式否 / legacy 是 | A 方案的入口 |
| Web 应用 | Docker + FastAPI | 是 | 不做，留给团队服务器 |

MCP 那 10 个工具的实际分工（读的是 `codewiki/mcp/server.py`）：

- 精细 8 个：`analyze_repo`、`read_code_components`、`save_module_tree`、`get_processing_order`、`write_doc_file`、`edit_doc_file`、`get_prompt`、`close_session`
- legacy 2 个：`generate_docs`、`get_module_tree`——前者要 `codewiki config set` 过，后者要求仓库里已有产物

关键点：**精细模式里「谁写页面」是客户端（也就是我们）**。CodeWiki 只负责切分与校验（Mermaid 语法检查就在 `write_doc_file` 里）。这既是「零额外密钥」的来源，也是「N 页全进上下文」的来源。

### 1.2 Colt 已有的扩展位（不用新建机制）

| 需求 | 现成的东西 | 位置 |
|---|---|---|
| 让模型看见 CodeWiki 工具 | MCP 客户端（stdio / HTTP、超时、热重载、掉线告知） | `worker/lib/mcp-tools.ts`、`shared/mcp-config.ts` |
| 在右栏放一页 wiki | `DockKind` + `DOCK_KIND_META`，菜单项由 `closable` 推导 | `renderer/.../WorkspaceDock.tsx` |
| 渲染 Markdown | `<Markdown>`（react-markdown + GFM + highlight） | `renderer/src/components/Markdown.tsx` |
| 让模型查 wiki | 工具 + 只读白名单唯一真源 | `worker/lib/*-tool.ts`、`shared/readonly-tools.ts` |
| 每请求注入「仓库地图」 | `transform_context` 钩子 | `worker/entry.ts` |
| 长任务不占主对话 | 子代理 lane（独立白名单 + 模型路由 + 时间上限 + 交接） | `worker/lib/subagent.ts` |
| 文件读取的路径边界 | `path-boundary.ts` + `file-read.ts`（根由 sessionId 推） | `main/` |
| 失败可见 | `docs/ERRORS.md` 五问清单 + `session_events` 落库 | — |

### 1.3 试跑实测（这是全篇最硬的一节）

在本仓库跑的结果：

| 指标 | 值 |
|---|---|
| 组件数 | 1102（TypeScript 1087） |
| 叶子模块 | 135，组件分配 **135/135 全覆盖**（0 unmatched / 0 leftover） |
| 产出页数 | 12 页 / 644 行 Markdown + 15 张 Mermaid |
| 产物体积 | **3.2 MB**（其中 `temp/dependency_graphs/*.json` 占绝大部分） |
| API 花费 | **0**（分析在本地跑，写作由会话模型完成） |
| 主会话消耗 | 约 12 轮 `write_doc_file`，每轮结果都回灌上下文 |

两个真实故障：

1. **`mcp>=2.0` 会让 CodeWiki 的 MCP server 直接起不来**。2.x 移除了 `Server.list_tools()` / `call_tool()` 装饰器 API，`import codewiki.mcp.server` 抛 `AttributeError`；而 CodeWiki 的 `pyproject.toml` 只写了 `mcp>=1.0.0`。必须钉 `mcp<2`（本机降到 1.30.0 后正常）。
2. **`coding-agent-wrapper`（caw）从 GitHub 拉不下来**（代理 502）。它只服务 `--provider claude-code` / `codex` 两个**订阅模式**；API-key 模式、MCP 模式、Web 模式都不受影响。产物里不要提供这两个选项。

还有一个不是 bug、但会持续咬人的事实：**中文模块名会变成中文路径**。本次产物里有 `主进程（Electron Main）/会话编排与 IPC.md`——`wc` 当场就断了，浏览器 URL、Markdown 相对链接、面板路由都要额外处理。见 D3。

---

## 2. 三种「支持」，选型对比

| 维度 | A. 仅 MCP | B. 消费侧（面板 + 一行指针） | C. 生产侧（生成器进产品） |
|---|---|---|---|
| 新增代码 | 0（一份 json + 一篇文档） | ~900 行 / 9 文件 | ~800 行 / 7 文件 + 打包 |
| 密钥 | 不需要（精细模式） | 不需要（只读） | **需要**（codewiki 自己的 LLM 配置，或桥接 Colt 的 key） |
| 主会话上下文 | 被 N 页写作灌满 | 只吃「模块地图」~1.5k token | 不占（子进程） |
| 审批体验 | **N 张卡**（每页一次写盘） | 无（只读） | 一次显式确认 |
| 可中断 | 靠 abort 主 lane | 无长任务 | 可取消（杀进程树） |
| 失败可见性 | 工具报错即止，无进度 | 面板显示「未生成 / 已过期」 | 进度条 + 日志 + 退出码 |
| 离线 | 要本机 Python | 要（读产物即可） | 要（生成时） |
| 适合谁 | 尝鲜、一次性仓库 | **所有人** | 想「在 Colt 里点一下就出文档」的人 |

**结论**：A 是入口（形态应该是「内置可选 MCP」，见 §2.5）；B 是产品价值的主体；C 只在需要「一次确认 + 路径固定」时才做，可延后。

> **修订（2026-10-17 二次评审）**：原先的 B 里塞了一个自研 `wiki` 只读工具（`worker/lib/wiki-tool.ts` + 只读白名单）。复核后**砍掉**——MCP 的 10 个工具里本来就没有 `read_page`，读文档靠现成的 `read` / `grep` 就够，注入一行指针即可。B 的规模从 ~900 行降到 ~600 行，且少一个需要长期维护的真源。

### 2.5 接入形态：内置可选 MCP，以及它给不了的

**是，接入形态应该做成「内置、可选安装的 MCP」**——不要求用户去手写 `.colt/mcp.json`，也不需要为它新增一套自研工具面。但要把三件独立的事分开，否则「可选」会变成一个点不动的开关：

| 问题 | 事实 | 谁来解决 |
|---|---|---|
| ① **分发** | Colt 是 Electron，CodeWiki 是 Python 3.12+ 包。**换协议不会让 Python 消失**——MCP 只规定「怎么说话」，不规定「谁提供运行时」 | 只有两条路：随包带运行时（uv / embeddable，三平台各几十 MB），或首启按需下载，或要求用户自装（默认） |
| ② **安装与生命周期** | 现在的设置页**只能读声明**（`mcp.status` → 列已声明的 server），没有目录、没有安装按钮、没有卸载 | 需要新增一条**内置目录（preset）**：`id / 名称 / 一句话 / 安装方式 / 健康检查 / 卸载`。安装 = 写**用户级** `~/.colt/mcp.json`（对全部项目生效，必须显式同意）→ 触发热重载 → 展示工具清单 |
| ③ **能力边界** | MCP 让**模型**能用 CodeWiki；它**不产生界面**，也不改变「谁写页面」 | 浏览仍要面板；写作仍由调用方（会话模型 / 子代理）完成 |

具体到 CodeWiki，MCP 给不了的三件事：

1. **读**。10 个工具是 `analyze_repo / read_code_components / save_module_tree / get_processing_order / write_doc_file / edit_doc_file / get_prompt / close_session`（+2 个 legacy），**没有「读某一页」**。所以「模型能查 wiki」只能靠 `read` / `grep` 加一句指路，不能靠 MCP。
2. **写作不进主会话**。MCP 是「谁调用谁写」：`write_doc_file` 在谁的 lane 里发出，token 就记在谁的账上。放子代理能隔离上下文，但**改不了这个事实**。
3. **写入路径固定**。`write_doc_file` 的路径来自**模型参数**；而 Colt 的审批规则只有「整个工具」与「同参数签名」两种范围（`src/main/approval/policy.ts` 的 `scope: "tool" | "signature"`），**没有路径范围**。想少弹卡就只能对整个工具放行 —— 那等于允许模型往工作区任意位置写 `.md`。这条不是体验问题，是安全边界。

所以终局不是「面板 vs MCP」，而是分工：

- **MCP（可选安装）**：提供「分析 + 写作」的能力入口，零额外密钥（精细模式用会话模型）。
- **面板（零 MCP 依赖）**：提供「看」，读的是 `docs/wiki` 这个产物——CI 生成的、别人提交的、上次会话生成的都能看。
- **runner（可选，L3）**：需要「一次确认、路径由程序固定、可取消」时才上；它不是 MCP 的替代品，而是**写入通道**的更严形态。

---

## 3. 推荐架构

```
┌────────────────────── Renderer ──────────────────────┐
│  WikiPanel（右栏页签）                                │
│   ├─ 模块树（来自 module_tree.json）                  │
│   ├─ Markdown + Mermaid（懒加载）                     │
│   └─ 状态条：生成于 <commit> · 落后 N 个提交 / 未生成  │
└───────────┬───────────────────────────┬──────────────┘
            │ invoke                     │ on(wiki.state)
┌───────────▼───────────────────────────▼──────────────┐
│  main/wiki                                            │
│   read.ts     读产物（路径边界、页面清单、新鲜度）     │
│   runner.ts   跑 codewiki（子进程、进度、取消、单飞）  │
│   probe.ts    python / git / codewiki / mcp<2 四连检  │
└───────────┬──────────────────────────────────────────┘
            │ spawn(codewiki generate|--update)
            ▼
   docs/wiki/  ── 唯一契约 ──┐
   ├ module_tree.json        │
   ├ metadata.json (commit)  │
   ├ *.md (+ Mermaid)        │
   └ temp/ (忽略)            │
                             ▼
┌──────────────────────  Worker ───────────────────────┐
│  wiki 工具（只读：map / search / read）                │
│  transform_context 注入「模块地图」（有预算、有新鲜度）│
└──────────────────────────────────────────────────────┘
```

三条不变量：

1. **产物是唯一真源**。主进程不解析源码、worker 不读 CodeWiki 的 session 目录、面板不自己拼路径。
2. **写入只有一个入口**：`wiki.generate`（用户动作）。模型**没有**「启动一次生成」的工具——那是花钱且耗时的操作，不能由模型自己决定。
3. **读文档不新造工具**。`read` / `grep` 已经够用，加一句话指路即可；MCP 那 10 个工具里也没有 `read_page`。（原设计里的 `wiki` 只读工具已砍，见 §2.5 修订。）

---

## 4. 分期落地

### P0 · 零代码（一份配置 + 一个技能 + 一份文档）

产物：

| 文件 | 作用 |
|---|---|
| `docs/MCP.md` 追加一节 | 写清 codewiki server 的配置、`mcp<2` 的坑、订阅模式不可用 |
| `.agents/skills/codewiki/SKILL.md` | 把 `guides/mcp-ide-mode.md` 的流程固化成技能：`analyze_repo` → 人工/模型聚类 → `save_module_tree` → `get_processing_order` → 逐页 `write_doc_file` → `close_session` |
| `.agents/agents/wiki-writer.md` | 子代理定义：`tools: read, grep, glob, mcp_codewiki__analyze_repo, mcp_codewiki__save_module_tree, mcp_codewiki__get_processing_order, mcp_codewiki__write_doc_file`，`model:` 指定一个便宜模型 |

> ⚠️ `.colt/` 在 `.gitignore` 里，所以**配置模板不能放 `.colt/mcp.json`**，要写进技能文档让人自己粘。

验收：新会话里说「给这个仓库生成 wiki」，子代理跑完，`docs/wiki/overview.md` 存在且 `metadata.json` 有 commit。

已知代价（必须写进文档，不能只说好处）：**每写一页过一张审批卡**；写作 token 花的是**子代理那个模型**；没有进度条。

### P1 · 内置可选安装（MCP 目录 + 运行时探测）

> **实施状态（2026-10-18，分支 `feat/wiki-panel`）**：已落地（不含下载/绑定 Python 的分发优化）。
> 实际落点：`shared/mcp-catalog.ts`（纯数据目录：名称 / 一句话 / `requirements` / `pins` /
> 手动命令；视图与进度类型也在这里）、`main/mcp/probe.ts`（四连检，执行器 `Runner` 注入）、
> `main/mcp/user-config.ts`（**只加/删我们那一条**，坏 JSON 一律报错不改写）、
> `main/mcp/install.ts`（探测 → venv → pip → 复检 → 写配置；同目录**单飞**）、
> `protocol.ts` 三通道 + 一条事件、`renderer/.../Settings.tsx` 的 `McpCatalogSettings`。
> 验证：`tests/mcp-catalog.test.ts`（19 条，注入执行器覆盖 Python 3.11 / mcp 2.x / 无 Python /
> 装完复检不过 / 并发单飞 / 配置坏掉不覆盖）+ 新冒烟模式 `COLT_SMOKE_MODE=mcp-catalog`
> （13/13，不打模型；**只断言结构**，探测结论随机器而变）。
>
> **呈现层另有一稿**：`docs/ui-mcp-catalog-2026-10.md`（高保真：`docs/archive/prototype-mcp-catalog-hifi.html`）。
> 那一稿只动界面（加 `McpProbeItem.kind` 把「前置条件」与「待安装件」分开、明细折叠、动作文案随状态），
> 主进程四层与 IPC 形状不变；尚未实施。
>
> 与计划的差异：① 「下载 Python」没做——只在探测里给一条 python.org 的引导；真正建运行时用的是
> 用户机器上已有的 `python -m venv`，`pip install` 走用户自己的索引。② 安装后的运行时是
> `<userData>/runtimes/<id>`（Colt 自己的目录），不是 `uv tool`；卸载默认只删配置、留运行时。
> ③ 设置页里「已安装」与「运行时缺失」是**两个**状态：配置指着一条不存在的路径时不能报「已安装」。

目标：设置页里出现一行「CodeWiki（仓库文档生成）」，可选安装/卸载；不装不影响任何现有功能。

| 文件 | 改动 | 规模 |
|---|---|---|
| `shared/mcp-catalog.ts` | **纯数据**目录：`id / 名称 / 一句话 / requirements / pins / 手动命令`。首条是 `codewiki` | +150 ✅ |
| `main/mcp/install.ts` | 安装：探测 → `python -m venv` → `pip install codewiki==2.0.0 "mcp<2"` → 复检 → 写用户级 `~/.colt/mcp.json`；同目录单飞 | +250 ✅ |
| `main/mcp/probe.ts` | 四连检（python / git / codewiki / `mcp<2`），逐项返回「缺什么 + 一条可执行命令」；执行器可注入 | +250 ✅ |
| `main/mcp/user-config.ts` | 用户级配置的**最小改动**读写（保留别人的条目与顶层未知字段；坏 JSON 报错不覆盖；临时文件 + rename） | +110 ✅ |
| `shared/protocol.ts` | 通道 `mcp.catalog` / `mcp.install` / `mcp.uninstall`，事件 `mcp.installProgress` | +45 ✅ |
| `main/ipc/index.ts` | 3 个 `handle`（安装/卸载走 `handleWithSender`，进度推回发起窗口） | +80 ✅ |
| `renderer/.../Settings.tsx` | MCP 分区块**上方**加「可选安装」：四连检、钉版本、安装/卸载、进度流水、手动命令折叠 | +330 ✅ |
| `tests/mcp-catalog.test.ts` + `smoke/modes/mcp-catalog.ts` | 19 条单测 + 13 条冒烟（免费） | +330 ✅ |

四条纪律：

1. **默认不装**。Colt 不替用户往机器上装 Python 环境；「可选」必须是真的可选。
2. **但必须可见**。设置页有这一行、面板空态有入口——否则「可选」等于「没人知道」（`AGENTS.md` §3.6 的镜像：不是死控件，也不能是隐形控件）。
3. **写用户级配置要显式同意**：`~/.colt/mcp.json` 对**全部项目**生效，写之前说清这一点。
4. **卸载分两档**：「移除配置」（保留运行时，重装秒回）/「连同运行时一起清」。默认前者。

> 若不做运行时下载（比如首发只支持手动安装），P1 退化成一块「复制这条命令」的说明——**成本从 600 行降到 30 行，仍然值得做**，因为它解决了「用户不知道有这回事」。

> **呈现层待改**：这一屏的上层结构（设置页整体重新设计：左导航 + 行式设置项 + 作用域徽标）见
> `docs/ui-settings-redesign-2026-10.md`。本表 `Settings.tsx +330` 那一行是按「单列流水线」估的，
> 导航化之后该分区的实现会拆到独立的 panel 组件里，行数与落点都会变。

### P2 · 只读浏览（面板 + 一行指针，零 MCP 依赖）

> **实施状态（2026-10-18，分支 `feat/wiki-panel`）**：P2 全部落地，含 `transform_context` 注入。
> 实际落点：`shared/wiki.ts`（目录唯一真源）、`shared/wiki-tree.ts`（布局规则，主进程与 worker 共用
> ——这条是实施中补的：两处各写一遍「模块 → 页面」的映射，CodeWiki 的两种布局迟早在其中一处漏掉）、
> `shared/wiki-map.ts`（纯渲染的注入块）、`worker/lib/wiki-map.ts`（读盘 + mtime 短路 + git 新鲜度 TTL）、
> `main/wiki/read.ts`、`protocol.ts` 两通道、`renderer/.../panels/WikiPanel.tsx` + `MermaidBlock.tsx`
> + `lib/wiki-link.ts`、`WorkspaceDock.tsx` 加 `wiki` 视图、
> `tests/wiki-read.test.ts` + `tests/wiki-link.test.ts` + `tests/wiki-map.test.ts`。
> 与计划的差异：`mermaid` 成为新增依赖（`^11.17.2`）——构建后按需分包（core 1.2MB 的
> 懒加载 chunk，不进首屏），`pre` 渲染器改成「mermaid → 画图，其余 → 原 CodeBlock」。

改动清单：

| 文件 | 改动 | 规模 |
|---|---|---|
| `shared/protocol.ts` | 通道 `wiki.status` / `wiki.page`（**没有** `wiki.refresh`：面板每次打开现读，产物由外部生成，主进程没有可缓存的写路径） | +30 ✅ |
| `main/wiki/read.ts` | 读 `module_tree.json` + `metadata.json` + 页面清单；路径边界复用 `path-boundary.ts`；staleness 计算 | +150 ✅ |
| `main/ipc/index.ts` | 2 个 `handle(...)`，根由 `sessionId → 项目` 推（**不允许渲染层传根**） | +14 ✅ |
| `renderer/.../panels/WikiPanel.tsx` | 模块树 + Markdown + Mermaid（动态 `import("mermaid")`）+ 状态条 | +330 ✅ |
| `renderer/.../WorkspaceDock.tsx` | `DockKind` 加 `"wiki"`，`DOCK_KIND_META` 加标题/图标；加「+」菜单出口 | +18 ✅ |
| `worker/entry.ts` + `worker/lib/wiki-map.ts` | `transform_context` 里注入模块地图（+一句「用 read 读某页」）；mtime 短路、git 新鲜度 5 分钟 TTL、无产物不注入 | +180 ✅ |
| `tests` | 读取层 / 链接归一 / 注入块的用例 44 条；`tests/smoke` dock 模式的菜单断言由 6 项放宽到 7 项 | +15 ✅ |

面板必须自己处理的三个细节（都是本次实测撞出来的）：

1. **相对链接带尖括号**：产物里是 `[文本](<渲染层（React）/通用组件.md>)`——文件名含空格/括号时 Markdown 必须用 `<...>` 包裹。解析器要同时认 `](x)` 与 `](<x>)`，再做相对当前页的路径归一。
   ✅ 落在 `lib/wiki-link.ts`：剥 `#anchor`、解 `%xx`、挡 `scheme:`、越界返回 null（外链照旧交给系统浏览器）。
2. **Mermaid 是代码块**：`<Markdown>` 现在把 ```mermaid 当普通代码高亮。面板要覆盖 `code` 渲染器，只在 `language-mermaid` 时走动态组件（mermaid 体积是 MB 级，不能进首屏包）。
   ✅ 落在 `panels/MermaidBlock.tsx`：`import("mermaid")` 惰性加载、`securityLevel: "strict"`、解析失败降级成源码块而不是白屏。
3. **概览页没有父目录**：`overview.md` 与顶层模块页同级，面包屑要按 `module_tree.json` 的层级算，不能靠路径切分。
   ⚠️ 未按计划做面包屑：页头只显示末段文件名（`title` 属性给全路径），返回一律回目录。理由是当前产物最多两层，面包屑的导航价值还不如那行高度——真需要再补，数据（`module_tree`）已经在手。

注入的预算与格式（`transform_context`）：

```
## 仓库 Wiki（生成于 2d1a9a4，落后 3 个提交）
- docs/wiki/overview.md：项目做什么、四进程架构
- docs/wiki/main-process/session-orchestration.md：进程池、命令路由、视图投影
- ...
需要细节就 read 对应页；只有 wiki 里没有的才去 grep 源码。
```

上限 **1.5k token**（超了按模块规模截断并注明「已截断」）；**没有 wiki 就一个字都不注入**；wiki 存在但落后超过阈值时，注入里明说「已过期，结论仅供参考」——不能让它看起来是新鲜事实（`docs/ERRORS.md` 的「持续撒谎」是这里最贵的一类错误）。

### P3 · 写入闭环（runner，可选）

> 只有当你需要「**一次确认**、**写入路径由程序固定**、**可取消**」时才做这一步。若接受「子代理用 MCP 逐页写、每页一张审批卡」，跳过它不影响 P1/P2 成立。

`main/wiki/runner.ts` 的七条约束：

1. `spawn` 不经 shell，参数走数组（`--output docs/wiki`、`--exclude ...`），不做字符串拼接。
2. `cwd` = 项目根；`env` 用白名单投影（同 `main/lib/worker-env.ts` 的口径），只补 `PATH` 与 `CODEWIKI_*`。
3. 按行读 stdout/stderr（CodeWiki 用 rich 打进度），推 `wiki.state` 事件；**保留最后 400 行**环形日志给失败时展开。
4. **同一项目单飞**：第二次点生成直接复用上一次的 Promise，不排队（同 `mcp-tools` 的 reload 互斥理由）。
5. 取消 = `taskkill /T /F /PID`（Windows）/ `process.kill(-pid)`（POSIX 进程组），且**保留半成品**——`--update` 能接着修。
6. 退出码 + 产物时间戳双判据：退出码 0 但 `metadata.json` 没更新，算失败（不能说「成功」）。
7. 生成前先做 probe（§5 D7），缺件就**不启动**，直接把「缺什么、怎么装」摆在面板上。

密钥桥接（最需要慎重的一处）：

| 方案 | 做法 | 评价 |
|---|---|---|
| 默认 | 不碰密钥，面板提示「先 `codewiki config set`」并给可复制命令 | **默认走这条**，零风险 |
| 复用 Colt 的 | 用户勾选 → 把当前 provider 映射成 CodeWiki 的 provider（`openai-compatible` / `anthropic`），把 key 写进 **OS 凭据库**（CodeWiki 用 keyring，`service=codewiki`、`account=api_key`） | 要显式同意，且提供「清除」 |
| 传给命令行 | `codewiki config set --api-key sk-...` | **不要**：argv 在进程列表里可见 |

推荐实现复用那条时**走一个小 Python shim**（`keyring.set_password("codewiki","api_key", key)`，key 从 stdin 读），而不是把 key 塞进 argv。代价是耦合 CodeWiki 的 keyring 常量名，升级时要复核。

### P4 · 可选（先不做，写进 NEXT-PHASE）

- 会话空闲 + HEAD 变化 → **提示**「wiki 落后了，要刷新吗」，**不自动跑**（花钱 + 改工作区，自动做等于替用户决定）。
- CI 生成：GitHub Action 跑 `codewiki generate`，Colt 纯只读。这是团队场景最干净的一条路——桌面端一颗密钥都不用碰。
- **远程 MCP**：CodeWiki 只提供 stdio（`codewiki mcp`），套一层 `mcp-proxy` 就能变成 Streamable HTTP，团队跑一台、所有人零 Python。目录里加一条 `url` 型条目即可，不用改客户端。
- 组件级跳转：面板里从「模块 → 组件 → `file:line`」直接打开文件，复用 `file.read`。

---

## 5. 关键决策

**D1 · 生成不放**主**会话。**
理由：12 页写作 × 每页回灌 + 12 张审批卡。**子代理代写**是可接受的过渡（上下文隔离在子 lane，主对话只收摘要），但它换不掉审批卡，也换不掉「路径由模型给」（见 D9）。代价：要彻底解决得多一个子进程与分发问题。

**D2 · 产物放 `docs/wiki/`，`temp/` 与 `.codewiki/` 忽略。**
`docs/wiki` 里除 `temp/` 外都该进版本库（3.2MB 里 99% 是依赖图）；MCP 模式会在项目根建 `.codewiki/sessions/<id>/`，**必须**进 `.gitignore`，否则会话状态混进提交。
另外 `docs/wiki/index.html` 不生成——Electron 里有面板了，再嵌一个浏览器只是第二套导航。

**D3 · 页面文件名用 ASCII，正文用中文。**
这是本次实测最直接的教训：中文 + 全角括号 + 空格让 `wc`、URL 编码、相对链接、面板路由全部要特判。`module_tree.json` 里的模块 id 用 `session-orchestration` 这类 slug，标题字段写中文，`--language zh` 只影响正文。

**D4 · 密钥默认不复制。** 见 §4 P3 的密钥桥接表。任何复制都要显式勾选 + 可清除 + 如实写进 `docs/SECURITY.md` 的密钥章节。

**D5 · 读文档不新造工具面。**
`read` / `grep` 已足够；MCP 那 10 个工具里也没有 `read_page`（原设计的 `wiki` 只读工具已砍，见 §2.5）。
生成**不**做成工具：否则模型可以在一次对话里自己启动 30 分钟、花钱、改工作区的任务。

**D6 · 注入有预算、有新鲜度。**
1.5k token 上限；无 wiki 不注入；过期要明说。不能让模型把三个月前的文档当现状。

**D7 · 版本钉死 + 四连自检。**
`python >= 3.12`、`git`、`codewiki == 2.0.0`、`mcp < 2`。任一项缺，面板给「缺什么 + 一条可执行命令」，不静默降级。
（`mcp>=2` 那条不是理论风险，是本次实测的崩溃点。）

**D8 · 不做第二个文件浏览器。**
面板只呈现「模块树 → 页面」。看源码仍然走「文件」页签与 `read`。否则就是 `AGENTS.md` §3.6 那类死控件：入口存在、职责重叠、用户不知道该点哪个。

**D9 · 写入路径不能由模型决定。**
`write_doc_file` 的目标路径是**模型参数**，而审批规则只有「整个工具 / 同参数」两种范围（`policy.ts` 的 `scope`），**没有路径范围**。于是只剩两个选择：
（a）逐页弹卡——可用但吵；
（b）对整个工具放行——**等于允许模型往工作区任意位置写 `.md`**，不接受。
所以「少弹卡」这件事不能靠 MCP 配置解决，只能靠**换写入通道的形态**（runner 把 `--output docs/wiki` 钉死在代码里）。这是 P3 存在的唯一硬理由，也是它不能被「MCP 就够了」替代的原因。

---

## 6. 风险表

| 风险 | 触发条件 | 影响 | 处理 |
|---|---|---|---|
| `mcp>=2` 起不来 | 用户自己 pip 装 | MCP 模式完全不可用，报错还指向 `AttributeError` | 钉版本 + probe 检查 |
| caw 拉不到 | 想用 claude-code / codex 订阅 | 装不上 | 产物里不提供这两个 provider |
| 无 Python 运行时 | 绝大多数用户 | 生成不可用 | P0/P1 不受影响（只读产物）；P1 用 uv 引导安装，失败给命令 |
| 「可选」变成隐形 | 只在设置页塞一行没人看见 | 装了等于没装 | 面板空态也给入口；安装后展示「已装 + 工具清单」，不靠用户自己找 |
| 写用户级配置的副作用 | 一键安装写 `~/.colt/mcp.json` | 影响**全部项目**（含不想要的仓库） | 安装前说明作用域；卸载时只删自己那条，不动别人的 entry |
| Mermaid 体积 | 面板首屏 | 启动变慢 | 动态 import，只在 wiki 页签 |
| 大仓页数爆炸 | 单仓 > 500 叶子 | 生成几小时 | `--max-depth` / `--focus` / `--exclude`；面板显示预估叶子数 |
| 文档脱离代码 | 长期不刷新 | 模型引用错误结论 | 页面脚注写 commit + 面板 staleness + 注入里标注过期 |
| 中文路径 | D3 未落实 | 链接、URL、CLI 全部特判 | 模块 id 用 slug |
| 生成被当「已成功」 | 退出码 0 但产物没更新 | 用户看着旧文档以为刷新了 | 双判据（退出码 + mtime/commit） |
| 成本不透明 | 用户不知道花了多少 | 信任受损 | 面板读 `metadata.json` 的 token/费用；超阈值前二次确认 |

---

## 7. 验收标准

功能：

1. 没有 `docs/wiki` 时，面板显示「未生成」并给出**一条可复制命令**，不显示空白页。
2. 有 `docs/wiki` 时，模块树可点、页面可读、Mermaid 能出图、页内链接能跳。
3. 模型问「这个项目怎么组织的」，第一反应是 `read docs/wiki/overview.md`（而不是直接 grep 源码）。
4. `metadata.commit_id ≠ HEAD` 时，面板与注入文案**都**说明落后了多少。

回归（照仓库既有口径）：`npm run typecheck && npm test`；`smoke` 的 `dock` 模式加一条页签断言（按 `data-dock-tab`，不用 `button[aria-pressed]`）；`tests/contract.test.ts` 会替你抓通道注册遗漏。

---

## 8. 附：本次试跑的复现路径

```bash
# 1) 装 CodeWiki（Python 3.12+，mcp 必须 <2）
pip install codewiki==2.0.0 "mcp<2"

# 2) 在目标仓库跑（会写 docs/wiki/）
cd /path/to/repo && codewiki generate --output docs/wiki --language zh

# 3) 只读整合不需要 LLM；要让会话模型代写则配 MCP：
#    .colt/mcp.json → { "mcpServers": { "codewiki": { "command": "codewiki", "args": ["mcp"] } } }
```

本次由于 `caw` 拉取失败，采用「先装其余依赖 + `pip install --no-deps -e .`」的绕过方式；影响面仅订阅模式。
