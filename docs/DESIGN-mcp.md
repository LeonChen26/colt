# MCP 设计

> **状态**：**已实施**（2026-09-19；当日晚些时候补齐了原型边界，见 §5；同日再补上
> resources / prompts 两个能力面，见决策 13，以及 `instructions` 注入，见决策 14；
> 收盘审计后又修了「等 MCP 回话的预算」「配置诊断通道」「掉线作声」「stdio 子进程的 cwd」
> 与「答不回来的查询当场失败」五条假信号 / 缺口，见决策 15–18；再给重载补上**并发互斥**，
> 见决策 19；产品评审后又做五件事——配置**两级**（用户级 + 项目级，项目级覆盖）、
> **让 agent 自己安装**、工具**展示名**去黑话、通知**按 kind 分流**、**调用超时按 server / 工具可配**，
> 见决策 20–24）。
> **落地落点**：
> - `shared/mcp-config.ts`——配置的**纯解析层**（不 import SDK）。抽出来是为了**两侧共用**：
>   worker 据它连 server，主进程据它**在会话没打开时**也能列出声明（设置页）。
>   配置**两级**：用户级 `~/.colt/mcp.json` + 项目级 `<cwd>/.colt/mcp.json`，项目级同名覆盖（决策 20）。
> - `shared/mcp-label.ts`——MCP 注册名 → 展示名 `MCP <server>: <tool>`（**纯字符串**，
>   渲染层也要 import，故不能带 node 依赖；决策 22）。
> - `worker/lib/system-prompt.ts`——把「怎么接 MCP」写进基础提示词，于是用户可以让 **agent
>   自己安装**（决策 21）。
> - `worker/lib/mcp-tools.ts`——连接、包装、runtime（`createMcpRuntime` / `reload` / `status` / `close`），
>   以及 `capabilityTools`（把 server **声明了的** resources / prompts 也包成内核工具，决策 13）。
> - `worker/lib/mcp-reload.ts`——MCP 与 harness / 系统提示词 / 设置页的**接线**（四件事一处）：
>   热重载写回（`reloadMcpIntoHarness`）、**后台补挂**（`armLateMcpAttach`，决策 25）、
>   `instructions` 注入与设置页命令（决策 14）。
> - `worker/entry.ts`——接线（`...mcp.tools` 进 tools 数组；两条 MCP 命令已收进上面那个文件）。
> - `main/session-manager.ts` + `main/ipc`——`mcp.status` / `mcp.reload` 两个 IPC
>   （配置诊断 `diagnostics` 由主进程自己解析后一并带出，见决策 16）。
> - `renderer/src/features/Settings.tsx`——`McpSettings`（设置页可见性，含诊断块）。
> 依赖 **v2 的官方 SDK**：`@modelcontextprotocol/client@2.0.0`（运行期唯一新增依赖）；
> `@modelcontextprotocol/server` / `node` / `server-legacy` 只被**测试夹具**用（见 §3 决策 12）。
> **验收**：单测 `tests/mcp-tools.test.ts`（**48 条**，全部是真实子进程 / 真实 HTTP / 真实 SSE 往返）。
> 夹具都与生产方同构（低层 `Server` 类 + 裸 JSON Schema）：
> `mcp-fixture-server.mjs`（stdio，3 工具）/ `mcp-paged-fixture-server.mjs`（stdio，分页）/
> `mcp-http-fixture-server.mjs`（Streamable HTTP，含 headers 回显）/
> `mcp-sse-fixture-server.mjs`（旧式 SSE，有状态那套）/ `mcp-crash-fixture-server.mjs`
> （stdio，可自杀——专门验「连上**之后**掉线」）/
> `mcp-capabilities-fixture-server.mjs`（stdio，**三面都声明**：tools + resources + prompts，
> 含文本/二进制资源、资源模板、带参与无参提示词，并**自报 `instructions`**——验「声明了才包成
> 工具」、能力面的真实往返，以及 server 用法说明确实被拼进提示词）/
> `mcp-cwd-fixture-server.mjs`（stdio，1 工具：回报**自己的工作目录**——钉「stdio server 的 cwd
> = 会话的项目根」，见决策 17）/ `mcp-slow-fixture-server.mjs`（stdio，1 个 `sleep` 工具：真睡
> 指定毫秒再回——把「配置的调用超时到底有没有传给 SDK」变成可观测的行为差分，见决策 24）。
> **未覆盖**（别当成验过了）：**真模型调用 MCP 工具**的端到端由冒烟
> `COLT_SMOKE_MODE=mcp-e2e` 覆盖并**实测通过**（2026-09-19，本地 Ollama qwen3:0.6b，
> 9/9：工具可见 → 弹审批卡 → 批准 → `echo:<nonce>` 真实往返回到模型）；另有
> `COLT_SMOKE_MODE=mcp-real` 用**真实第三方 server**（官方 filesystem / pi-lens）跑同一条链路。
> **热重载 + 设置页可见性**那条「渲染层 → 主进程 → worker → 绕回」的接线由**免费**冒烟
> `COLT_SMOKE_MODE=mcp-reload` 覆盖并**实测通过**（2026-09-19，**12/12**，不调模型、不计费）：
> 冷启动装载 → 热加 server（分页收全）→ 热删 server（工具清单与 harness **同时**对齐，
> 见 `lane-heal.ts`）→ `mcp.status` / `mcp.reload` 两个 IPC 的返回形状（含「没打开会话」的
> `live:false` + `status:idle` 退路、随响应带出的配置诊断）→ **「慢 server 不该被判成超时」**
> （一个不说话的 server 把连接耗到 15s，旧预算下会假报超时；见决策 15）。
> 仅剩 worker 被主进程**强杀**（dispose 超时 / 崩溃）时 MCP 子进程成孤儿的那一支，
> 正常 dispose 走 `runtime.close()`。
> **一句话**：`<cwd>/.colt/mcp.json` 里声明的 MCP server（stdio 或 HTTP/SSE），其工具被包成
> 普通内核工具（`mcp__<server>__<tool>` 命名）塞进 `AgentHarness.create({ tools })`——
> **安全模型零例外**（天然过 `before_tool` 审批闸门），不自建扩展宿主，
> 复用 Pi 生态的姿势是「用官方 SDK 直接接协议」，不是「装它的扩展包」。
> **配套**：动手前读 `docs/ARCHITECTURE.md` §四（为什么不用 pi 扩展宿主）、
> `docs/SECURITY.md`（免审批边界）、`AGENTS.md` §四（「参数传了 ≠ 行为发生」——
> 本功能的判据落在「工具真的进了 harness 的 tools 数组」）。

---

## 1. 依据

| 来源 | 约束 |
|---|---|
| `NEXT-PHASE.md` §3.2 能力补齐 ③ | 「MCP 工具调用天然过 `before_tool`；审批层抄 `pi-mcp-adapter` 的 `session-approvals.ts`」——实际更简单：不在任何豁免名单即天然过闸，一行审批代码都不用改 |
| `NEXT-PHASE.md` §3.2 扩展宿主否决三条 | ① UI 挂载点对不上 ② 扩展代码绕过审批闸门 ③ 验收手段失效——MCP server 是**外部进程**，工具调用走标准 `before_tool`，三条都不触碰 |
| `SECURITY.md` | MCP server 是**会话启动即执行的本地代码**，与技能同一条隐式信任通道：装了什么、坏在哪里必须如实告知（notice 按 security 类发，落 session_events 可回查） |
| `AGENTS.md` §四 | 判「接没接」要 grep 调用点、判据落在**行为**上；本功能的行为判据是「包装后的工具出现在 harness 工具数组且能真实往返」——单测用真实子进程 / 真实 HTTP 钉住 |

## 2. 现状（代码实测，不是推测）

| 事实 | 位置 |
|---|---|
| pi-ai 的 `validateToolArguments` 显式区分 typebox / 非 typebox schema（`TYPEBOX_KIND` 符号），对后者走纯 JSON Schema 的 coercion + 编译校验 | `@earendil-works/pi-ai`（测试里有一条专门钉这个契约：裸 JSON Schema 的 `add` 工具，字符串入参被 coerced 成 number 后调用成功） |
| 内核工具签名 `AgentHarnessTool`：`name/label/description/parameters/execute`；失败要 **throw**（内核转错误工具结果） | `worker/lib/host-bridge.ts` 同款约定 |
| 审批豁免名单（`READONLY_TOOLS` / 提问守卫 / 子代理免闸）里没有任何 `mcp__` 前缀 | `shared/readonly-tools.ts`、`worker/entry.ts` |
| 会话启动通知已承载「技能装载」告知，MCP 装载结果复用同一通道（`send({type:"notice", kind:"security"})`） | `worker/entry.ts` init |
| LLM API 工具名普遍 64 字符上限 | `mcpToolName` 截断到 64 并清洗非法字符 |
| 内核 `validateToolNames` 见到**重名会直接 `TypeError`**（在 `setTools` 与 `create` 两处都会跑） | `@earendil-works/pi-agent-core` `harness/config.js`——所以重名必须由我们**在包装层挡掉**，否则一个撞名配置能把整个会话启动搞崩 |
| 内核 `lane.readConfig().tools` 是**活取的**（harness 的 `configStore`），`lane.configuration.activeToolNames` 是 lane 自己持久化的 | `harness/runtime/harness.js` 构造 + `lane.js`——热重载要同时写这两处，见 §3 决策 7 |
| SDK 自带三种 client transport：`StdioClientTransport`（子路径 `client/stdio`）/ `StreamableHTTPClientTransport` / `SSEClientTransport`（后两者**从包根导出**，用 `requestInit.headers` 传自定义头） | `@modelcontextprotocol/client`（远程与 stdio 在包装层无差别） |
| SDK 无状态模式的 Streamable HTTP server **必须每个请求新建一套 transport + server** | 实测：共用一套会让第二个请求（`notifications/initialized`）回 500 |
| v2 的 `listTools()` **不传 cursor 时自己翻完所有页并聚合**（一次调用拿回 5 条、`nextCursor` 为 undefined）；只有**显式传 cursor** 才回单页。自动翻页的页数上限是 `ClientOptions.listMaxPages`（默认 64，触顶**抛错**、不缓存半份聚合），重复 cursor 会停止翻页 | `@modelcontextprotocol/client`（实测，见决策 6）。同款自动聚合对 `listPrompts` / `listResources` / `listResourceTemplates` 一视同仁 |
| SDK 的 `RequestOptions` 有 `signal` / `timeout`；`RequestOptions.timeout` 缺省用 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`。超时由 SDK 自己取消请求并抛 `SdkError code=REQUEST_TIMEOUT` | `@modelcontextprotocol/client`（实测：给 `connect` 传 `{ timeout: 1500 }`，1531ms 后以 `SdkError code=REQUEST_TIMEOUT / Request timed out` 拒绝）。所以 `callTool` **不是没有超时**，是走 SDK 默认 60s |
| `StdioServerParameters.cwd` 缺省「继承当前进程的 cwd」；而 worker 是 `utilityProcess.fork(workerPath, [], {…})` 起的、**没带 `cwd`**（`ForkOptions.cwd` 存在但没传） | 结论：worker 的 cwd = **应用进程**的 cwd（dev 下 = 仓库根）。实测：夹具 server 用**相对参数**时被解析成 `E:\code\tests\helpers\…`（从仓库根退两级）→ `Cannot find module`；显式传 `cwd` 后逐字等于项目目录（决策 17） |
| `Protocol.onclose` 是**公开可赋值**的钩子，由 `transport.close()` 触发（SDK 源码里 `transport.onclose` → `_onclose()` → `this.onclose?.()`）；HTTP 传输会 **re-fire** | 掉线检测这一支是通的（不必另接 `onerror`——SDK 明说那里的错误「不一定是致命的」）；「只报一次」要靠自己幂等（决策 11） |
| `client.getServerCapabilities()` 是公开方法，connect 之后就能读到 server 声明的 `tools` / `resources` / `prompts` 等能力面；`listResources` / `listPrompts` / `listResourceTemplates` 与 `listTools` 同款自动翻页；`readResource` / `getPrompt` 是单次请求 | `@modelcontextprotocol/client`（能力工具只在声明了对应面时才加，见决策 13） |
| `client.getInstructions()` 是 server 握手时自报 `InitializeResult.instructions` 的**取值口**，但 SDK **自己一处都不调用**它；另有一个 `ClientOptions.listChanged`（`{ tools / prompts / resources: { onChanged } }`），SDK 会自己刷新并把新值回调给你 | 前者不自己拼进提示词就是**静默丢掉**（与技能清单同坑，见决策 14）；后者我们**尚未接**（见 §5 边界） |

## 3. 决策

1. **传输**：stdio（本地子进程）+ 远程（Streamable HTTP，`transport: "sse"` 走旧式 SSE）。
   配置面用 `command` / `url` **二选一**表达，解析层不给 `command` 缺失的配置留活路
   （「缺少 command 或 url」是诊断，不是静默跳过）。三种传输在包装层无差别——都是
   「连上、列工具、逐个包装」，差异只在 `buildTransport` 一个分支。
2. **schema 透传**：MCP 的 `inputSchema` 是裸 JSON Schema，**原样**交给内核（强转 `TSchema`），
   不在中间加转换层。校验安全网在内核（pi-ai 的 coercion + 编译），不在包装层重复实现。
3. **命名**：`mcp__<server>__<tool>`，非法字符清洗成 `_`，64 字符截断。注册名 / 审批签名 /
   界面展示同源（`label` 给界面：`MCP <server>: <tool>`）。
4. **重名去重**：全量工具按**注册名**去重，保留先到的，后到的记进通知。
   这不是洁癖——内核 `validateToolNames` 见重名直接 `TypeError`，撞名配置会让整个
   `AgentHarness.create` 崩掉，那比「少一个工具」严重得多。冲突留给用户改配置。
5. **故障隔离**：单个 server 连不上（15s 连接 / 列工具超时，或 `${VAR}` 缺变量）只收诊断，
   **不拦会话启动**；该 server 在现状里显示为 `error` 并带原因。「已连接 N 个 server：…；
   MCP 告警 M 条：…」如实告知。会话启动不被一个挂死的 server 拖死。
   **失败不是终局**：`reload()` 会重试上一轮没连上的 server（配置没变也试）——
   否则「重新加载」对失败态就是个死按钮，直接推翻设置页那句「改完点「重新加载」即可生效」。
6. **分页**：**不用自己翻**——v2 的 `listTools()` 不传 cursor 时会自己翻完所有页并聚合，
   只有显式传 `cursor` 才回单页；而客户端侧也没法「主动要第一页」（省略 cursor 就等于
   「全给我」）。于是 v1 时代那段按 `nextCursor` 翻页的循环在 v2 下**只跑一轮就返回**，
   是一段死代码（`MAX_TOOL_PAGES` 根本没被读到，2026-09-19 已删，`listAllTools` 收敛成一次调用）。
   游标不收敛由 SDK 兜（重复 cursor 停止、触顶 `listMaxPages` 抛错、**不缓存半份聚合**），
   页数上限显式钉在 `Client` 的 `listMaxPages: 100` 上——写出来是为了不藏在 SDK 默认值（64）里。
   这个「一次调用就全给我」的契约由单测**直接钉 SDK**（同 `validateToolArguments` 那条）：
   哪天 SDK 改成不聚合，先红的是用例，而不是线上悄悄只剩第一页工具。
7. **热重载**：`createMcpRuntime` 持有各 server 的连接，`reload()` 重读配置——关掉
   **不再声明 / 配置变了 / 上一轮没连上**的（配置等价键键序无关，只调书写顺序不算变更），
   再连上**新声明的**与**上一轮没连上的**。后一类是刻意的：server 起晚了、网络刚恢复、
   进程崩了重启，这些都不改配置，但「重新加载」必须能把它们救回来。
   写回必须**两处都写**（`worker/lib/mcp-reload.ts`）：`harness.setTools`（换工具定义）
   **和** `lane.setActiveTools`（换清单）。只写前者，清单里的名字在 `toolsByName` 里查不到，
   生成会以 `configured_tools_unavailable` 直接失败；只写后者，模型看不到新工具。
   **删掉的工具必须连清单一起删**——否则下一次生成就炸。
   **`ServerState.config` 存「声明值」**（配置文件里那串，**没展开 `${VAR}`**），解析值只在
   造传输那一步活一次。存解析值会同时坏两件事：① 变更判定拿它跟文件里的**声明**比，凡是用
   `${VAR}` 的 server 就**永远**被判成「变了」→ 每次「重新加载」都白重连一次（推翻本决策
   第一句「已连好的不重连」）；② `status().target` 画的就是它（设置页渲染 `server.target`），
   `args: ["--token", "${TOKEN}"]` 会把**真实密钥**画在界面上。这两条由单测钉住，判据取
   「不重连」＝工具对象**引用同一性**不变（重连会重新 wrap，引用必变）。
8. **回收**：正常 dispose 走 `runtime.close()`（优雅：`stdin.end` → 等 → `SIGTERM`）；
   worker 被**强杀**时退到 `process.on("exit")` 的同步兜底。已知边界：强杀那一刻正在启动的
   子进程仍可能成孤儿（记在文件头注释，不当 bug 修）。
9. **设置页可见性**：配置是**项目级**的，所以这一段跟着当前项目走。`mcp.status` 带 `live`：
   true = 找该项目下任一活 worker 要**真实运行态**；false = 只有配置文件里的声明
   （status 一律 `idle`）。两者语义不同，界面分开说——混为一谈会让人以为「没连上」。
10. **不装 `pi-mcp-adapter`**：它的 ~29% 代码是 TUI 同意面板与宿主生命周期（`ctx.ui`），
    本仓没有那层 API（React + IPC 双进程），装进来逻辑能跑、画不出东西（死重）。
11. **掉线如实上报**：连上**之后** server 死掉，`status()` 立刻转 `error`（订阅 SDK 的
    `onclose`）——否则设置页会永远显示「已连接」而工具调用早已失败，**持续撒谎比没有信号更糟**。
    两个边界：① SDK 的 `onclose` 在**我们主动 `close()` 时同样触发**，所以先看 `closing`
    标记，别把 reload / dispose 自己的关闭误报成「断开」；② 刻意**不**接 `onerror`——
    SDK 明说那里的错误「不一定是致命的」，拿它翻状态会把健康 server 误标成红点。
    掉线**不自动重连**（那是另一套策略），靠「重新加载」救回（见决策 5 / 7）；
    工具仍留在清单里，调用会照常失败——由 SDK 报「未连接」，不去伪造一个成功结果。
    **2026-09-19 补（收盘审计发现）**：光翻状态等于**不作声**——掉线时工具仍留在清单里，
    用户唯一的线索是「某个调用莫名失败」，而设置页得他自己点开才看得到。现在 `onclose` 里
    同时发一条 security 类 notice（`MCP server "x" 连上后掉线：…；在设置页点「重新加载」可恢复。`），
    toast 之外**同时落 `session_events`**、能在「事件」页签回查（与装载摘要同一条通道）。
    两条附带约束：**只报一次**（SDK 自己注释 `HTTP transports re-fire onclose`，重复通知就是
    噪音——用「`state.error` 已置位」当幂等闸），以及**我们主动关的不报**（`closing` 标记，见 ①）。
    判据由真实自杀夹具 `mcp-crash-fixture-server.mjs` 钉住：通知**恰好一条**、点名那台 server、
    且「重新加载」把它救回来之后**不再冒第二条**。
12. **用 v2（`@modelcontextprotocol/*@2.0.0`）**：v2 把 v1 的单体包拆成 `client` / `server` /
    `core`（+ `node` / `express` / `hono` / `fastify` 中间件包）。迁移走官方 codemod
    （`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`，**在包根跑**，它连 `package.json` 一起改）。
    **关键更正（差点写错进决策）**：v2 **没有砍掉旧式 SSE**——`SSEClientTransport` 仍在，
    只是从 `client/sse.js` 子路径挪到了**包根导出**（`@modelcontextprotocol/client`）；
    服务端 `SSEServerTransport` 挪到 `@modelcontextprotocol/server-legacy/sse`（v1 SSE 的
    冻结副本，只为迁移）。所以 `transport: "sse"` 这条能力**原样保留**，SSE 用例在 v2 上仍绿。
    ⚠️ **教训**：只查 `@modelcontextprotocol/sdk` 的 `dist-tags` 会得出「没有 v2」的**错结论**
    （旧包 `latest` 永远是 1.30.0）——判「有没有新版」要按**包名**查，大版本换包名就该按新包名查。
    codemod 管不了、必须手工收的两条：① `ctx.http.req` 是 Web 标准 `Request`，其 `headers` 是
    **`Headers` 对象**，只能 `.get()`（方括号取键恒 `undefined`，会得到「headers 没透传」的**假阴性**）；
    ② 它把 `import` 提到文件顶部时会把版权头复制成两份。
13. **`resources` / `prompts` 也包成内核工具**（`capabilityTools`）：server 声明了 `resources` 就加
    `list_resources` / `read_resource`，声明了 `prompts` 就加 `list_prompts` / `get_prompt`
    （命名仍走 `mcp__<server>__*`，于是**天然过审批闸门**——与 tools 面同一套安全模型，零例外）。
    - **为什么不走内核的 `resources.promptTemplates` + `lane.promptFromTemplate`**：那条路存在且
      活着（`lane.js` 真有 `prompt_template` 分支），但它要求「模板正文在客户端、参数由**客户端**
      格式化」；而 MCP 的 prompt 是**服务端**按类型化参数渲染的（`prompts/get`）。硬套只会得到一个
      「参数根本传不进服务端」的假接口——正是 §四「参数传了 ≠ 行为发生」那一类。
    - **只加声明过的**：`getServerCapabilities()` 说了才算。没声明就一个都不加，不往模型面前放
      用不上的入口（§3.6「死控件比缺失更伤信任」）。
    - **二进制资源不展开**：`read_resource` 拿到 blob 只回「二进制 + MIME + base64 长度」——
      把 base64 塞进上下文既费 token 又读不了。
    - **提示词压成文本**：`get_prompt` 把各条消息拼成 `<role>: <内容>`（图片/资源块成文字标记）。
    - 超时走 SDK 默认 60s（同 `callTool`）：这些是**按需**发起的调用，不该占会话启动那条 15s 线。
    - **边界（未做）**：prompts 的**用户侧**入口（输入框 `/` 候选里按名选、填参数）没做——那要动
      渲染层 + IPC；现在模型能自己按名取，用户则要手工拼一次工具调用。

14. **server 自报的 `instructions` 拼进系统提示词**（`lib/mcp-reload.ts` 的 `composeMcpInstructions`，
    `entry.ts` 的 `transform_context` 链尾一行调用）。
    - `instructions` 是 server 握手时自报的「怎么用我」（如「调 A 之前先调 B」）。SDK 只给
      `client.getInstructions()` 这个取值口、**一处都不替你调**——应用不拼就是静默丢掉，而
      装载 / 告警 / 计数 / typecheck / 单测全绿。这与技能清单是**同一个坑**
      （`formatSkillsForSystemPrompt` 也从不被内核调用），见 `AGENTS.md` §四。
    - **每请求重拼**（挂在注入链尾），于是 `reload()` 换过 server 之后下一次请求立即可见；
      无 instructions 时**原样返回 base**、不产出多余空行（多一个换行都会让拼出的串每次都变、
      提示词缓存失效）。与 `renderTodoBlock` / `renderAgentCatalog` 同一条纪律。
    - ⚠️ **信任面**：这是 server 自报的文本进系统提示词，与工具描述同一条隐式信任通道（都用
      `security` 类 notice 如实告知），原样引用、不当本机指令。
    - **已知未覆盖**：`composeMcpInstructions` 在**最终产物**（拼出的串）上有单测，但 `entry.ts`
      里那**一行调用**没有结构断言——本仓库对这类注入器的惯例正是如此（`renderTodoBlock` /
      `renderAgentCatalog` 也一样：渲染函数验串 + 接线靠行为观察）。给 MCP instructions 做行为
      观察要模型「照 server 自报的话做」，前提在模型侧、易假红（§四「前提由外部决定时要么显式
      建立、要么明说没建立」），故不做，在此**如实记下**。

15. **「等 MCP 回话」的预算必须盖住 worker 侧的单步上限**（`main/session-manager.ts` 的
    `MCP_QUERY_TIMEOUT_MS`；时序钉在免费冒烟里）。
    - **症状**（收盘审计发现，2026-09-19）：预算原先是 `10_000`，抄自 `branches` /
      `subagentTranscript` 那两条**快**操作。而这条往返最慢的正当耗时有两段都远超它：
      ① 会话还没就绪时命令要等 `ready` 才下发（`#post` 暂存），上限是 `READY_TIMEOUT_MS`；
      ② 就绪后 `mcpReload` 要**重新连上**每台变更 / 上一轮失败的 server，每台
      ≤ `MCP_STEP_TIMEOUT_MS`（连接）+ 同样一步（列工具）。于是设置页会弹红字
      「查询 MCP 状态超时」，**而 worker 正在正常连接**——不是报错，是界面在说谎
      （与决策 11 同一条纪律的另一面：宁可不说话，也不说反话）。
      （多台**已经不叠加**了：连接自决策 25 起是并行的，总耗时回到「一台的最坏值」。）
    - **改法**：预算改为 `READY_TIMEOUT_MS + 2 * MCP_STEP_TIMEOUT_MS`（决策 25 之后抬到
      `4 *`，理由见本条末「残余」），且**单步值进
      `shared/limits.ts`**——它被两侧各读一次（worker 当 `connect` / `listTools` 的超时，
      主进程拿它算预算），正是 `limits.test.ts` 守的那一类「漂成两份就静默出错」的常量。
      改回一个拍脑袋的数、或在别处再写一份字面量，都会让那条守卫变红。
    - **物证**（免费冒烟 `mcp-reload` 第 ⑤ 组）：夹具里放一个**起来后一句话不说**的子进程，
      断言「这次重载真的等过了 10s 仍然正常兑现」。实测 **15035ms** 后直接返回该 server 的
      `error` 态（`连接失败：Request timed out`）。判据挂在「等过旧预算」上，所以把预算改回
      10s 这条**立刻红**——这正是它能证伪的地方。
    - **残余（如实记，2026-09-19 由决策 25 修订）**：多台**同时重连已不叠加**（并行），
      剩下的叠加只有一种、而且跨两轮：重载要**先等上一轮后台收尾落定**再跑
      （`reload()` 里的 `await tail`），收尾一段 + 本轮一段，各 ≤ 2 步——所以这条线是
      `4 * MCP_STEP_TIMEOUT_MS` 而不是 2 步（2 步盖不住：一台慢连成功 30s 在收尾里，
      另一台先超时失败、本轮再连一次，就要 45s）。超过这条线仍以超时收敛（那是「坏了」
      而不是「慢」，报错是对的）。这条线是兜底、不是 UX 目标：正常路径下 worker 一答完就
      兑现，用户不会真等这么久。

16. **配置诊断走 IPC，两条路都给**（`main/ipc` 的 `declaredMcpServers` 返回值 + 协议字段）。
    - **症状**（收盘审计发现，2026-09-19）：`declaredMcpServers` 只解构 `servers`，把
      `loadMcpConfig` 一并返回的 `diagnostics` **整包丢掉**。而坏声明（不是合法 JSON /
      缺 command 或 url / env 不是字符串字典）在 `servers` 里**没有对应条目**——于是设置页
      把「你写错了」渲染成「本项目未声明 MCP server」，恰好是反的；有活 worker 时那些诊断
      又只走了一条 `notice`（决策 5 / 9），设置页照样看不见。
    - **改法**：`diagnostics` **一律由主进程自己解析**（它本来就在读这份文件），活 worker 那条路
      只借它的 `servers`（真实运行态）。于是两条路都有诊断、口径一致；设置页在列表**上方**
      单独画一块，**不替换列表**（好 server 照常显示），空列表时那句话也跟着改口，不再说
      「未声明」。
    - **物证**：免费冒烟 `mcp-reload` 的 `other` 项目里故意放一条坏声明（`broken` 既没 command
      也没 url），断言响应带出 `server "broken" 缺少 command 或 url`，且**有活会话那条路字段
      同样存在**。跑的是真实 IPC，不是单测里的替身。

17. **stdio server 的工作目录 = 会话的项目根**（`lib/mcp-tools.ts` 的 `buildTransport(config, cwd)`）。
    - **症状**（收盘审计 ⑧，2026-09-19）：`buildTransport` 造 `StdioClientTransport` 时**不传 `cwd`**，
      按 SDK 的语义就是「继承当前进程的 cwd」——而 worker 是
      `utilityProcess.fork(workerPath, [], {…})` 起的、**没带 `cwd`**，于是它继承的是**应用进程**的
      cwd（dev 下是仓库根，打包后是应用目录），跟用户的项目毫无关系。而
      `args: ["."]` / `["src"]` / `["dist"]` 这类相对路径**恰恰是最主流的写法**（官方
      `server-filesystem` 的例子就写着 `.`），用户把 `.colt/mcp.json` 放在项目里、当然指望它
      相对项目根解析。症状还是**静默指错**或一句 `Cannot find module`，设置页只说「连接失败」。
    - **物证**（对照实验，都在免费路径上）：把夹具的 `args` 改成**相对夹具项目根**的路径后，
      修前 ① 组当场红、worker 打出 `Cannot find module 'E:\code\tests\helpers\…'`——正是从
      仓库根退两级的结果（`..\..\tests\…`）；修后 12/12 全绿。单测另有一条**逐字相等**的断言
      （`cwd === 项目目录`），把 `cwd` 摘掉该条立刻红（实得 `E:\code\opensource\colt`）。
    - 与另一条同源：`.colt/mcp.json` 的定位、harness 的工具 cwd、记忆的项目隔离，认的都是
      **会话的项目根**；stdio 子进程没有理由例外。

18. **「答不回来的 MCP 查询」必须当场失败，不许靠超时收敛**（`main/session-manager.ts` 的
    `PendingMcpQuery` + `#drainPendingMcp`）。
    - **症状**（收盘审计 ⑦，2026-09-19）：待决队列原先只有一个兑现口子（`settle`），worker 崩掉 /
      被回收 / init 失败时两条异步路径都只写 `pendingMcp.length = 0`——把等待方**丢掉**，指望
      「各自的超时会收敛」。这在预算 10s 时只是慢，抬到 `MCP_QUERY_TIMEOUT_MS`（分钟级，见决策 15）
      之后就变成设置页挂一条**假的**「重载中…」两三分钟。三个触发点：
      ① worker 异常退出；② 用户切走 / 空闲回收（`#disposeWorker`）；③ init 失败（`fatal`，
      此时 worker 收到 mcpStatus 只会回一条 `error`，而按 FIFO 配对那条 error 落不到等待方头上）。
    - **改法**：队列元素带**两条**收场口子（`settle` / `fail`），三处都改调 `#drainPendingMcp`
      （`splice(0)` 摘空 + 逐个 `fail`，各自掐掉自己的定时器）。于是那道分钟级超时退化成纯兜底
      （只对付「worker 活着但卡死」），正常与异常路径都**当场**有结论。
    - **已知未覆盖，如实记下**：这条**没有行为断言**（只有代码与类型）。要覆盖得造出「有活 worker
      且在飞着一份 MCP 查询时它死掉」的场面，而现有注入器 `scripts/crash-worker.cjs` 在 t=0 就
      `process.exit(0)`，那个窗口（几毫秒）落不进去。将来若要补，需要「延迟退出」的注入器
      （或将 `PendingMcpQuery` 的队列抽成可单测的纯模块）。

19. **重载必须互斥：并发调用复用同一次**（`lib/mcp-tools.ts` 的 `reloadInFlight` + `doReload`）。
    - **症状**（收盘审计 ⑤，2026-09-19）：worker 的命令入口是 `void handle(command)`、**不排队**
      （`entry.ts`），两条 `mcpReload` 能交错执行；而重载会跨 `await` 改共享的 `states`。两个
      重叠时，同一台「配置变了」的 server 会被连**两遍**：后写进 `states` 的那个赢，先那个
      `client` 只剩 `liveClients` 还引用着（连带一个子进程），要等 worker 退出才被收掉——
      工具清单与 status 上都**看不出来**，只有「起了几个进程」看得见。
    - **改法**：`reload` 不再直接干活，改成「有在飞的就**返回它**、否则起一次」，真身挪进
      `doReload`。选「复用」而不是「排队」：重载是幂等的「把现状对齐到配置」，第二次跑拿不到
      新信息，复用的结果对两个调用方都成立，还省掉一轮白连。
    - **可达性**：当前设置页在重载期间禁用按钮、从界面点不出来；但 IPC 面本身没设防（渲染层
      任何代码都能连调两次），所以把约束写进**结构**、不靠界面拦。
    - **判据**（无模型，`tests/mcp-tools.test.ts`）：夹具挂 `COLT_MCP_START_LOG`（每启一次追加
      一行），`Promise.all([reload(), reload()])` 后断言**只起了一个**进程——摘掉互斥即变 2。

20. **配置两级：用户级 + 项目级，项目级同名覆盖**（`shared/mcp-config.ts` 的 `loadMcpConfig(cwd, home?)`）。
    - **动机**（产品决定，2026-09-19）：MCP 原先**只有项目级**，常见的 server（filesystem、
      fetch 之类）得**每个项目抄一遍**——而技能 / 记忆早已是「用户目录 + 项目」两级，这个
      不对称很扎眼。对齐它。
    - **形态**：用户级 `~/.colt/mcp.json`（与 `.colt/memory.md` 同目录惯例）、项目级
      `<cwd>/.colt/mcp.json`；合并时**项目级同名覆盖用户级**（那是「这个项目换版本 / 关掉某台」
      的出口）。诊断**点名是哪个文件**，两层都报。
    - **`home` 省略则不读用户级**：单测据此保持**项目级**的确定性——结论只取决于自己造的夹具
      目录，不随开发者的 `~/.colt/mcp.json` 漂移。生产调用方（worker `entry.ts`、`main/ipc`）
      传 `mcpUserHome()`（`os.homedir()`，可被 `COLT_MCP_HOME` 覆盖——**冒烟专用**的测试缝，
      用来把「本机没有全局配置」这条前提显式固定，见 `isolateUserHome`）。
    - **判据**：`tests/mcp-tools.test.ts` 三条——合并 / 覆盖 / 不传 home 只读项目级；诊断带文件
      名；把 home 交给 runtime 时用户级 server **真的连上并出工具**。

21. **安装方式 = 让 agent 自己写配置**（`worker/lib/system-prompt.ts` 的「【接入 MCP】」两行）。
    - **产品决定**：**不做**应用内配置编辑器 / 「添加 server」表单。用户直接让 agent 装
      （「帮我接一个 X 的 MCP server」）——它本来就有 write / edit 工具。
    - **缺的不是能力、是知识**：把格式与两个位置写进基础系统提示词，并带上两条纪律——① 密钥
      一律 `${VAR}`、不写明文；② 写好后让用户在设置页点「重新加载」、并说明装上了什么。
    - **顺带正确**：写项目外的 `~/.colt/` 在审批里是 **dangerous**（`assessToolRisk` 的
      `isWithinRootReal` 判定「写入项目目录之外」），会**逐次弹卡**且不给「本会话始终允许」——
      正好是「装到全局」该有的确认强度。

22. **展示名：注册名 → `MCP <server>: <tool>`**（`shared/mcp-label.ts`）。
    - **症状**（产品评审，2026-09-19）：审批卡的 `summary` 走 `buildSummary` 的兜底，**逐字**
      画出注册名 `mcp__alpha__echo`；工具卡、「记住」按钮 tooltip、自动分析行同样。全是开发者黑话。
    - **改法**：纯字符串 helper（**不能带 node 依赖**——渲染层要直接 import），主进程
      （`policy.buildSummary`）与渲染层（`ApprovalCard` / `MessageList` / `Conversation`）共用；
      工具自身的 `label` 也改由它生成，于是**注册名 / label / 界面展示同源**（不再有第二套格式）。
    - **已知取舍**：展示名里的 server / 工具名取自注册名，而注册名把非 `[A-Za-z0-9_-]` 清洗成了
      `_`——`my server` 会显示成 `my_server`。为「同一工具不给两个说法」接受它（`mcp-label.ts` 有注）。

23. **通知按 `kind` 分流**（`features/Conversation/index.tsx`）。
    - **症状**（产品评审）：`session.notice` 的处理器**不看 `kind`**，一律塞进绿色的「压缩完成」
      提示条、**5 秒消失**——于是「MCP server 掉线了」这种安全事件被画成**绿色成功提示**、几秒
      蒸发。落库那份是对的（可在「事件」页签回查），**界面语义是反的**。
    - **改法**：提示状态带上 `kind`；`security` 用**警示色 + 停留 12s**（其余仍是绿色 5s）。两个
      数据属性分开：`data-conv-compact-notice`（成功 / 信息）与 `data-conv-security-notice`。

24. **调用超时按 server / 工具可配**（`shared/mcp-config.ts` 的 `timeout` / `toolTimeouts`）。
    - **症状**（§5 旧条目）：`callTool` / `readResource` / `getPrompt` / 列表类原先**都不传
      `timeout`**，走 SDK 默认的 60s，且 `resetTimeoutOnProgress` 默认 false——编译、下载、
      浏览器自动化这类**正当的长工具**会被就地掐断（`REQUEST_TIMEOUT`），界面也没有「它还在跑」。
    - **产品口径（用户拍板，2026-09-19）**：**按 server / 工具可配**——默认行为不变（仍 60s），
      用户对某台 server 或某个工具**按需放宽**，而不是把全局固定值调大（那只是把「60s 掐断」
      换成「N 分钟掐断」，长工具照样断）。
    - **改法**：server 级 `timeout`（毫秒）+ 工具级 `toolTimeouts`（`{ 工具名: 毫秒 }` 覆盖，
      键是 server 原始工具名；能力工具用 `read_resource` 这类）。解析收在 `callTimeoutOf`
      （纯函数，**工具级 > server 级 > undefined**，undefined 即交回 SDK 的 60s）；
      `connectServer` 用它算出每个工具调用要传的 `RequestOptions.timeout`（`callTool` /
      `readResource` / `getPrompt` / 列表类）。**连接与「列工具」仍走 15s 那条线**，与本配置无关。
    - **重载语义**：`timeout` / `toolTimeouts` 计入 `configKey`——改超时即「配置变了」，
      点「重新加载」会重连并重建工具（新值才进得了 `execute` 的闭包）；否则会是一次静默的
      空操作（改了半天、点了「重新加载」却不生效）。单测钉了这条。
    - **判据落在行为上**：`mcp-slow-fixture-server.mjs` 的 `sleep` 真睡 N 毫秒——server 级
      `timeout: 60` 下睡 400ms **必须被掐断**，而 `toolTimeouts: { sleep: 8000 }` 覆盖同一调用
      **必须跑完**；只解析配置、不真传给 SDK 就过不了这组差分。

25. **MCP 不出现在会话启动的关键路径上：并行连接 + 启动预算 + 后台补挂**
    （`MCP_STARTUP_BUDGET_MS` in `shared/limits.ts`；`worker/lib/mcp-tools.ts` 的
    `connectPass` / `doReload(budget)` / `onSettled`，`worker/lib/mcp-reload.ts` 的
    `armLateMcpAttach`）。
    - **症状**（2026-09-19 三功能横向审查 §S1）：`createMcpRuntime` 在
      `AgentHarness.create` **之前** `await`，而它内部对每台 server **串行**连接——
      每台最坏 `MCP_STEP_TIMEOUT_MS`（连接）+ 同值（列工具）= 30s，而主进程等 worker
      ready 只有 `READY_TIMEOUT_MS`（120s）。**4 台连不上就把会话拖成打不开**（用户级配置
      还是全局生效的），用户看到的却是「会话进程启动超时，请重试」——重试还是 120s，
      真实原因（某台 server 连不上）此刻根本没机会报出来。决策 15 已承认「多台会叠加」，
      但**叠加在冷启动这一支从来没被测过**。
    - **改法**（两件事缺一不可）：
      ① **并行**：连接与关闭都从逐台 `await` 改成 `Promise.all`，耗时从「N 台叠加」回到
      「一台的最坏值」；
      ② **预算**：首次装载最多等 `MCP_STARTUP_BUDGET_MS`（15s），超预算的**转后台**——
      会话照常 ready、照常可用，连上后通过 `onSettled` → `armLateMcpAttach` 复用
      `reloadMcpIntoHarness` 把工具补挂进 harness 与主 lane。
      只做 ① 不解决「一台挂死就占满 30s」，只做 ② 不解决「多台叠加」。
    - **为什么补挂必须是显式的**：`entry.ts` 里进 harness 的是 `...mcp.tools` 的**一次展开
      快照**，后台连上的 server 不会自己出现在里面。不做这一步，「会话能开」的代价是
      「工具要重开会话才有」，等于没修——这也是本次唯一新增的一行接线。
    - **预算值进 `shared/limits.ts`**（与决策 15 同一条纪律）：它与主进程的
      `READY_TIMEOUT_MS` 是一对——预算必须显著小于它，否则 worker 还在连、主进程已判超时，
      「不阻塞启动」就是假的、且报错又指错地方。这层关系由 `session-manager.ts` 启动时
      的一次 `console.warn` 兜住（只在被 `COLT_READY_TIMEOUT_MS` 改坏时出声）。
    - **热重载不适用预算**：那是用户显式点的按钮、等待期间按钮禁用，点按钮就是要等到结果。
      但重载**必须先等上一轮后台收尾落定**（`reload()` 里 `await tail`）——两轮同时改
      `states` 会把同一台连两遍，正是决策 19 那条互斥要防的事。
    - **关掉的会话不留残骸**：`close()` 置 `closed`，后台连接落定后由 `connectPass` 就地回收
      （不写回 `states`）。`close()` **不等**后台收尾——关会话不该被一台连不上的 server 拖住，
      这一支与启动路径同一条理由。
    - **判据落在行为上**：新夹具 `mcp-boot-delay-fixture-server.mjs`（接 stdio 前先睡
      `COLT_MCP_BOOT_MS`）把「并行 / 转后台」变成可观测的：① 一台睡 700ms + 预算 80ms →
      装载立刻返回且工具为空、通知里有「转后台继续连接」，`onSettled` 之后工具补挂进
      （假）harness；② 三台各睡 1200ms → 断言**三个进程同时起来**（启动日志里的时间戳
      错开 < 600ms＝一台耗时的一半；串行会逐台错开至少一整台耗时。阈值不贴墙钟也不贴
      spawn 抖动，只跟「一台的耗时」比）；③ `close()` 之后 900ms，后台那台**不**出现在
      `status()` 里。
    - **这一支自己带来的三个边界（2026-09-20 复核后补，各有一条用例）**：
      ① **没欠后台就不许补挂**——`entry.ts` 那侧的 `armLateMcpAttach` 是无条件调的，闸门
      只能落在 `onSettled`（判据 `hasLatePass`）：一切正常时也回调，就等于**每次启动**多跑
      一次 `reload()`，而重载末尾 `notify(summary)` → 会话开头两条一模一样的「已连接 N 个
      MCP server」（`security` 类还同时落进「事件」页签）。物证：改前实测两次、改后一次。
      ② **诊断改在 `connectPass` 里就地记**——超预算那一支拿不到逐台返回值（race 先落在
      定时器上），靠收集返回值出诊断会把「预算内已经快速失败」的那台整个丢掉：它已在
      `states` 里，因而既不进「转后台」名单、也不进后台收尾通知，启动摘要从此少一条真告警
      （串行时代它一定在）。③ **`doReload` 开头挡 `closed`**——补挂走的就是 `reload()`，
      而 `close()` 把 `states` 清了、`connectPass` 的 `closed` 分支只回收**连上的那台**，
      不挡这里就会替一个已关掉的会话照着配置**重新 spawn** 子进程（摘掉守卫新用例立刻红，
      判据是夹具的启动日志计数不涨）。
    - **一处随之抬高的线**：`MCP_QUERY_TIMEOUT_MS` 从 `2 *` 到 `4 * MCP_STEP_TIMEOUT_MS`
      （见决策 15「残余」——注释写了要盖两段叠加、常数却只留一段，是这次复核抓出来的）。
      **判据不用墙钟**：并行那组最初拿「预算内是否全连上」当尺子，而进程启动开销在慢机器上
      会漂到几百毫秒——实测就假红过一次。改成「是不是同时 spawn」之后与机器快慢无关。
      平台时序另有坑：stdio server 的 cwd 就是夹具目录（决策 17），Windows 上刚被 kill 的
      进程会短暂占住它，`rm` 立刻上去就是 `EBUSY`——故新增的清理走 `removeDir`（带重试）。

## 4. 配置形态

**两级**，与技能 / 记忆同一条「用户目录 + 项目」的心智（决策 20）：

- 用户级 `~/.colt/mcp.json`——对**全部项目**生效（常见 server 只配一次）；
- 项目级 `<cwd>/.colt/mcp.json`——随项目走、**同名覆盖**用户级（与 `.colt/memory.md` 同一目录惯例）。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "FOO": "bar" },
      "timeout": 300000,
      "toolTimeouts": { "read_file": 600000 }
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" },
      "transport": "http"
    }
  }
}
```

- `command`（+ `args` / `env`）与 `url`（+ `headers` / `transport`）**二选一**；
  `transport` 缺省 `http`（Streamable HTTP），`"sse"` 走旧式 SSE。
- `timeout`（毫秒）覆盖默认的 60s **调用**上限（连接 / 列工具不受它影响）；单个工具再用
  `toolTimeouts: { "工具名": 毫秒 }` 单独放（决策 24）。
- 所有字符串值支持 `${VAR}` 展开成进程环境变量。**缺变量不静默留空**——留空会把
  `https://${HOST}/mcp` 变成看似合法却指向错处的 URL，这里成诊断并跳过该 server。
  只支持 `${NAME}` 这一种写法，不做 shell 式的 `$NAME` / 默认值语法。
- 文件不存在 → 安静跳过（没配就是没配）；JSON 解析失败 / 单个 server 声明不合法 → 诊断进通知，
  可用 server 照常装载。**诊断点名是哪个文件**（`.colt/mcp.json：…` / `~/.colt/mcp.json：…`），
  两层都报。
- 改完在**设置页点「重新加载」**即可生效，会话不必重启（§3 决策 7）。
- **不想手写**：直接让 agent 装（决策 21）。

## 5. 边界（有意不做的）

- **只接 tools 能力**——**已改判**（2026-09-19）：原型阶段认为 resources / prompts「没有
  『包成内核工具』这条自然落点」，实践下来 resources 的「列出 / 读取」本来就是读操作，
  包成工具**有**自然落点；prompts 也顺带包了（参数交给服务端渲染，见决策 13）。
- **不做应用内配置编辑器 / 「添加 server」表单**：产品决定让 **agent 安装**（决策 21）——设置页
  保持「只读展示 + 重新加载」，不引入写配置的表单。理由是写用户项目文件属于「应用主动动用户
  磁盘」，边界要想清楚才做；而 agent 写文件本来就过审批闸门（项目外更是 dangerous）。
- **prompts 没有用户侧入口**：模型能按名取（`get_prompt`），但输入框 `/` 候选里按名选、
  填参数那套没做——那要动渲染层 + IPC，等真需求（决策 13 末条）。
- **`list_changed` 通知未接**：v2 有 `ClientOptions.listChanged`（`{ tools / prompts /
  resources: { onChanged } }`，SDK 会自己重新拉取并把新值回调给你），我们**没挂**。后果：
  server **中途**增删工具 / 资源时，要等用户点「重新加载」，或下次连上才变。
  不是不能做（写回那套 `reloadMcpIntoHarness` 现成），但要把新清单在**会话中途**写回
  harness 与所有 lane，而 server 频繁发通知会在**生成途中**扰动工具面（正是
  `configured_tools_unavailable` 那类事故的现场）——得先想清「什么时候才允许应用」。
- **远程鉴权只支持静态头**：没接 `authProvider`（OAuth 流程需要回调页与凭据存储，
  与 `secrets` 那套的关系要先想清楚）。
- **不做 server 的启停开关**：注释掉配置项即等效（`reload` 会关掉它）。
- **不做工具白名单 / 逐工具审批粒度**：MCP 工具一律走「未知工具 → 按需确认」；
  要给某个 server 免审批，应走审批规则那套，而不是在 MCP 层开口子。
- **强杀孤儿**：worker 被强杀那一刻正在启动的 MCP 子进程可能成为孤儿（§3 决策 8）。
- **旧式 SSE 是 v2 的 legacy 面（退场提醒）**：`transport: "sse"` 现在仍照常支持（能力没变，
  见决策 12），但 v2 已把这条列为 legacy——服务端 `SSEServerTransport` 在 v2 里**只存在于**
  `@modelcontextprotocol/server-legacy`（v1 冻结副本，官方明说不再有新特性），规范
  2026-07-28 版给了**一年**退场期。**触发条件**：哪天要甩掉 `server-legacy` 这个依赖，
  就得先决定 `transport: "sse"` 是否随之下线——那是**产品决定**（判据是「还有没有人在用
  SSE server」），不是技术决定。⚠️ 别在没做过这个决定前就把 `server-legacy` 删掉：
  SSE 夹具与那条用例会一起消失，等于**把「这一支还能不能用」的证据也删了**，
  而客户端 `SSEClientTransport` 是**包根导出**、删依赖并不会让它消失——于是变成
  「代码里留着一条没人验过的 SSE 分支」。

- **后台连接期间设置页看不到「连接中」**（决策 25 引入的新边界）：超预算转后台的那台在
  `status()` 里**没有条目**，要等它落定才出现——`McpServerView.status` 只有
  `connected` / `error` 两态。这一段由那条「已转后台继续连接（会话照常可用）」的 notice 顶上。
  不新增 `connecting` 态是刻意的：那要动协议与渲染层，而「少了几台 + 一句说明」已经能解释；
  真出现「用户反复盯着等」再加。

- **设置页那块诊断只讲「配置写没写对」**：它是 `loadMcpConfig` 的**解析级**结论（JSON 合法性、
  必填字段、字段类型），**不预检**「这台 server 起得来吗」——那是运行态的结论（`status` / `error`，
  决策 5 / 11）。两条信息在界面上是分开的（诊断块 vs 每台 server 的卡片），别把诊断块当校验器。

- **工具调用的超时口径**（**已改判** 2026-09-19）：原先 `callTool` / `readResource` / `getPrompt` /
  列表类一律走 SDK 默认的 60s（`DEFAULT_REQUEST_TIMEOUT_MSEC`）且不续期，编译 / 下载这类正当
  长工具被就地掐断。产品口径定为**按 server / 工具可配**（决策 24）：默认仍是 60s，用户在配置里
  给某台 server（`timeout`）或某个工具（`toolTimeouts`）按需放宽。**仍不做**「有 progress 就续期」
  ——那要 server 主动发 progress 才生效，还得配 `maxTotalTimeout` 兜总时长（否则狂发 progress
  的 server 能把一次调用挂死），等真需求再上。

已从边界转正的（原型阶段曾列在「有意不做」，现已实现且有单测）：远程 server（HTTP/SSE）、
`listTools` 分页、`${VAR}` 插值、配置热重载、工具重名去重、设置页可见性、
**`resources` / `prompts` 两个能力面**（决策 13）。
