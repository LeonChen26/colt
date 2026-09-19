# MCP 设计

> **状态**：**已实施**（2026-09-19；当日晚些时候补齐了原型边界，见 §5；同日再补上
> resources / prompts 两个能力面，见决策 13，以及 `instructions` 注入，见决策 14；
> 收盘审计后又修了「等 MCP 回话的预算」与「配置诊断通道」两条假信号，见决策 15 / 16）。
> **落地落点**：
> - `shared/mcp-config.ts`——配置的**纯解析层**（不 import SDK）。抽出来是为了**两侧共用**：
>   worker 据它连 server，主进程据它**在会话没打开时**也能列出声明（设置页）。
> - `worker/lib/mcp-tools.ts`——连接、包装、runtime（`createMcpRuntime` / `reload` / `status` / `close`），
>   以及 `capabilityTools`（把 server **声明了的** resources / prompts 也包成内核工具，决策 13）。
> - `worker/lib/mcp-reload.ts`——MCP 与 harness / 系统提示词 / 设置页的**接线**（三件事一处）：
>   热重载写回（`reloadMcpIntoHarness`）、`instructions` 注入与设置页命令（决策 14）。
> - `worker/entry.ts`——接线（`...mcp.tools` 进 tools 数组；两条 MCP 命令已收进上面那个文件）。
> - `main/session-manager.ts` + `main/ipc`——`mcp.status` / `mcp.reload` 两个 IPC
>   （配置诊断 `diagnostics` 由主进程自己解析后一并带出，见决策 16）。
> - `renderer/src/features/Settings.tsx`——`McpSettings`（设置页可见性，含诊断块）。
> 依赖 **v2 的官方 SDK**：`@modelcontextprotocol/client@2.0.0`（运行期唯一新增依赖）；
> `@modelcontextprotocol/server` / `node` / `server-legacy` 只被**测试夹具**用（见 §3 决策 12）。
> **验收**：单测 `tests/mcp-tools.test.ts`（**31 条**，全部是真实子进程 / 真实 HTTP / 真实 SSE 往返）。
> 夹具都与生产方同构（低层 `Server` 类 + 裸 JSON Schema）：
> `mcp-fixture-server.mjs`（stdio，3 工具）/ `mcp-paged-fixture-server.mjs`（stdio，分页）/
> `mcp-http-fixture-server.mjs`（Streamable HTTP，含 headers 回显）/
> `mcp-sse-fixture-server.mjs`（旧式 SSE，有状态那套）/ `mcp-crash-fixture-server.mjs`
> （stdio，可自杀——专门验「连上**之后**掉线」）/
> `mcp-capabilities-fixture-server.mjs`（stdio，**三面都声明**：tools + resources + prompts，
> 含文本/二进制资源、资源模板、带参与无参提示词，并**自报 `instructions`**——验「声明了才包成
> 工具」、能力面的真实往返，以及 server 用法说明确实被拼进提示词）。
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
| `mcpReload` 的**最慢正当耗时** = 等就绪（≤ `READY_TIMEOUT_MS` 120s，命令在 `#post` 里暂存到 `ready`）+ 每台要重连的 server ≤ 2 × 15s（连接 + 列工具，串行）；而主进程那边原先只等 **10s** | 实测（免费冒烟第 ⑤ 组）：夹具里一个**不说话的 server** 让重载耗时 **15035ms** —— 旧预算下这里会假报「查询 MCP 状态超时」。修法与物证见决策 15 |
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
      ② 就绪后 `mcpReload` 要**串行**把每台变更 / 上一轮失败的 server 重新连上，每台
      ≤ `MCP_STEP_TIMEOUT_MS`（连接）+ 同样一步（列工具）。于是设置页会弹红字
      「查询 MCP 状态超时」，**而 worker 正在正常连接**——不是报错，是界面在说谎
      （与决策 11 同一条纪律的另一面：宁可不说话，也不说反话）。
    - **改法**：预算改为 `READY_TIMEOUT_MS + 2 * MCP_STEP_TIMEOUT_MS`，且**单步值进
      `shared/limits.ts`**——它被两侧各读一次（worker 当 `connect` / `listTools` 的超时，
      主进程拿它算预算），正是 `limits.test.ts` 守的那一类「漂成两份就静默出错」的常量。
      改回一个拍脑袋的数、或在别处再写一份字面量，都会让那条守卫变红。
    - **物证**（免费冒烟 `mcp-reload` 第 ⑤ 组）：夹具里放一个**起来后一句话不说**的子进程，
      断言「这次重载真的等过了 10s 仍然正常兑现」。实测 **15035ms** 后直接返回该 server 的
      `error` 态（`连接失败：Request timed out`）。判据挂在「等过旧预算」上，所以把预算改回
      10s 这条**立刻红**——这正是它能证伪的地方。
    - **残余（如实记）**：多台 server 同时需要重连会**叠加**（每台 ≤ 2 步），超过这条线仍以
      超时收敛——那时是「坏了」而不是「慢」，报错是对的。这条线是兜底、不是 UX 目标：
      正常路径下 worker 一答完就兑现，用户不会真等这么久。

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

## 4. 配置形态

`<cwd>/.colt/mcp.json`（项目级，随项目走；与 `.colt/memory.md` 同一目录惯例）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "FOO": "bar" }
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
- 所有字符串值支持 `${VAR}` 展开成进程环境变量。**缺变量不静默留空**——留空会把
  `https://${HOST}/mcp` 变成看似合法却指向错处的 URL，这里成诊断并跳过该 server。
  只支持 `${NAME}` 这一种写法，不做 shell 式的 `$NAME` / 默认值语法。
- 文件不存在 → 安静跳过（没配就是没配）；JSON 解析失败 / 单个 server 声明不合法 → 诊断进通知，
  可用 server 照常装载。
- 改完在**设置页点「重新加载」**即可生效，会话不必重启（§3 决策 7）。

## 5. 边界（有意不做的）

- **只接 tools 能力**——**已改判**（2026-09-19）：原型阶段认为 resources / prompts「没有
  『包成内核工具』这条自然落点」，实践下来 resources 的「列出 / 读取」本来就是读操作，
  包成工具**有**自然落点；prompts 也顺带包了（参数交给服务端渲染，见决策 13）。
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

- **设置页那块诊断只讲「配置写没写对」**：它是 `loadMcpConfig` 的**解析级**结论（JSON 合法性、
  必填字段、字段类型），**不预检**「这台 server 起得来吗」——那是运行态的结论（`status` / `error`，
  决策 5 / 11）。两条信息在界面上是分开的（诊断块 vs 每台 server 的卡片），别把诊断块当校验器。

- **工具调用的 60s 硬上限（已知限制，未改）**：`callTool` / `readResource` / `getPrompt` /
  列表类都不传 `timeout`，走 SDK 的 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`，且
  `resetTimeoutOnProgress` 默认 `false`——**server 中途发 progress 也不续期**。后果：编译、
  浏览器自动化、大下载这类**正当的长工具**会被就地掐断（`REQUEST_TIMEOUT`）。不是不能改，
  是**要先定产品口径**，三条路各要选一个数：① 直接调大固定值？② 按 server / 按工具可配
  （配置面要加字段）？③ 「有 progress 就续期 + `maxTotalTimeout` 兜总时长」（否则狂发 progress
  的 server 能把一次调用挂死）？在定下来之前**别顺手把 60s 改成一个更大的固定值**——那只是把
  「60s 掐断」换成「5 分钟掐断」，长工具照样断，而界面依旧没有任何「它还在跑」的反馈。

已从边界转正的（原型阶段曾列在「有意不做」，现已实现且有单测）：远程 server（HTTP/SSE）、
`listTools` 分页、`${VAR}` 插值、配置热重载、工具重名去重、设置页可见性、
**`resources` / `prompts` 两个能力面**（决策 13）。
