# 写后诊断设计（⑥，after-write diagnostics）

> 状态：**已实施**（2026-10-11；D2「免审批、窄通道」与 D3「快慢分治全量」均经用户拍板）。
> 触发词：能力补齐进度表（`NEXT-PHASE.md` §3.2）的 ⑥；「写后诊断」。

## 1. 关键事实（代码实测，不是推测）

1. 内核 `after_tool` 钩子**可以改写工具结果**：handler 返回
   `{ content?, details?, isError?, usage?, terminate? } | undefined`
   （`pi-agent-core/dist/harness/agent-harness.d.ts` L574–581）。返回 `undefined` 即不干预
   ——`entry.ts` 现有三个 `after_tool` 都是这么用的。诊断结论追加进 `content`，模型当轮可见。
2. 执行原语与 bash 工具**同源**：worker 手里的 `NodeExecutionEnv.exec(command, { cwd, timeout, capture }, context)`
   （`pi-agent-core/dist/harness/env/nodejs.d.ts` L15），超时以秒计、输出经 capture 有界。
   诊断 runner 不需要任何新进程机制。
3. **审批闸门看不见 after_tool 内部的行为**：闸门只挂在 `before_tool`（`entry.ts` L431），
   工具执行完的钩子里再 spawn 子进程，policy 层没有任何介入点。所以「要不要过审批」的实质
   不是「把检查加进白名单」，而是「在闸门之下**另开一条免审执行通道**」——论证必须自己站住
   （见 D2）。
4. 「下一次模型请求前注入、不进 transcript」的通道**已经存在**：`pendingEphemeralNotices`
   （`entry.ts` L142，transform_context 消费、仅主 lane）。慢检查的异步结果可以直接用它，
   不需要新机制。
5. `write` / `edit` 的入参 `path` 由模型给出、实测常为绝对路径；越界校验已有成熟做法
   （`main/lib/path-guard.ts` 的 `isWithinRoot`，worker 侧 `captureBaseline` 同款场景）。

## 2. 关键决策

### D1 触发点：`after_tool`，只认「写成功」

仅 `toolName ∈ {write, edit}` 且 `event.isError === false` 且路径经校验在项目内时触发。
写入失败（审批被拒、路径越界、内核报错）不诊断——没有成功落盘的内容可诊断，
对失败结果追加诊断只会混淆「写失败」与「写出来的东西有问题」两件事。

### D2 审批：免审批，但通道必须窄（**待拍板**）

检查命令**全部由应用按检查器表构造**，模型唯一的输入是 `path`（且经项目内校验）。
免审批论证三条：

1. **命令不是模型给的**——模型给不出命令，只给得出文件名；命令模板在检查器表里写死。
2. **检查类命令对用户工作区无写副作用**——eslint / ruff check / tsc --noEmit 只读；
   cargo check 写 `target/`、go vet 可能写构建缓存，属**项目内派生物**，与 `todo`
   免审批的论证同族（写的是应用/工具自有的数据，不是用户的工作区语义）。
3. **资源受控**——每条命令带超时与输出上限，超时即放弃并如实报告（不重试不静默）。

反面（为什么不走审批）：写文件是高频动作，每次写完弹一张「要跑检查吗」卡，
功能即刻变成噪声；而 auto 模式下分析器照样要花一次模型调用裁决 `tsc --noEmit`——
为一条固定模板命令花一次 LLM 调用，纯浪费。

UI 可见性兜底：诊断跑了什么、结果如何，追加在工具输出里、工具卡展开即可见——
用户永远能回答「刚才到底执行了什么」。

### D3 快慢分治（**待拍板，含 v1 收窄选项**）

检查器按耗时天然分两档，同步异步各得其所：

- **文件级快检查**（eslint 单文件 / ruff check 单文件，亚秒级）：在 `after_tool` 里
  **同步**执行，结果**追加进当次 write/edit 的工具结果**——模型当轮看见、当轮修。
- **全仓慢检查**（tsc --noEmit / go vet / cargo check，秒级到分钟级）：**绝不同步跑**
  ——连续写 10 个文件跑 10 次全仓 tsc 不可接受。走**防抖**：写入后静默 2s 才执行
  （期间新写入重置计时），后台跑完把结论压进 `pendingEphemeralNotices`，
  模型下一次请求前看到。

**v1 收窄选项**：只做文件级快检查（eslint / ruff），慢检查整档砍掉。
代价是「写完 TS 不知道有没有类型错误」——类型错误恰是写后诊断最有价值的信号，
所以默认建议 D3 全量（快+慢），但若想先把链路跑通，收窄版实现减半。

### D4 呈现：追加文本段，不加新 UI

- 模型：write/edit 结果尾部追加「写后诊断」段——有问题逐条列（检查器 / 文件 / 行号 / 摘要），
  无问题一句话带过。
- `isError` **不因诊断改写**：诊断发现问题 ≠ 写入失败，改写会让工具卡红掉、误导用户与统计。
- 检查器本身失败（没装、超时、崩了）：追加一行「诊断跳过：<原因>」，**永不静默**——
  沉默的跳过会让模型误以为「检查过了，没问题」（`docs/ERRORS.md` 的失败可见原则）。
- 用户：同一段文本随工具卡展开自然可见，零新增界面。

### D5 开关：设置页全局开关，默认开

检查慢或吵的项目要有退路。存 `settings` 表（复用分析器白名单
`main/approval/config.ts` 那条通道），设置页加一节。

### D6 检查器表（唯一真源，纯函数）

| 文件类型 | 检查器 | 命令模板（项目根执行） | 前置标记（缺 = 跳过） | 档 |
|---|---|---|---|---|
| `.ts/.tsx/.mts/.cts` | tsc | `npx tsc --noEmit` | 项目根有 `tsconfig.json` | 慢 |
| `.ts/.tsx/.mts/.cts` | eslint | `npx eslint <file>` | 有 `eslint.config.*` 或 `.eslintrc*` | 快 |
| `.py` | ruff | `ruff check <file>` | 有 `ruff.toml` 或 `pyproject.toml` 含 `[tool.ruff]` | 快 |
| `.go` | go vet | `go vet ./...` | 有 `go.mod` | 慢 |
| `.rs` | cargo check | `cargo check` | 有 `Cargo.toml` | 慢 |

前置标记探测结果按项目根缓存（worker 生命周期一份），不每次写盘探测。

## 3. 落点（体量闸纪律：新逻辑进新文件，`entry.ts` 只留接线）

| 文件 | 职责 | 可测性 |
|---|---|---|
| `worker/lib/diagnose-config.ts` | 检查器表、按路径挑检查器、命令构造、前置标记探测 | 纯函数，单测 |
| `worker/lib/diagnose-run.ts` | exec 封装（超时 / 截断 / 退出码归一）+ 慢检查防抖器 | 防抖器纯逻辑单测 |
| `worker/lib/diagnose-format.ts` | 结果 → 追加文本段（含「诊断跳过」行） | 纯函数，单测 |
| `entry.ts` | after_tool 接线 + 防抖器实例 + dispose 清理（≤ 20 行） | — |
| `main/approval/config.ts` + 设置页 | D5 开关（照抄分析器白名单的通道） | 既有模式 |
| `tests/afterwrite-diagnose.test.ts` | 上表纯函数 + 防抖 + 格式化 | — |

## 4. 验收

1. 静态：`typecheck` + `test`（全量绿）+ `build`——**实施时实测全绿**（单测 1342 条，其中本模块新增 27 条，见 `tests/afterwrite-diagnose.test.ts`）。
2. 冒烟：工具执行需真实模型发起，**免模型冒烟覆盖不了执行侧**；执行链路由单测
   （编排函数以注入的 exec 假实现驱动）钉住，真实模型 e2e 后置（同 todo-e2e 的待遇，
   不与实施捆绑）。
3. 手工验收一条（未跑，留待日常使用中观察）：在本仓改一个 `.ts` 文件故意写错类型 → 工具卡展开能看到
   tsc 报错（慢检查 2s 防抖后）；eslint 单文件结论当轮追加。

## 5. 明确不做

- **不自动修**——诊断只报告，修复永远由模型或用户决定（自动修 = 写文件的写文件，递归口子）。
- 不做诊断结果落库 / 历史回看——工具输出已在会话流里。
- 不做「检查器表用户自定义」——内置表够用再说；真要扩展走 MCP（现成通道，用户自配）。
- 不诊断非 write/edit 路径的改动（bash 里 `echo >` 改的文件管不了，如实接受——
  bash 本身有审批把关，与免审批通道不冲突）。
