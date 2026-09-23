# MCP 设计

> **状态**：**已实施**（2026-09-19；同日补齐原型边界、`resources` / `prompts` 能力面、`instructions` 注入、五条假信号/缺口修复、重载并发互斥，以及产品评审后的五件事——见 §3 决策 13~25）。
> **落地落点**：`shared/mcp-config.ts`（配置**纯解析层**，两侧共用）、`shared/mcp-label.ts`（展示名）、`worker/lib/system-prompt.ts`（让 agent 自己装）、`worker/lib/mcp-tools.ts`（连接 / 包装 / runtime / 能力工具）、`worker/lib/mcp-reload.ts`（热重载 + 后台补挂 + instructions 注入 + 设置页命令）、`worker/entry.ts`（接线）、`main/session-manager.ts` + `main/ipc`（`mcp.status` / `mcp.reload`）、`renderer/src/features/Settings.tsx`（`McpSettings`）。
> **依赖**：运行期唯一新增依赖是 v2 官方 SDK `@modelcontextprotocol/client@2.0.0`；`server` / `node` / `server-legacy` 只被测试夹具用。
> **验收**：单测 `tests/mcp-tools.test.ts`（**42 条**，全是真实子进程 / 真实 HTTP / 真实 SSE 往返，夹具与生产方同构）；冒烟 `mcp-e2e`（打模型，**实测通过**：工具可见 → 弹审批卡 → 批准 → `echo:<nonce>` 往返）、`mcp-real`（真实第三方 server）、`mcp-reload`（**免费**，12 条，验 renderer → main → worker 接线）。
> **未覆盖（别当成验过了）**：worker 被**强杀**（dispose 超时 / 崩溃）时 MCP 子进程成孤儿那一支；`list_changed` 通知未接。
> **一句话**：`<cwd>/.colt/mcp.json` 里声明的 MCP server（stdio 或 HTTP/SSE），其工具被包成普通内核工具（`mcp__<server>__<tool>`）塞进 `AgentHarness.create({ tools })`——**安全模型零例外**（天然过 `before_tool` 审批闸门），不自建扩展宿主。
> **配套**：动手前读 `docs/ARCHITECTURE.md` §四（为什么不用 pi 扩展宿主）、`docs/SECURITY.md`（免审批边界）、`AGENTS.md` §四（「参数传了 ≠ 行为发生」）。

---

## 1. 依据

| 来源 | 约束 |
|---|---|
| `NEXT-PHASE.md` §3.2 能力补齐 ③ | 「MCP 工具调用天然过 `before_tool`」——实际更简单：不在任何豁免名单即天然过闸，一行审批代码都不用改 |
| `NEXT-PHASE.md` §3.2 扩展宿主否决三条 | ① UI 挂载点对不上 ② 扩展代码绕过审批闸门 ③ 验收手段失效——MCP server 是**外部进程**，三条都不触碰 |
| `SECURITY.md` | MCP server 是**会话启动即执行的本地代码**，与技能同一条隐式信任通道：装了什么、坏在哪里必须如实告知（notice 按 security 类发，落 `session_events` 可回查） |
| `AGENTS.md` §四 | 判「接没接」要 grep 调用点、判据落在**行为**上；本功能的行为判据是「包装后的工具出现在 harness 工具数组且能真实往返」 |

## 2. 关键事实（代码实测，不是推测）

- pi-ai 的 `validateToolArguments` 显式区分 typebox / 非 typebox schema，对后者走纯 JSON Schema 的 coercion + 编译校验（有单测直接钉这个契约）。
- 内核工具签名 `AgentHarnessTool`：`name/label/description/parameters/execute`；**失败要 `throw`**（内核转错误工具结果）。
- 审批豁免名单（`READONLY_TOOLS` / 提问守卫 / 子代理免闸）里**没有任何 `mcp__` 前缀**。
- 内核 `validateToolNames` 见**重名直接 `TypeError`**（`setTools` 与 `create` 两处都跑）——重名必须由我们在**包装层挡掉**，否则一个撞名配置能把整个会话启动搞崩。
- 内核 `lane.readConfig().tools` 是**活取的**，`lane.configuration.activeToolNames` 是 lane 自己持久化的——热重载要**同时写这两处**（决策 7）。
- SDK 自带三种 client transport：`StdioClientTransport`（子路径 `client/stdio`）/ `StreamableHTTPClientTransport` / `SSEClientTransport`（后两者**从包根导出**）。
- v2 的 `listTools()` **不传 cursor 时自己翻完所有页并聚合**；自动翻页上限是 `ClientOptions.listMaxPages`；`listPrompts` / `listResources` / `listResourceTemplates` 同款。
- SDK `RequestOptions.timeout` 缺省 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`（`callTool` 不是没超时，是走 SDK 默认 60s）。
- `StdioServerParameters.cwd` 缺省「继承当前进程的 cwd」，而 worker 由 `utilityProcess.fork(...)` 起、**没带 `cwd`**——所以 worker 的 cwd = **应用进程**的 cwd（决策 17）。
- `Protocol.onclose` 是公开可赋值的钩子；HTTP 传输会 **re-fire**（「只报一次」要靠自己幂等，决策 11）。
- `client.getServerCapabilities()` / `client.getInstructions()` 都是公开取值口，但 SDK **一处都不替你调用** `getInstructions()`（决策 14）。

## 3. 决策

1. **传输**：stdio（本地子进程）+ 远程（Streamable HTTP；`transport: "sse"` 走旧式 SSE）。配置用 `command` / `url` **二选一**表达；三种传输在包装层无差别，差异只在 `buildTransport` 一个分支。
2. **schema 透传**：MCP 的 `inputSchema` 是裸 JSON Schema，**原样**交给内核（强转 `TSchema`），不在中间加转换层；校验安全网在内核。
3. **命名** `mcp__<server>__<tool>`，非法字符清洗成 `_`、64 字符截断；注册名 / 审批签名 / 界面展示同源（`label` = `MCP <server>: <tool>`）。
4. **重名去重**：全量工具按**注册名**去重，保留先到的、后到的记进通知。这不是洁癖——内核见重名直接 `TypeError`，撞名会让 `AgentHarness.create` 崩掉，比「少一个工具」严重得多。
5. **故障隔离**：单台 server 连不上（15s 连接 / 列工具超时，或 `${VAR}` 缺变量）只收诊断、**不拦会话启动**，该 server 在现状里显示 `error` 并带原因。**失败不是终局**：`reload()` 会重试上一轮没连上的（配置没变也试）——否则「重新加载」对失败态就是死按钮。
6. **分页**：**不用自己翻**——v2 `listTools()` 不传 cursor 即自动翻完并聚合，只有显式传 `cursor` 才回单页；页数上限显式钉在 `Client` 的 `listMaxPages: 100` 上（不藏在 SDK 默认值里）。这个契约由单测**直接钉 SDK**（哪天 SDK 改成不聚合，先红的是用例）。
7. **热重载**：`reload()` 关掉「不再声明 / 配置变了 / 上一轮没连上」的，连上「新声明的 / 上一轮失败」的（后者刻意——server 起晚了、网络刚恢复、进程崩了重启都不改配置，但「重新加载」必须能救回）。写回必须**两处都写**（`harness.setTools` **和** `lane.setActiveTools`），**删掉的工具必须连清单一起删**，否则下次生成 `configured_tools_unavailable`。**`ServerState.config` 存「声明值」（不展开 `${VAR}`）**——存解析值会同时坏两件事：① `${VAR}` 的 server 每次都被判「配置变了」而白重连；② `status().target` 会把**真实密钥**画在设置页上。判据取「不重连」＝工具对象**引用同一性**不变。
8. **回收**：正常 dispose 走 `runtime.close()`（优雅：`stdin.end` → 等 → `SIGTERM`）；worker 被**强杀**时退到 `process.on("exit")` 的同步兜底。已知边界：强杀那刻正在启动的子进程仍可能成孤儿。
9. **设置页可见性**：`mcp.status` 带 `live`——true = 找该项目下任一活 worker 要**真实运行态**；false = 只有配置文件里的声明（status 一律 `idle`）。两者语义不同，界面分开说。
10. **不装 `pi-mcp-adapter`**：它 ~29% 的代码是 TUI 同意面板与宿主生命周期（`ctx.ui`），本仓没有那层 API（React + IPC 双进程），装进来逻辑能跑、画不出东西。
11. **掉线如实上报**：连上**之后** server 死掉，`status()` 立刻转 `error`（订阅 SDK `onclose`）——否则设置页永远显示「已连接」而工具调用早已失败，**持续撒谎比没有信号更糟**。两个边界：① 主动 `close()` 时 SDK 同样触发 `onclose`，先看 `closing` 标记，别把 reload / dispose 自己的关闭误报成「断开」；② 刻意**不**接 `onerror`（SDK 明说那里的错误「不一定是致命的」）。掉线**不自动重连**，靠「重新加载」救回；工具仍留在清单里，调用照常失败（不去伪造成功）。**同时发一条 security 类 notice**（toast 之外落 `session_events`、可在「事件」页签回查），**只报一次**（用 `state.error` 已置位当幂等闸）、**我们主动关的不报**。判据由真实自杀夹具钉住。
12. **用 v2（`@modelcontextprotocol/*@2.0.0`）**：v2 拆成 `client` / `server` / `core`（+ 中间件包）。**关键更正：v2 没有砍掉旧式 SSE**——`SSEClientTransport` 仍在，只是从子路径挪到了**包根导出**；服务端 `SSEServerTransport` 挪到 `@modelcontextprotocol/server-legacy/sse`。故 `transport: "sse"` 能力**原样保留**。⚠️ 判「有没有新版」要按**包名**查（旧包 `@modelcontextprotocol/sdk` 的 `latest` 永远是 1.30.0）。
13. **`resources` / `prompts` 也包成内核工具**（`capabilityTools`）：server 声明了才加（`list_resources` / `read_resource` / `list_prompts` / `get_prompt`；命名同款 ⇒ 天然过闸）。**二进制资源不展开成 base64**（只回「二进制 + MIME + 长度」）；`get_prompt` 把各条消息拼成 `<role>: <内容>`，参数交给**服务端**渲染（不走内核的 `promptTemplates`——它要求参数由客户端格式化，硬套会得到「参数传不进服务端」的假接口）。**边界（未做）**：prompts 的**用户侧**入口（`/` 候选里按名选、填参数）没做。
14. **server 自报的 `instructions` 拼进系统提示词**（`composeMcpInstructions`，`transform_context` 链尾每请求重拼）：SDK 只给取值口、**一处都不替你调**——应用不拼就是静默丢掉，而装载 / 告警 / 计数 / typecheck / 单测全绿（与技能清单**同一个坑**）。无 instructions 时**原样返回 base**、不产出多余空行（否则拼出的串每次都变、提示词缓存失效）。⚠️ 这是 server 自报文本进系统提示词，与工具描述同一条隐式信任通道，原样引用、不当本机指令。**已知未覆盖**：`entry.ts` 里那一行调用没有结构断言（同 `renderTodoBlock` / `renderAgentCatalog` 的惯例）。
15. **「等 MCP 回话」的预算必须盖住 worker 侧的单步上限**（`MCP_QUERY_TIMEOUT_MS`）：原先是 `10_000`（抄自两条快操作），而这条往返最慢的正当耗时是「等 `ready`（上限 `READY_TIMEOUT_MS`）+ 每台 server 重连两步」，于是设置页会**假报**「查询 MCP 状态超时」而 worker 正在正常连接。改法：预算按 `READY_TIMEOUT_MS + 4 * MCP_STEP_TIMEOUT_MS` 推导（决策 25 之后抬到 `4 *`），**单步值进 `shared/limits.ts`**（两侧各读一次，漂成两份就静默出错，由 `limits.test.ts` 守）。物证：免费冒烟用「不说话的 server」实测 **15035ms** 仍正常兑现，把预算改回 10s 立刻红。
16. **配置诊断走 IPC，两条路都给**：`declaredMcpServers` 原先把 `loadMcpConfig` 的 `diagnostics` **整包丢掉**，于是坏声明（JSON 非法 / 缺 command 或 url）被设置页渲染成「本项目未声明 MCP server」——把「你写错了」说成了「你没配」。改法：`diagnostics` **一律由主进程自己解析**（它本来就在读这份文件），设置页在列表**上方**单独画一块、**不替换列表**。
17. **stdio server 的工作目录 = 会话的项目根**（`buildTransport(config, cwd)`）：不传 `cwd` 会继承**应用进程**的 cwd，于是 `args: ["."]` / `["src"]` 这类**最主流的相对写法**会静默指错或 `Cannot find module`。与「`.colt/mcp.json` 定位 / harness 工具 cwd / 记忆项目隔离」同源，都认**会话的项目根**。
18. **「答不回来的 MCP 查询」必须当场失败**：`PendingMcpQuery` 带 `settle` / `fail` 两条收场口子，三处触发点（worker 崩溃 / 回收 / init 失败）都调 `#drainPendingMcp`——否则抬到分钟级预算后设置页会挂一条**假的**「重载中…」。**已知未覆盖**：这条**没有行为断言**（现有注入器 t=0 就 `exit`，落不进那个几毫秒的窗口）。
19. **重载必须互斥**：`reloadInFlight` + `doReload`，有在飞的就**返回它**（重载是幂等的「把现状对齐到配置」，复用结果对两个调用方都成立）。选「复用」而非「排队」还省掉一轮白连。判据：`Promise.all([reload(), reload()])` 后最多**起一个**进程（夹具挂 `COLT_MCP_START_LOG`）。
20. **配置两级：用户级 + 项目级，项目级同名覆盖**（`loadMcpConfig(cwd, home?)`）：用户级 `~/.colt/mcp.json`、项目级 `<cwd>/.colt/mcp.json`；合并时**项目级同名覆盖用户级**。诊断**点名是哪个文件**，两层都报。**`home` 省略则不读用户级**（单测据此保持项目级确定性，不随开发者的 `~/.colt/mcp.json` 漂移）；生产调用方传 `mcpUserHome()`，可被 `COLT_MCP_HOME` 覆盖（冒烟专用的测试缝）。
21. **安装方式 = 让 agent 自己写配置**：**不做**应用内配置编辑器 / 「添加 server」表单——用户直接让 agent 装（它本来就有 write / edit）。把格式与两个位置写进基础系统提示词，并带上两条纪律（密钥一律 `${VAR}`、写好后让用户点「重新加载」）。写项目外的 `~/.colt/` 在审批里是 **dangerous**、逐次弹卡。
22. **展示名：注册名 → `MCP <server>: <tool>`**（`shared/mcp-label.ts`，纯字符串、**不带 node 依赖**，主进程与渲染层共用）：此前审批摘要 / 工具卡 / tooltip 逐字画出注册名 `mcp__alpha__echo`，全是开发者黑话。**已知取舍**：注册名把非 `[A-Za-z0-9_-]` 清洗成 `_`，`my server` 会显示成 `my_server`——为「同一工具不给两个说法」接受它。
23. **通知按 `kind` 分流**：`session.notice` 原先不看 `kind`，一律塞进绿色「压缩完成」提示条、5 秒消失，于是「MCP server 掉线」被画成**绿色成功提示**。改法：`security` 用警示色 + 停留 12s（其余仍是绿色 5s）；数据属性分开（`data-conv-compact-notice` / `data-conv-security-notice`）。
24. **调用超时按 server / 工具可配**（`timeout` / `toolTimeouts`）：默认不变（仍 60s），用户对某台 server 或某个工具**按需放宽**（而非把全局值调大）。解析收在 `callTimeoutOf`（纯函数，**工具级 > server 级 > undefined=交回 SDK 60s**）；**连接与列工具仍走 15s**。`timeout` / `toolTimeouts` 计入 `configKey`（改超时即「配置变了」，点「重新加载」会重连重建，否则是静默空操作）。判据落在行为上：`mcp-slow-fixture-server.mjs` 的 `sleep` 真睡 N 毫秒做差分。
25. **MCP 不出现在会话启动的关键路径上：并行连接 + 启动预算 + 后台补挂**：原先是逐台**串行** `await`（每台最坏 30s），**4 台连不上就把会话拖成打不开**，用户只看到「会话进程启动超时」。改法（缺一不可）：① **并行**（`Promise.all`，耗时从「N 台叠加」回到「一台最坏值」）；② **预算** `MCP_STARTUP_BUDGET_MS`（15s），超预算的**转后台**，会话照常 ready，连上后经 `onSettled → armLateMcpAttach` 复用 `reloadMcpIntoHarness` 补挂。**补挂必须显式**（`entry.ts` 里 `...mcp.tools` 是一次展开快照，后台连上的不会自己出现）。热重载**不适用预算**（用户显式点按钮就要等结果），但重载**必须先等上一轮后台收尾落定**（`await tail`，即决策 19 的互斥）。`close()` 不等后台收尾。三个边界（各有用例）：① **没欠后台就不许补挂**（`hasLatePass`——否则每次启动多跑一次 reload，会话开头两条一模一样的通知）；② 诊断改在 `connectPass` 里**就地记**（超预算那支拿不到逐台返回值）；③ `doReload` 开头**挡 `closed`**（否则会替已关掉的会话重新 spawn）。判据：并行那组用「是不是同时 spawn」（不用墙钟，进程启动开销会漂）。

## 4. 配置形态

**两级**，与技能 / 记忆同一条「用户目录 + 项目」心智（决策 20）：用户级 `~/.colt/mcp.json`（对全部项目生效）、项目级 `<cwd>/.colt/mcp.json`（随项目走、**同名覆盖**用户级）。

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

- `command`（+ `args` / `env`）与 `url`（+ `headers` / `transport`）**二选一**；`transport` 缺省 `http`（Streamable HTTP），`"sse"` 走旧式 SSE。
- `timeout`（毫秒）覆盖默认 60s **调用**上限（连接 / 列工具不受它影响）；单个工具再用 `toolTimeouts: { "工具名": 毫秒 }` 单独放。
- 字符串值支持 `${VAR}` 展开成进程环境变量。**缺变量不静默留空**——成诊断并跳过该 server。只支持 `${NAME}` 这一种写法。
- 文件不存在 → 安静跳过；解析失败 / 单个声明不合法 → 诊断进通知、可用 server 照常装载，**诊断点名是哪个文件**。
- 改完在**设置页点「重新加载」**即生效，会话不必重启。**不想手写就交给 agent 装**（决策 21）。

## 5. 边界（有意不做的）

- **不做应用内配置编辑器 / 「添加 server」表单**：让 agent 安装（决策 21）；设置页保持「只读展示 + 重新加载」。
- **prompts 没有用户侧入口**：模型能按名取（`get_prompt`），输入框 `/` 候选里按名选、填参数那套没做。
- **`list_changed` 通知未接**：server **中途**增删工具 / 资源时要等用户点「重新加载」或下次连上才变。不是不能做（写回那套现成），但要在**会话中途**把新清单写回 harness 与所有 lane，而 server 频繁发通知会在**生成途中**扰动工具面（`configured_tools_unavailable` 那类事故的现场）——得先想清「什么时候才允许应用」。
- **远程鉴权只支持静态头**：没接 `authProvider`（OAuth 要回调页与凭据存储，与 `secrets` 那套的关系要先想清楚）。
- **不做 server 的启停开关**：注释掉配置项即等效。**不做工具白名单 / 逐工具审批粒度**：MCP 工具一律走「未知工具 → 按需确认」；要给某台免审批应走审批规则那套。
- **强杀孤儿**：worker 被强杀那刻正在启动的 MCP 子进程可能成孤儿（决策 8）。
- **后台连接期间设置页看不到「连接中」**（决策 25 引入）：超预算转后台的那台在 `status()` 里**没有条目**，要等落定才出现（`McpServerView.status` 只有 `connected` / `error` 两态），这一段由那条「已转后台继续连接」的 notice 顶上。不新增 `connecting` 态是刻意的。
- **设置页那块诊断只讲「配置写没写对」**：它是 `loadMcpConfig` 的**解析级**结论，**不预检**「这台 server 起得来吗」（那是运行态的结论，决策 5 / 11）。别把诊断块当校验器。
- **工具调用的超时口径**（已改判，决策 24）：默认仍 60s、按 server / 工具可配；**仍不做**「有 progress 就续期」（那要配 `maxTotalTimeout` 兜总时长，等真需求再上）。
- **旧式 SSE 是 v2 的 legacy 面**：`transport: "sse"` 仍照常支持，但 v2 已把它列为 legacy，规范给了一年退场期。**触发条件**：哪天要甩掉 `server-legacy` 依赖，就得先决定 `transport: "sse"` 是否随之下线（那是**产品决定**）。⚠️ 别在没做过这个决定前就删 `server-legacy`——SSE 夹具与用例会一起消失，等于把「这一支还能不能用」的证据也删了。

**已从边界转正的**（原型阶段曾列「有意不做」，现已实现且有单测）：远程 server（HTTP/SSE）、`listTools` 分页、`${VAR}` 插值、配置热重载、工具重名去重、设置页可见性、`resources` / `prompts` 能力面。
