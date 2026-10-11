# 三个关键缺口 · 设计与实现计划（2026-10）

> 本文件是**施工图纸**，写给接下来负责实现的会话（可能是能力较弱的模型）。
> 每个工作包都写到「改哪个文件、抄哪段现成模式、加什么测试、跑什么命令验收」的粒度，
> 照单执行即可，**不要自行扩大范围**。
>
> 背景：本计划出自两份评审——`docs/architecture-review-2026-10.md`（通用架构）与
> `docs/architecture-agent-review-2026-10.md`（对照业界 agent 设计）。
> 三个缺口按实施推荐顺序排列：
>
> | 包 | 缺口 | 严重度 | 风险 | 预估改动面 |
> |---|---|---|---|---|
> | **A** | 无 grep/glob 检索工具（模型只能用 bash `find`/Select-String 检索） | 🟠 | 低（纯新增） | worker 2 个新文件 + 2 处挂接 + 测试 |
> | **B** | API Key 经 env 明文进 worker，bash 继承全量 env 可读回 | 🔴 | 中（动密钥链路） | provider-factory / 契约 / session-manager |
> | **C** | 无模型路由：子代理与审批分析器都用主会话同一模型 | 🟠 | 中高（动契约 + HostBridge） | agent-defs / subagent / 契约 / host / approval |
>
> **先做 A，再做 B，最后做 C。** A 完全独立，B 独立，C 依赖 B 建立的「密钥只走内存」模式。
> 每个包交付后 `npm run typecheck && npm test` 必须全绿，再开始下一个。

---

## 0. 给实现者的规则（先读，违反必翻车）

这些规则全部来自本仓库 `AGENTS.md` 记录的真实事故，不是客套话：

1. **改文件用 `edit`，一次改到位**。禁止用脚本（python/node）反复注入改写同一个文件。
   验证与修改分开：先改完，再统一验证。
2. **动手前先量行数**。体量闸：`src/` 下（除 `src/dev/`）任何文件 ≤ 2200 行，且
   `src/renderer/src/features/Conversation/index.tsx` 的 hook 数 ≤ 50。闸的口径是
   `split("\n").length`，与 `wc -l` 差 1。量法：
   `node -e "console.log(require('fs').readFileSync('<文件>','utf8').split('\n').length)"`
   本计划涉及的 `session-manager.ts`、`worker/entry.ts` 都是「已知大户」（见
   `tests/size-guard.test.ts` 的 `KNOWN_LARGE_FILES`），加代码前先量，逼近上限就先把
   一块自成一体的逻辑抽成新文件再写功能。
3. **写新文件前先确认它真的不存在**：`git status --short` 看是否已跟踪，或直接 `Read`
   一次（读不到再写）。**不要用「grep 无匹配」推断文件不存在**。
4. **每完成一个工作包就跑 `npm run typecheck && npm test`**。测试总数是可预期的
   （改前 N + 新增 M），对不上当场查，不要往后拖。
5. **契约双向对齐**：`src/shared/protocol.ts` 里 `IPC_CHANNELS` 与 `IpcInvokeMap` 的键
   有编译期断言必须一一对应，加 IPC 通道时两边一起加；`src/shared/worker-protocol.ts`
   的 `WorkerCommand` / `WorkerMessage` 是判别联合，加字段要同步改主进程与 worker 两侧。
6. **调试残留当场清**：不留 `console.log`、不改 `document.title` 做标记。改完读一遍
   文件结尾确认。
7. **测试装置不许有副作用**：打桩只记账，不要转发给真实现（会真打模型计费 / 写用户数据）。
8. 改动**不顺手重构**无关代码；发现别的问题记录在案，不在本计划内修。

---

## 工作包 A：grep / glob 检索工具

### A.1 目标

给 worker 增加两个**纯只读**工具 `grep` 与 `glob`，让模型检索代码不再走 bash。
对标业界：Claude Code / Codex / Gemini CLI 全部内置这两个工具并默认免审批。

### A.2 现状证据（已核实）

- 内核 `@earendil-works/pi-agent-core` 只自带 `bash / edit / read / write` 四个工具
  （见 `node_modules/@earendil-works/pi-agent-core/dist/harness/tools/`），**没有** grep/glob。
- 审批白名单 `src/shared/readonly-tools.ts` **已经预留** `"grep","glob","ls","list","search"`——
  工具名取 `grep` / `glob` 即自动免审批，policy 不用动。
- 渲染层 `src/renderer/src/features/Conversation/MessageList.tsx:854-856` 的 `describeTool`
  已经处理这些名字的图标与副标题——UI 不用动。
- 自建工具范式照抄 `src/worker/lib/todo-tool.ts`：typebox schema + `AgentHarnessTool` 对象，
  「描述」是唯一引导落点（内核没有 promptGuidelines 钩子）。
- 工具注册点在 `src/worker/entry.ts` init 处理里的 `tools: [...]`（约 411-422 行）。

### A.3 设计决策（已定，不要改方向）

1. **在 worker 进程内实现**，不走 HostBridge 到主进程。理由：纯只读、无原生依赖，
   减少一次 IPC 往返；与 `memory_search` 等 worker 内工具一致。
2. **路径安全由工具自己保证**：`read` 工具的越界防护在主进程（`src/main/lib/path-guard.ts`
   的 `isWithinRoot`），而只读白名单放行时**不看路径**——如果 grep 支持绝对路径或 `..`，
   模型就能读到项目外文件，绕过 read 的边界。因此：
   - 工具只接受**相对路径**（缺省 = 项目根），拒绝绝对路径与任何含 `..` 的片段；
   - 统一走一个 `resolveInRoot(root, rel)` 帮助函数：拼接 → `path.resolve` →
     必须以 `root` 为前缀，否则返回结构化错误（不抛异常，错误也是给模型看的）。
3. **输出必须封顶**：单次最多返回 200 条匹配、总字节 ≤ 64KB，超了截断并在末尾标注
   「已截断：共 N 条，仅显示前 200」。不封顶的检索结果会瞬间吃掉上下文。
4. **跳过噪声目录**：`.git`、`node_modules`、`out`、`dist`、`.next` 永远跳过；
   二进制文件（内容含 NUL 字节）跳过。
5. **glob 语义只实现最小集**：`**`（跨目录）、`*`（单段）、`?`、`{a,b}` 分支。
   自写一个 glob→RegExp 转换器（约 40 行），不引依赖、不依赖系统 ripgrep
   （运行环境没有 rg）。
6. **错误即结果**：找不到、路径越界、正则不合法都返回 `{ ok: false, error: "..." }`
   结构，让模型自我纠正，不 throw（参照 todo-tool 的做法）。

### A.4 改动清单

**新文件 1：`src/worker/lib/search-tools.ts`**（两个工具放一个文件，预计 250-350 行）

导出 `createSearchTools(projectRoot: string): AgentHarnessTool[]`，内含：

```ts
// 结构示意——具体类型签名照抄 src/worker/lib/todo-tool.ts 的写法
const grepTool = {
  name: "grep",
  label: "搜索内容",
  description: [
    "在项目文件里按正则搜索内容，返回 文件路径:行号:行内容。",
    "只读，不修改任何文件。优先用它而不是 bash 里的 find/grep/Select-String。",
    "参数 path 为项目内相对路径（缺省=项目根），不支持绝对路径与 ..。",
    "自动跳过 .git/node_modules/out/dist 与二进制文件；结果最多 200 条、64KB，超出会截断。",
  ].join("\n"),
  parameters: Type.Object({
    pattern: Type.String({ description: "正则表达式（JS 语法）" }),
    path: Type.Optional(Type.String({ description: "项目内相对路径，缺省为项目根" })),
    glob: Type.Optional(Type.String({ description: "文件名过滤，如 *.ts、**/*.tsx" })),
    ignoreCase: Type.Optional(Type.Boolean()),
  }),
  execute: async (_id, params) => { /* 实现 */ },
};

const globTool = {
  name: "glob",
  label: "按模式找文件",
  description: "按 glob 模式列出项目内文件路径（相对项目根）。只读。** 跨目录、* 单段。结果最多 500 条。",
  parameters: Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
  }),
  execute: async (_id, params) => { /* 实现 */ },
};
```

实现要点：
- 目录遍历用 `fs.promises.readdir(dir, { withFileTypes: true })` 递归，循环里先查
  跳过名单再下沉；
- grep 逐文件 `readFile(path, "utf8")`，读失败（编码/权限）就跳过该文件；
  行匹配用编译好的 `RegExp(pattern, ignoreCase ? "i" : "")`；`pattern` 编译失败要
  返回结构化错误「正则不合法：<message>」；
- `globToRegExp`：先把 `**` 占位 → 再逐段转义正则特殊字符 → `*`→`[^/]*`、
  `?`→`[^/]`、`{a,b}`→`(a|b)` → 还原 `**` 为 `.*`，全程对 Windows 反斜杠做 `/` 归一
  （遍历得到的相对路径统一 `path.sep → "/"` 再匹配）。

**新文件 2：`tests/search-tools.test.ts`**（node --test 风格，照 `tests/ask-user.test.ts` 模式）

用例（在 `os.tmpdir()` 下现造目录夹具，不碰真实仓库）：
1. grep 命中返回 `相对路径:行号:内容`，路径用 `/`；
2. grep 带 `glob: "*.ts"` 只搜 ts 文件；
3. 绝对路径与 `../x` 都被拒绝且返回结构化错误；
4. 正则不合法返回结构化错误、不 throw；
5. 超过 200 条截断且末尾有标注；
6. `.git`/`node_modules` 下的文件不出现在结果里；
7. glob `**/*.md` 能跨目录命中；`*` 不跨目录；
8. 二进制文件（写入含 `\0` 的文件）被跳过。

**改动 3：`src/worker/entry.ts`**（先量行数！若 ≥2150 就先把搜索工具放独立文件这步
提前做——本来就该放独立文件，entry 只加一行展开）

init 的 `tools: [...]` 里加 `...createSearchTools(projectRoot)`。`projectRoot` 用 init
消息里已有的项目根字段（照 `todo` 工具怎么拿根路径就怎么拿，不要新造通道）。

**改动 4：`src/worker/lib/system-prompt.ts`**

加一句引导（放在工具使用相关段落）：
「检索代码优先用 `grep` / `glob` 工具，不要用 bash 里的 find、grep、Select-String。」

### A.5 验收

```bash
npm run typecheck && npm test
# 测试总数 = 改前 + 8
```

冒烟可不做（dock 冒烟体系不必为本包加用例）；手动验证：dev 起会话，让模型
「找一下 setActiveTools 在哪用」，观察它调用 `grep` 且工具卡显示免审批直接执行。

### A.6 雷区

- 工具名**必须**就叫 `grep` / `glob`，改名会脱离只读白名单 → 每次检索都弹审批。
- 不要在工具里调 `child_process`；纯 fs 实现。
- 别忘 Windows：路径分隔、大小写不敏感（文件名比较用小写归一即可，路径返回保持原样）。
- `AgentHarnessTool` 的具体字段名以 `todo-tool.ts` 为准，上面是示意，别照抄字段名猜。

---

## 工作包 B：API Key 改道——密钥不进环境变量

### B.1 目标

消除「模型一条 bash 命令就能读到 API Key」的漏洞。改完后：
- worker 进程的 env 里**没有任何密钥**；
- worker fork 只带白名单环境变量，不再 `...process.env` 全量继承；
- bash 工具即便 `inheritEnv: true` 也只能继承到白名单 env；
- 密钥只在主进程内存与 worker 内存中以局部变量存在，经 init 命令消息体一次性传入。

### B.2 现状证据（已核实，含行号）

- 泄漏点：`src/main/session-manager.ts:802-808`，fork worker 时：
  ```ts
  env: {
    ...process.env,                                   // 全量继承
    DEEPSEEK_API_KEY: options.provider.kind === "deepseek" ? providerKey : "",
    COLT_PROVIDER_KEY: providerKey,                   // 明文密钥进 env
    ...
  }
  ```
- 放大器：内核 `harness/tools/bash.js:33` 每次 bash 执行 `inheritEnv: true`，
  `harness/env/nodejs.js` 的 `getShellEnv` 把 `process.env` 全量铺进子 shell。
  即模型执行 `echo $COLT_PROVIDER_KEY`（或 `set` / `env`）即可拿到密钥。
- worker 侧消费点：`src/shared/provider-factory.ts:45-79` 的 `buildProvider`：
  - `kind === "deepseek"` 走 `deepseekProvider()`，其内部硬编码读 `DEEPSEEK_API_KEY` env；
  - 其它 provider 用 `envApiKeyAuth(name, ["COLT_PROVIDER_KEY"])`（第 56 行）读 env。
- 无密钥本地服务（如本地 Ollama 类）现状：providerKey 是占位符 `"colt-local-no-key"`
  （`KEYLESS_PLACEHOLDER`，在 session-manager 附近定义），仅用来喂 openai-completions
  层的非空校验——**这个语义必须保留**。
- 不受影响的部分：`src/main/approval/analyzer.ts` 的审批分析器本来就以**参数**收
  apiKey（主进程内调用，不经 env）；`src/main/ipc/index.ts:910` 的
  `importKeyFromEnvIfMissing`（从用户 shell env 把 DEEPSEEK_API_KEY 导入加密 secrets
  存储）是**导入方向**，保留不动。
- 内核已给出改道所需的全部接口（`node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts`）：
  `ApiKeyAuth.resolve()` 返回 `AuthResult { auth: ModelAuth { apiKey?, headers?, baseUrl? } }`，
  可以自己实现一个「闭包内存密钥」的 ApiKeyAuth 替代 `envApiKeyAuth`；
  DeepSeek 的静态模型表在 `@earendil-works/pi-ai/providers/deepseek.models`
  （`DEEPSEEK_MODELS`），`src/main/providers.ts:11` 已经这样引用过。

### B.3 设计决策（已定）

1. **密钥走 init 命令消息体，不走 env**。`WorkerCommand.init` 加 `apiKey: string` 字段
   （含占位符语义：无密钥场景仍传 `KEYLESS_PLACEHOLDER`，worker 侧原样使用）。
   IPC 消息体不落盘、不进 shell env，暴露面从「任何子进程可读」收敛到「进程内存」。
2. **worker fork env 收敛为白名单**。白名单初值（Windows 桌面进程必需项）：
   `PATH, SystemRoot, SystemDrive, windir, COMSPEC, PATHEXT, TEMP, TMP,
   USERPROFILE, HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA, PROGRAMDATA,
   NUMBER_OF_PROCESSORS, OS, LANG, TZ, NODE_ENV`
   外加 Colt 自己需要传给 worker 的非密钥控制变量（逐一核对 802-808 行现状里除
   `...process.env` 和两个 KEY 以外的键，全部保留）。
   **实现第一步先做一次实测**：在 dev 里打印 fork 前 `Object.keys(process.env)` 全量键名，
   对照白名单查漏（比如某些代理变量 `HTTP_PROXY` 若产品依赖就加进白名单），
   把实测结果留在 PR 描述里。打印代码**验收前必须删掉**（规则 6）。
3. **`buildProvider` 改签名**：加 `apiKey` 参数，用自定义 ApiKeyAuth：
   ```ts
   const memoryApiKeyAuth = (name: string, apiKey: string): ApiKeyAuth => ({
     name,
     resolve: async () => ({ auth: { apiKey } }),
   });
   ```
   - 通用分支：`auth: { apiKey: memoryApiKeyAuth(...) }` 的形状照现状第 56 行的位置替换，
     具体字段以 `createProvider` 的入参类型为准；
   - DeepSeek 分支：**停用 `deepseekProvider()`**，改用 `createProvider` +
     `DEEPSEEK_MODELS` + baseURL `https://api.deepseek.com` + memoryApiKeyAuth。
     先读 `node_modules/@earendil-works/pi-ai/dist/providers/deepseek.*` 确认
     `deepseekProvider()` 内部到底组装了什么（baseURL、headers、models 来源），
     **照抄其装配、只把密钥来源换掉**，不要凭印象重写。
4. **bash 侧不改内核**。env 白名单在 fork 处收敛后，内核 `inheritEnv: true` 继承的
   已经是干净 env，`createBashTool` 的 `prepare` 钩子**不需要**用。（知道有这个钩子即可，
   别去改 node_modules。）
5. **主进程侧的密钥来源不变**：secrets 加密存储、`importKeyFromEnvIfMissing`、设置页
   的密钥管理 IPC 全部不动。本包只改「主进程 → worker」这一段传递方式。

### B.4 改动清单

1. `src/shared/worker-protocol.ts`：`WorkerCommand.init` 的载荷类型加 `apiKey: string`。
2. `src/shared/provider-factory.ts`：`buildProvider(config, apiKey)` 改签名与实现
   （见 B.3-3）；更新文件头注释里「密钥经 env」的描述（若有）。
3. `src/main/session-manager.ts`（**先量行数**，超 2150 先把 fork 参数装配抽成
   `src/main/lib/worker-env.ts` 纯函数文件再改）：
   - fork `env` 改白名单装配（抽 `buildWorkerEnv(control: Record<string,string>)` 纯函数，
     输入控制变量，输出白名单 env——纯函数好测）；
   - 取到 providerKey 后不再写进 env，而是放进 init 命令的 `apiKey` 字段；
   - 占位符逻辑原样保留（无密钥时传 `KEYLESS_PLACEHOLDER`）。
4. `src/worker/entry.ts`：init 处理里把 `apiKey` 从命令载荷取出，传给 `buildProvider`。
5. `src/main/providers.ts`：若其中有「worker 侧靠 env」的注释/假设，同步更新文字。
6. 新测试 `tests/worker-env.test.ts`：
   - `buildWorkerEnv` 只输出白名单键；
   - 输入含密钥名的控制变量也**不会**混入（显式断言 `COLT_PROVIDER_KEY`/`DEEPSEEK_API_KEY`
     不在输出里）；
   - 白名单键在宿主机缺失时不产生 `undefined` 值。
7. 更新 `tests/` 里现有的 init 命令构造处（搜 `init` 命令字面量/夹具，全部补 `apiKey`
   字段——契约改了类型，typecheck 会把它们全逼出来，跟着编译错误逐个改即可）。

### B.5 验收

```bash
npm run typecheck && npm test
```

手动验证（dev）：起一个会话，让模型执行 `env | findstr /I "KEY"`（Windows），
应无任何密钥；再发一条真实请求确认模型调用正常（说明内存密钥链路通了）。

### B.6 雷区

- **不要改 `node_modules`**。所有改道都在应用层完成。
- 占位符 `KEYLESS_PLACEHOLDER` 不是 bug 是特性：本地无密钥服务仍需要非空 apiKey。
  「修好」它（比如允许空串）会打破 openai-completions 层的校验，别动。
- 白名单宁可漏加后补，也不要为了省事保留 `...process.env`——那是本包要消灭的东西。
- 改动期间 `deepseekProvider` 与 `createProvider` 的返回类型差异已在
  `buildProvider` 现签名（`ReturnType<typeof deepseekProvider>`）里处理过，
  保持这个出口类型兼容手法，别把类型炸开。
- 排查顺序铁律：若验收时模型调不通，先查 worker 是否拿到 apiKey（打日志位置：
  init 处理入口，验完删），再查 provider 装配，最后才怀疑内核。

---

## 工作包 C：模型路由（子代理按定义选模型 + 审批分析器独立模型）

> 依赖 B 建立的「密钥只走内存、可按需向主进程取」的模式。**B 没合入前不要开工 C。**

### C.1 目标

1. 子代理定义（`.md` frontmatter）支持 `model:` 字段，spawn 子代理时用指定模型建 lane；
   不填 = 沿用会话模型（现状语义）。
2. 审批分析器（`#analyzeThenReply`）支持在设置里指定专用 modelRef，缺省 = 会话模型。

### C.2 现状证据（已核实，含行号）

- 子代理定义解析：`src/worker/lib/agent-defs.ts` 的 `parseAgentFile` 是极简手写解析器，
  只认 `description` / `tools` 两个 key（第 89-107 行）。`AgentDef` 接口在 38-53 行。
  内置两个定义在 130/141 行。
- 子代理建 lane：`src/worker/lib/subagent.ts` `#spawn`（532-592 行附近）：
  第 561 行 `harness.lane(id, { createAt: null }, context)`，第 564 行
  `lane.setActiveTools(allowed, context)`。**加模型就插在这两行附近**：
  内核 `AgentLane.setModel({ provider, modelId }, context)` 存在
  （`agent-harness.d.ts` 可查签名，动手前先 `Grep "setModel" node_modules/@earendil-works/pi-agent-core/dist` 确认参数形状）。
- modelRef 解析已有轮子：`src/shared/model-ref.ts` 的 `splitModelRef` / `findModelRef`
  解析 `"providerId/modelId"` 格式，直接复用。
- 审批分析器用模型处：`src/main/session-manager.ts` `#analyzeThenReply`（429 行起）
  用 `entry.provider` / `entry.modelId`——即「跟会话同一个模型」。
- 设置存取范式：`src/main/approval/config.ts` 的 allowlist 读写 + `approval.analyzeConfig.get/set`
  IPC 对（在 `src/shared/protocol.ts` 登记），照抄这个模式加新设置项。
- worker 的 `models` 注册表现状：`src/worker/entry.ts` init 只注册会话当前 provider
  （`models.setProvider(buildProvider(providerConfig))`）。要切到**别的** provider，
  需要它的配置与密钥——这就是本包的主要工作量。

### C.3 设计决策（已定）

1. **`model:` 字段格式** = modelRef 字符串 `"providerId/modelId"`，与
   `src/shared/model-ref.ts` 对齐。缺省 / 省略 = 会话模型。解析失败 = 定义加载失败，
   走 `parseAgentFile` 现有的 `{ ok: false, reason }` 通道（别静默忽略）。
2. **provider 目录下发**：`WorkerCommand.init` 加 `providers: ProviderDirectoryEntry[]`
   ——全部 provider 的**非密钥**配置（id、kind、baseURL、模型清单等，就是主进程
   providers 目录里已有的结构，**绝不含 apiKey**）。worker 侧把它存成内存目录。
3. **密钥按需取**：子代理 spawn 时若目标 provider ≠ 当前 provider，经 HostBridge 调一条
   **新 host 能力** `"providerKey"`（`HostCapability` 联合加这个成员，
   `src/shared/worker-protocol.ts:426`），参数 `{ providerId }`，主进程从 secrets 读密钥
   返回（仅内存传输）。主进程分发点：`src/main/host/index.ts` 的 `handle` switch，
   照 `memory` / `todo` 分支的模式加。
   - 若 provider 是无密钥本地服务，主进程返回占位符（与 B 包同一语义）。
   - worker 侧拿到后 `models.setProvider(buildProvider(entry, key))` 注册，**缓存**，
     同一会话内同 provider 只取一次。
4. **lane 模型切换**：`#spawn` 里 `setActiveTools` 之后加：
   ```ts
   if (def.model) {
     const ref = splitModelRef(def.model);           // 解析失败在 load 阶段已拦
     await ensureProviderRegistered(ref.providerId); // 需要时走 providerKey 能力取密钥
     await lane.setModel({ provider: ref.providerId, modelId: ref.modelId }, context);
   }
   ```
   具体参数形状以 `agent-harness.d.ts` 里 `setModel` 签名为准。
5. **审批分析器独立模型**：settings 表加键（如 `approval.analyzerModelRef`），
   IPC 加一对 `approval.analyzerModel.get/set`（`IPC_CHANNELS` 与 `IpcInvokeMap`
   同步加，编译期断言会盯着你）。`#analyzeThenReply` 里：
   ```ts
   const ref = settings.get("approval.analyzerModelRef");  // null = 沿用会话模型
   const { provider, modelId, apiKey } = ref ? resolveFromDirectory(ref) : { ...entry 现状 };
   ```
   分析器在主进程跑，密钥从 secrets 直接读，不经 worker。
6. **前端设置 UI 不做**。本包只做存储 + IPC + 消费；设置界面等后续单独排期
   （在计划文档里留 TODO 注释即可，别顺手画 UI——规则：不扩大范围）。

### C.4 改动清单（按依赖序）

1. `src/shared/worker-protocol.ts`：`HostCapability` 加 `"providerKey"`；
   `WorkerCommand.init` 载荷加 `providers` 字段；host 调用的请求/响应类型补全。
2. `src/main/session-manager.ts`（大户，先量）：init 命令装配处带上 provider 目录
   （数据源：主进程已有的 provider 配置目录，**过滤掉一切密钥字段**——构造一个显式的
   白名单投影函数 `toDirectoryEntry()`，别用「删掉 key 字段」的黑名单手法）。
3. `src/main/host/index.ts`：`handle` switch 加 `"providerKey"` 分支：按 providerId
   从 secrets 读密钥返回；未知 providerId 返回结构化错误。
4. `src/worker/entry.ts`：init 存 provider 目录（内存 Map）。
5. `src/worker/lib/agent-defs.ts`：`parseAgentFile` 认 `model`（可选）；`AgentDef`
   加 `model: string | null`；内置两个定义显式写 `model: null` 或省略（保持现状语义），
   文件头注释里的 frontmatter 示例补一行 `model:` 说明。
6. `src/worker/lib/subagent.ts`：`#spawn` 加 C.3-4 的逻辑 + `ensureProviderRegistered`
   帮助函数（内含 HostBridge 调用与缓存）。
7. `src/main/session-manager.ts` `#analyzeThenReply`：按 C.3-5 改模型选择；
   `src/main/approval/config.ts` 加设置项读写；`src/shared/protocol.ts` 加 IPC 对。
8. 测试：
   - `tests/agent-defs.test.ts`（若已有则追加）：`model:` 合法解析 / 非法 modelRef 报错 /
     省略时为 null；
   - 新 `tests/provider-directory.test.ts`：`toDirectoryEntry()` 投影不含密钥字段
     （断言输出对象**没有** apiKey/key 之类键，哪怕输入有）；
   - 子代理 spawn 的模型切换：worker 侧单测打桩 harness 断言 `setModel` 被以正确参数调用
     （参照现有 subagent 测试的打桩方式）；
   - 分析器 modelRef：单测覆盖「设置缺省 = 会话模型」「设置后 = 指定模型」两条。

### C.5 验收

```bash
npm run typecheck && npm test
```

手动验证（dev，需两个 provider 都配好密钥才验跨 provider）：
1. 写一个带 `model: <另一家provider>/<model>` 的子代理定义，让主代理调用它，
   观察子代理实际用指定模型应答（worker 日志 / 用量记录）；
2. 不填 `model:` 的子代理行为与之前完全一致；
3. 单 provider 用户全程无感（回归）。

### C.6 雷区

- **密钥投影必须白名单手法**：`toDirectoryEntry()` 逐个字段挑，不允许
  `{...provider, apiKey: undefined}` 这种（密钥字段会以 undefined 键名形式泄漏进
  序列化产物的风险 + 未来加字段时默认泄漏）。
- 解析器目前「不认识的 key 会报错」的行为如果有，加 `model` 后确认 `tools`/`description`
  之外的未知 key 仍然报错——别让 `modle:` 这种笔误静默生效。
- `setModel` 与 `setActiveTools` 的顺序：先注册 provider 再 setModel，setModel 在
  lane 创建后、跑之前。时序错了内核会报「provider 未注册」类错误——遇到先查注册顺序。
- HostBridge 新能力要检查审批语义：providerKey 调用**不应对用户弹审批**（它是内部
  控制通道），但也**绝不能**被模型以工具形式直接触达——确认它只经 worker 代码路径
  调用，不出现在任何工具清单里。
- 跨 provider 取密钥失败（用户没配那家 key）时，子代理 spawn 要返回结构化错误给
  主代理模型，让它换定义或报告用户，不要静默回落到会话模型——静默回落会让用户以为
  路由生效了。
- 简化备选（若工期紧）：init 时把**全部已配置密钥的 provider** 都预注册到 worker 的
  models 注册表（密钥仍只走 init 消息体），spawn 只做 setModel。这样可砍掉 HostBridge
  新能力。缺点：worker 内存常驻多份密钥。**默认不选这个**，只在 HostBridge 改造遇阻时
  作为降级方案，且要在 PR 里写明取舍。

### C.6 补记：本包会踩的**用量归属**坑（实施时发现，已修）

计划 C.5 建议用「用量记录」验证路由是否生效——实施时发现**这条用法当时是坏的**，
且根因正是本包引入的能力：

- 内核 `UsageRow`（`harness/session/types.d.ts`）里**没有** provider/model 字段，
  用量事件按 lane 报（`event.lane`）。而 `entry.ts` 的用量处理一律传
  `modelRef: state.meta.model`（会话模型）——子代理不能换模型时这是**对的**，
  `model` 上线后就不对了：**被路由的子代理，其用量行被记成会话那一家**。
  危害是行内自相矛盾（`costUsd` 是内核按**实际**模型算的，服务名却是会话的），
  且按 provider 聚合的「哪个服务在花钱」永远不准。
- 修法：新增 `worker/lib/lane-model.ts`，订阅内核 `config_update`
  （`property: "model"`，带 `lane` 与 `{provider, modelId}`）维护 lane → 模型引用；
  用量处按 `event.lane` 取，取不到才回落会话模型（新 lane 继承默认模型、不发
  `config_update`，回落本就是对的口径）。`lane_created` **不带模型**，故不能只靠它。
- 实时验证（真实运行）：路由到 `ollama/qwen3:0.6b` 的子代理，其用量行现在记成
  `{"provider":"ollama","model":"qwen3:0.6b"}`；修复前该行会是 deepseek 却带着 ollama 的费用。

---

## 附：三包依赖关系与交付检查单

```
A（grep/glob）     独立 ──────────────────────────────┐
B（密钥改道）      独立 ────────────────┐              │
C（模型路由）      依赖 B 的内存密钥模式 ←┘              │
                                                    ↓
全部合入后：在 docs/architecture-agent-review-2026-10.md 的缺口清单里把这三条标记为已闭环
```

每包交付检查单（PR 描述里逐项打勾）：

- [ ] `npm run typecheck` 绿
- [ ] `npm test` 绿，且总数 = 基准 + 本包新增数（对不上先查）
- [ ] `tests/size-guard.test.ts` 体量闸绿（它包含在 npm test 里，红了按规则 2 处理）
- [ ] 无调试残留（console.log / title 标记 / 打印 env 的临时代码已删）
- [ ] 契约改动（若有）两侧同步：IPC_CHANNELS ↔ IpcInvokeMap、WorkerCommand/WorkerMessage
- [ ] 手动验证步骤已做，结果写进 PR 描述
