# MCP 设计草案

> **状态**：**已实施**（验证性原型，2026-09-19）。无界面改动——装载结果经既有
> `session.notice`（kind: "security"）通道告知，回查走 F3 已落地的「事件」页签。
> **落地落点**：`worker/lib/mcp-tools.ts`（全部逻辑都在这一个文件，worker 入口只加一行接线
> `...mcpTools`）/ 依赖 `@modelcontextprotocol/sdk@1.30.0`（官方 SDK，唯一新增依赖）。
> **验收**：单测 `tests/mcp-tools.test.ts`（14 条，含真实 stdio 子进程往返，
> 夹具 `tests/helpers/mcp-fixture-server.mjs` 刻意用低层 `Server` 类、给**裸 JSON Schema**，
> 与生产方同构）。
> **未覆盖**（别当成验过了）：**真模型调用 MCP 工具**的端到端已由冒烟
> `COLT_SMOKE_MODE=mcp-e2e` 覆盖并**实测通过**（2026-09-19，本地 Ollama qwen3:0.6b，
> 9/9：工具可见 → 弹审批卡 → 批准 → `echo:<nonce>` 真实往返回到模型）；仅剩 worker
> 被主进程**强杀**（dispose 超时 / 崩溃）时 MCP 子进程成孤儿的那一支，正常 dispose 有
> `process.on("exit")` 兜底。
> **一句话**：`<cwd>/.colt/mcp.json` 里声明的 stdio MCP server，其工具被包成普通内核工具
> （`mcp__<server>__<tool>` 命名）塞进 `AgentHarness.create({ tools })`——
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
| `AGENTS.md` §四 | 判「接没接」要 grep 调用点、判据落在**行为**上；本功能的行为判据是「包装后的工具出现在 harness 工具数组且能真实往返」——单测用真实 stdio 子进程钉住 |

## 2. 现状（代码实测，不是推测）

| 事实 | 位置 |
|---|---|
| pi-ai 的 `validateToolArguments` 显式区分 typebox / 非 typebox schema（`TYPEBOX_KIND` 符号），对后者走纯 JSON Schema 的 coercion + 编译校验 | `@earendil-works/pi-ai`（测试里有一条专门钉这个契约：裸 JSON Schema 的 `add` 工具，字符串入参被 coerced 成 number 后调用成功） |
| 内核工具签名 `AgentHarnessTool`：`name/label/description/parameters/execute`；失败要 **throw**（内核转错误工具结果） | `worker/lib/host-bridge.ts` 同款约定 |
| 审批豁免名单（`READONLY_TOOLS` / 提问守卫 / 子代理免闸）里没有任何 `mcp__` 前缀 | `shared/readonly-tools.ts`、`worker/entry.ts` |
| 会话启动通知已承载「技能装载」告知，MCP 装载结果复用同一通道（`send({type:"notice", kind:"security"}`） | `worker/entry.ts` init |
| LLM API 工具名普遍 64 字符上限 | `mcpToolName` 截断到 64 并清洗非法字符 |

## 3. 决策

1. **传输**：只接 **stdio**（本地子进程）。远程（HTTP/SSE）未接——配置面（`url` 字段）都不留，
   免得画了开不出来的入口（死配置比没有更糟）。`env` 只支持字面量，不做 `${VAR}` 插值。
2. **schema 透传**：MCP 的 `inputSchema` 是裸 JSON Schema，**原样**交给内核（强转 `TSchema`），
   不在中间加转换层。校验安全网在内核（pi-ai 的 coercion + 编译），不在包装层重复实现。
3. **命名**：`mcp__<server>__<tool>`，非法字符清洗成 `_`，64 字符截断。注册名 / 审批签名 /
   界面展示同源（`label` 给界面：`MCP <server>: <tool>`）。
4. **故障隔离**：单个 server 连不上（15s 连接 / 列工具超时）只收诊断，**不拦会话启动**；
   「已连接 N 个 server：…；MCP 告警 M 条：…」如实告知。会话启动不被一个挂死的 server 拖死。
5. **回收**：正常 dispose 走 `process.on("exit")` 兜底 `client.close()`；`closeMcpTools()` 供测试
   与将来的 dispose 路径显式调用。已知边界：worker 被**强杀**时子进程成孤儿（记入文件头注释，
   不当 bug 修）。
6. **不装 `pi-mcp-adapter`**：它的 ~29% 代码是 TUI 同意面板与宿主生命周期（`ctx.ui`），
   本仓没有那层 API（React + IPC 双进程），装进来逻辑能跑、画不出东西（死重）。

## 4. 配置形态

`<cwd>/.colt/mcp.json`（项目级，随项目走；与 `.colt/memory.md` 同一目录惯例）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "FOO": "bar" }
    }
  }
}
```

文件不存在 → 安静跳过（没配就是没配）；JSON 解析失败 / 单个 server 声明不合法 → 诊断进通知，
可用 server 照常装载。

## 5. 验证性原型的边界（有意不做的）

- 远程 server（HTTP/SSE）与 `url` 配置面。
- `listTools` 分页（绝大多数 server 一次返回全量）。
- 配置热重载（改 `mcp.json` 要重启会话/worker——会话启动时装载是一次性的）。
- 工具名的同义去重（两个 server 给出同名工具时后者覆盖前者——装载通知里如实报数，
  冲突留给用户改配置）。
