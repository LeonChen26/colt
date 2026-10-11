# Colt Agent 方向架构评审（对照业界主流 agent）

> 仅依据 `src/worker/`、`src/shared/` 与内核 `pi-agent-core` dist 源码 + 公开资料。
> 对照对象：Claude Code、Codex CLI、OpenCode、Gemini CLI（业界事实均标注来源）。
> 分析时间：2026-10-11。

---

## 一、Colt 的 Agent 核心回路

Colt 不自己写 agent loop，而是站在内核 `pi-agent-core` 的 **Harness / Lane / Hooks** 三层抽象上：

```
                    ┌─────────── AgentHarness（进程内可多 lane）───────────┐
                    │                                                      │
 用户输入            │   ┌──────────┐   ┌──────────┐   ┌──────────────┐    │
 prompt/steer ─────►│   │ main lane│   │ tidy lane│   │ sub:xxx lanes│    │
 /skill             │   │ (主对话)  │   │(记忆整理) │   │ (子代理 ≤3)  │    │
                    │   └────┬─────┘   └────┬─────┘   └──────┬───────┘    │
                    │        └──────────────┴────────────────┘            │
                    │            共享 hooks（每请求/每工具调用触发）：       │
                    │  before_tool      审批闸门（阻塞等主进程）+ 抓基线    │
                    │  transform_context×2 每请求重拼提示词 / 临时提醒注入  │
                    │  after_tool      ×3 纵深告警 / 写后诊断 / 改动记账    │
                    └──────────────────────┬───────────────────────────────┘
                                           │ JsonlSessionRepo（append-only，
                                           │ seq 严格递增，分支树可导航）
                                           ▼
                              ~/.colt 数据 + 项目目录
```

工具面（模型可见）：内核四件套 `read / write / edit / bash` + 自建 `grep`、`glob`（检索，2026-10-11 补）、`browser_read/act/screenshot`、`computer_screenshot/action`、`memory_search`、`todo`、`ask_user`、`subagent` + MCP 挂接的全部工具。

**这套基底与业界同构**：Claude Code、Codex、OpenCode、Gemini CLI 的核心都是「while 循环：组装上下文 → 模型选动作 → 过闸执行工具 → 追加历史」。[arXiv:2608.01326](https://arxiv.org/html/2608.01326v1 "citation"), [arXiv:2604.14228](https://arxiv.org/html/2604.14228v1 "citation") Colt 的差异化全部长在 hooks 与 lane 这两个扩展点上，这是对的选择。

---

## 二、逐项对照业界主流

### 2.1 上下文管理（compaction）——**跟上了一半**

业界现状：
- Codex：按模型设 token 阈值，触及即在窗口内自动摘要替换历史，并显式警告「多次压缩会降低准确度」。[arXiv:2608.01326](https://arxiv.org/html/2608.01326v1 "citation")
- Claude Code：**五层渐进式**压缩管线，先用便宜手段（大工具输出内联压缩）再动 LLM 摘要。[arXiv:2608.01326](https://arxiv.org/html/2608.01326v1 "citation")
- OpenCode：**两级**——先 prune 旧工具输出（最温和，不动消息图），再 LLM 摘要；摘要模板是交接导向（Objective / Next Move / 相关文件）。[OpenCode 文档](https://opencode.ai/v2/docs/compaction/ "citation"), [0xtresser](https://0xtresser.github.io/Claude-Code-VS-OpenCode/en/Chapter_05_Session_and_Context/5.3_Context_Compaction.html "citation")

Colt 现状（`worker/entry.ts` + 内核 dist）：
- 手动 `/compact` 链路完整（双失败路径、压缩后记忆沉淀提醒——这个提醒是**业界少见的好设计**）。
- 自动压缩：Colt **从未给 harness 传 `compaction` 设置**，吃的是内核默认值 `enabled: true, reserveTokens: 16384, keepRecentTokens: 20000`（`harness.js:43`）。也就是说自动压缩**其实开着**，但应用层没有任何感知与呈现——压缩触发时界面只能靠 `runningOperation: "compaction"` 推断，阈值、保留量都不可调。
- **没有工具输出 prune**：bash 大输出靠内核 capture 截断 + 落盘（好），但历史里的旧工具结果会一直占着上下文直到整体摘要。这是与 OpenCode/Claude Code 最直观的一档差距。

**判断**：单点 LLM 摘要 + 内核默认值，功能上及格；缺「先剪枝再摘要」的渐进策略与设置面。

### 2.2 子代理（subagent）——**隔离设计领先，编排能力落后**

Colt（`lib/subagent.ts` + `agent-defs.ts`）：
- 同进程多 lane：**fresh fork**（不继承主对话历史，连 `context` 参数都不暴露——刻意逼委托方显式交接）、深度=1（递归硬禁）、并发≤3、每代理工具白名单（frontmatter `tools:` 必填）、墙钟到点**先交接再中止**、审批闸门共享（子代理的写照样弹卡）。
- 声明式定义：`.agents/agents/*.md`，frontmatter 极简（description + tools）。

业界（Claude Code 子代理 frontmatter）：`model`（每代理可选不同模型）、`permissionMode`、`maxTurns`（到限标 partial、**可 resume 续跑**）、`skills` 预载、`mcpServers` 按需、`hooks`、`memory` 持久作用域、`background` 后台运行。[Claude Code 文档](https://code.claude.com/docs/en/sub-agents "citation") Claude Code 另有 Haiku 驱动的 **Explore 子代理**专职仓内检索，替主会话省上下文。[Claude Code Timeline](https://lukaszpodgorski.pl/claude-code/timeline/ "citation")

**差距**：
1. **子代理不能换模型**——全部用主会话同一模型同一价格档。业界把「探索/粗活用便宜模型」当成标准省钱手段（Codex 风险评估用专门模型，OpenCode 支持模型路由）。[arXiv:2608.10934](https://arxiv.org/pdf/2608.10934 "citation")
2. **崩溃即弃**：worker 恢复时刻意中止子代理运行（entry.ts 注释：没有接收方，resume 只会空烧）。合理，但意味着**没有 partial + resume**——长跑子代理一次崩溃就全丢。
3. 无后台化：子代理与主 lane 同生共死，主会话中断即全收。Claude Code 2025-11 起支持 `&` 后台任务，会话不再绑在终端上。[Claude Code Timeline](https://lukaszpodgorski.pl/claude-code/timeline/ "citation")

### 2.3 技能（Skills）——**与业界对齐度最高的一项**

Colt 走开放标准 agentskills.io，三层目录（项目 > 用户 > 内置）同名遮蔽如实上报、`/skill` 显式调用不回落、禁用并集、热重扫当轮生效。这与 Claude Code 2025-10 引入的 Skills 机制同构（SKILL.md + 触发描述 + 按需装载正文）。[arXiv:2606.00097](https://arxiv.org/html/2606.00097v1 "citation"), [Claude Code Timeline](https://lukaszpodgorski.pl/claude-code/timeline/ "citation")

**差距**：Claude Code 的四种扩展机制按**上下文成本**分层——hooks 零成本、skills 低成本（仅描述）、MCP 高成本（工具 schema）、plugins 做分发打包。[arXiv:2604.14228](https://arxiv.org/html/2604.14228v1 "citation") Colt 缺两头：
1. **用户自定义 hooks**：Colt 的 hooks 全是应用内建的，用户/项目无法在生命周期点上挂自己的脚本（如「每次写完跑 prettier」）。目前唯一的写后自动化是内置的诊断检查器表，不可扩展。
2. **打包分发（plugin/marketplace）**：技能只能手写文件落盘，没有「一个包装载 技能+子代理+MCP」的概念。

### 2.4 记忆（Memory）——**完整度高于多数同行**

双级文件（项目 `.colt/memory.md` / 用户 `~/.colt/memory.md`）+ 每请求重读注入（有界截断）+ 派生检索索引（memory.db，冷层归档）+ `/memory-tidy` 独立 lane 整理 + 压缩后沉淀提醒。对照：Claude Code 的 auto memory 是 MEMORY.md + 主题文件、模型自写、逐会话重注入；Codex 是后台两阶段 git-baselined 记忆。[arXiv:2607.20709](https://arxiv.org/pdf/2607.20709 "citation"), [arXiv:2609.00006](https://arxiv.org/html/2609.00006v1 "citation") Colt 这套在开源桌面 agent 里属于**上游水平**，主动整理 lane 是差异化亮点。

### 2.5 权限与审批——**链路完整，缺沙箱这一层**

Colt：三模式（approval/auto/full-access）+ 只读白名单 policy + **LLM 分析器**复核 moderate（fail-closed + 审计落库 + 用量记账）。业界：Claude Code 七种权限模式 + **ML 分类器** + Bash 沙箱（Linux/macOS 2.0.24 起）；Codex 用平台级沙箱做执行隔离。[arXiv:2604.14228](https://arxiv.org/html/2604.14228v1 "citation"), [arXiv:2608.10934](https://arxiv.org/pdf/2608.10934 "citation"), [Claude Code Timeline](https://lukaszpodgorski.pl/claude-code/timeline/ "citation")

**差距**：
1. **没有执行沙箱**——policy.ts 文件头自述「这是一层提醒而非沙箱，无法对抗刻意构造的绕过」。业界已把「默认沙箱 + 按需提权」当成基线。叠加前一份评审的 🔴1（bash 继承 worker 全部 env，含明文密钥），这条是 Colt agent 面最薄的一层。
2. **没有 plan 模式**（只读探索→出计划→用户拍板→再执行）。Claude Code 的 `plan` permissionMode 是重度功能；Colt 只能靠审批模式手动近似。

### 2.6 工具面——**缺检索三件套，靠 bash 硬扛**

业界工具集普遍 18~20+，且把检索做成一等公民：Codex/OpenCode 都有关键字/正则检索工具；Claude Code 有 Grep/Glob/WebFetch/WebSearch。[arXiv:2608.10934](https://arxiv.org/pdf/2608.10934 "citation") Colt 的文件操作只有 read/write/edit，**没有 grep / glob / list 工具**——模型要找东西只能 `bash: grep -rn ...`。后果链：检索全走 bash → 全都过审批闸门（bash 不在只读白名单的多数分支）→ 探索阶段审批弹卡密度显著高于同行。`memory_search` 证明这条通道（结构化检索工具）在工程上现成。

### 2.7 会话存储与回溯——**业界第一梯队**

append-only JSONL + 分支树 + 任意节点导航（`navigateTree`），正是「Session-Tree Version Control」范式（Pi / OpenHands 同款）。[arXiv:2609.00006](https://arxiv.org/html/2609.00006v1 "citation") Claude Code 到 2.0 才有 `/rewind`。[Claude Code Timeline](https://lukaszpodgorski.pl/claude-code/timeline/ "citation") Colt 的分支树是**原生能力**而非补丁，这是基底红利。

### 2.8 插话与协作控制

内核提供 steer / followUp / queue 三种排队模式 + 中断 + 逐子代理中止；Colt 全部接出（运行中发消息=steer）。另有 `ask_user` 独立通道（与审批分离、默认值是「没答案」）——对应 Claude Code 的 AskUserQuestion，语义分层正确。

### 2.9 写后诊断——**Colt 独有的小亮点**

`after_tool` 里对 write/edit 跑检查器（fast 同步追加进当次工具结果，slow 防抖后注入下一请求），免审批窄通道 + 全局开关。业界对照物是「外层验证环」（OpenHands 的 /goal judge、critics）。[arXiv:2609.00006](https://arxiv.org/html/2609.00006v1 "citation") Colt 这个是确定性的轻量版，方向正确；但检查器表写死在代码里，项目无法自定义（与 2.3 缺用户 hooks 是同一个洞的两个面）。

---

## 三、Agent 方向的不合理设计（按优先级）

| # | 严重度 | 问题 | 依据 |
|---|---|---|---|
| A1 | 🔴 | **无执行沙箱**：审批只是「提醒层」，bash 全能力裸奔；叠加 bash 继承 worker 全量 env（含明文密钥，见前一份评审 🔴1） | `approval/policy.ts` 文件头；内核 `bash.js:33` inheritEnv |
| A2 | 🟠 | **自动压缩吃内核默认值、应用零感知**：阈值/保留量不可调不可见，界面只在 `runningOperation` 里被动显示；也没有工具输出 prune 这层廉价前置 | 内核 `harness.js:43` 默认值；`entry.ts` 未传 compaction 设置 |
| ~~A3~~ | ✅ | ~~**无检索工具**：grep/glob 全靠 bash，探索期审批弹卡密度高、输出噪声大~~ **已闭环 2026-10-11** | `worker/lib/search-tools.ts`（纯 fs、免审批、边界自守、输出封顶） |
| ~~A4~~ | ✅ | ~~**子代理不能换模型**：探索类粗活与主任务同价；业界已把模型路由当标配~~ **已闭环 2026-10-11** | `agent-defs.ts` 的 `model:` + `subagent.ts` 的 setModel + `providerKey` 宿主能力 |
| A5 | 🟠 | **无用户自定义 hooks / 无 plan 模式**：扩展机制只有 skills+agents+MCP 三条腿，缺零上下文成本的 hooks 与只读规划态 | 对照 Claude Code 四机制分层模型 |
| A6 | 🟡 | **子代理无 partial/resume、无后台化**：崩溃即弃、随主会话同灭 | `entry.ts` 恢复段刻意 abort 子 lane |
| ~~A7~~ | ✅ | ~~**审批分析器与被审模型同源**：自我复核无纵深，业界用独立/专门模型做风险判定~~ **已闭环 2026-10-11** | `approval/analyzer-model.ts` + 设置项 `approval.analyzerModelRef` |
| A8 | 🟡 | **MCP 工具 schema 全量常驻上下文**：无按需加载（Claude Code 2.1.7 起 MCP 工具描述超窗口 10% 自动延迟、用时再搜） | `entry.ts` 注册 `...mcp.tools` 全量 |

> **A3 / A4 / A7 的落地细节**见 `docs/impl-plan-three-gaps-2026-10.md`（施工图）与其交付记录。
> A1 的**密钥那一半**（bash 继承 worker 全量 env 含明文密钥）已随同一轮闭环，
> 见 `docs/architecture-review-2026-10.md` 🔴1；A1 剩下的「无沙箱」本体仍未解决。

## 四、值得保留的差异化优势

1. **审批链路的双时钟 + 双 epoch**（中断/换模式丢弃在飞分析）+ 审计与费用**无条件落库**——多数 agent 的自动审批是黑盒。
2. **ask_user 与审批的语义分离**（默认值一个是「没答案」一个是「放行」）——避免全权模式下模型收到假答案，这类坑在业界真实存在。
3. **子代理交接优先于中止**（到点先让模型收笔交接）+ 费用归属透明（子代理消耗计入会话、单独展示）。
4. **压缩后记忆沉淀提醒**——把「摘要保 prose 不保事实」这个数据丢失时刻变成沉淀契机。
5. **分支树原生可导航** + 净变化基线（baseline → 当前）回答「最终改成了什么」而非一串增量。
6. **写后诊断**（确定性检查当轮回流给模型）——轻量外层验证环，多数桌面 agent 没有。

---

### 一句话结论

Colt 的 agent 基底（lane/hooks/分支树）与业界第一梯队同构甚至局部领先（隔离语义、回溯、审计），真正的缺口集中在三处：**执行沙箱缺失**（安全地基）、**检索工具缺失**（日常体验）、**模型路由缺失**（成本结构）。三者都与内核无关，是应用层可以自己补的。
