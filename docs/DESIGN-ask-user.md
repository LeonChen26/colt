# ask_user 设计草案

> **状态**：**已实施**（2026-09-18，三批全部落地）。单测 `tests/ask-user.test.ts` 14 条 +
> `tests/question-store.test.ts` 9 条、冒烟 `COLT_SMOKE_MODE=ask-user` 23 条，
> 以及**打模型**的 `COLT_SMOKE_MODE=ask-user-e2e` 11 条，全过；`dock` 211 条无回归。
> 属于方案 C（能力内建，不做扩展宿主层）下的第一项。
> **遗留**：worker **意外崩溃**那一支的收尾只在代码上对齐，冒烟只覆盖了主动 dispose 那条（见 §8）；
> `sessionManager` 的提问桌面通知也没有断言覆盖（见 §8）。
> worker 侧 `before_tool` 跳过 `ask_user` 的那条守卫与「全权模式下提问仍要弹」已由
> `ask-user-e2e` 覆盖（模型真的调用工具才走得到）。
> **一句话**：给模型一个「先问再做」的工具——结构化选项 + 阻塞等待，答案作为工具结果回到模型，
> 与审批闸门**并列但独立**。
> **配套**：动手前读 `docs/ARCHITECTURE.md`（加 IPC 通道 / worker 命令的流程）、
> `docs/PRINCIPLES.md`（#2 #5 #8）、`docs/SECURITY.md`、`AGENTS.md` §3.6。

---

## 1. 依据

| 来源 | 约束 |
|---|---|
| `PRINCIPLES.md` #5 授权对齐标准 | 四档语义 + 取消；等待有超时；**超时 / 取消不静默** |
| `PRINCIPLES.md` #2 永远可中断 | 中断时**清空待答队列**，不留悬空卡片（现有审批就是这么做的） |
| `PRINCIPLES.md` #8 自动行为不抢焦 | 卡片出现在会话流里，不弹窗抢焦点；窗口不在前台时可请求注意 |
| `AGENTS.md` §3.6 | 入口只列**真的存在**的能力——按钮点了必须有可见反馈，否则宁可不放 |
| `AGENTS.md` §四 | **别按字段名猜语义**；外部依赖的字段先读定义与写入点 |
| 参考实现 | `rpiv-ask-user-question@2.10.1`（MIT，源码在 `.workbuddy/pi-ext-review/`）：类型化问卷 + 校验器 + TUI 组件 + 6 国 i18n。**只抄它的 schema 与校验思路**，i18n 与 TUI 层在本产品无对应物 |

---

## 2. 现状（代码实测，不是推测）

| 事实 | 位置 |
|---|---|
| 工具注册 = `AgentHarness.create({ tools: [...] })` 数组里加一项 | `worker/entry.ts:505` |
| 自研工具是「薄封装 + HostBridge」范式 | `worker/lib/memory-tool.ts`（34 行，可照抄形态） |
| 审批闸门：`before_tool` 里 `await requestApproval(...)`，阻塞整条 lane | `worker/entry.ts:540`、`entry.ts:136` |
| **`requestApproval` 的返回只有 `{ approved, reason }`，没有载荷** | `worker/entry.ts:138-140` |
| 超时上限 `APPROVAL_TIMEOUT_MS = 5 分钟`，main/worker 共用，**写死第二份会静默挂死**，由 `tests/limits.test.ts` 守卫 | `shared/limits.ts:23` |
| 审批三模式：`approval` / `auto` / `full-access` | `main/approval/policy.ts:465` |
| 授权卡四档：允许一次 / 本会话内始终允许 / 拒绝一次 / 始终拒绝 | `renderer/.../ApprovalCard.tsx:117-155` |

---

## 3. 关键决策：**不复用审批通道，新开一条**

这是本设计唯一的结构性决定，三条理由逐条对应代码事实：

1. **`auto` / `full-access` 模式会把提问「自动批准」**（`policy.ts:471` 全放、
   `:492` moderate 自动放行）。审批的默认值是「放行」，而提问的默认值必须是「没答案」——
   一旦走审批通道，用户切到全权模式后，模型的每一次提问都会被静默地「批准」，
   模型收到的是「已通过」而不是答案。**这是比没有提问工具更糟的失败**：它会持续撒谎。
2. **`approvalResult` 没有载荷字段**（`worker-protocol.ts:227` 只有 `approved` / `reason`）。
   答案必须原样回到模型，为它加字段等于把「审批」和「问卷」两件事的协议焊在一起。
3. **四档语义对提问无意义**。复用 `ApprovalCard` 就会出现「始终允许 ask_user」这种按钮——
   点下去等于永久静默所有提问，是 `AGENTS.md` §3.6 说的死控件。

**代价**：多一对消息类型 + 一套 pending 表 + 一个渲染组件。相比上面三条，值得。

---

## 4. 契约变更（`shared/worker-protocol.ts`）

```ts
// worker → main：模型提问，worker 已阻塞在工具 execute 里
| {
    type: "askUserRequest";
    toolCallId: string;
    /** 已校验过的问卷（校验在 worker 侧做，主进程不信任、但也不重复校验） */
    questions: AskUserQuestion[];
    timeoutMs: number;
  }

// main → worker：用户答复；skipped 表示没拿到答案，三档必须分得清
| { type: "askUserResult"; toolCallId: string; answers?: Record<string, string>; skipped?: AskUserSkipReason }

// AskUserSkipReason = "timeout" | "skipped" | "cancelled"
//   超时 / 用户点「跳过」/ 会话被中断——把前两者说成「已中断」就是撒谎：
//   模型会以为整轮对话没了，而实际上它应该按假设继续
```

```ts
export interface AskUserQuestion {
  /** 问题正文 */
  question: string;
  /** 短标签（≤12 字符），多题时作为分组标题 */
  header?: string;
  /** 2~4 个选项 */
  options: { label: string; description: string }[];
  multiSelect?: boolean;
}
```

渲染层通道按 `ARCHITECTURE.md` §A 加：`userquestion.pending`（事件，对齐 `approval.pending`）、
`userquestion.answer`（invoke，对齐 `approval.resolve`）。

---

## 5. 工具定义（`worker/lib/ask-user-tool.ts`）

- **命名** `ask_user`（与 `memory_search` / `browser_act` 同一 snake_case）
- **入参**（typebox，照 `memory-tool.ts` 的写法）：`questions` 数组
- **校验放在 worker**：题目数 1~4、每题选项 2~4、`header` ≤12 字符、问题正文与选项 label 各自唯一、
  `multiSelect` 时答案用顿号分隔。失败文案必须把**正确写法**说清楚（对齐 `@shared/skill-error` 的口径
  「打错时必须给回正确写法」）
- **校验失败走 `throw`，不是回一条工具错误文本**（实施时按内核能力定的）：内核的
  `AgentToolResult` 没有 `isError` 字段，只有抛出才能把这次调用标成错误——返回文本会被当成
  「工具成功返回了一段话」，模型不会意识到自己发错了参数，也就不会改对重发（见 `ask-user-tool.ts` 注释）
- **execute**：`send({ type: "askUserRequest", ... })` → `await` 答复 → 返回
  `{ content: [{ type: "text", text: 格式化后的答案 }] }`
- **四条回落文案**（都必须是「有信息」而不是「失败」，且彼此分得清）：
  - 超时：`用户未在限定时间内回答这次提问。请按你认为最合理的方案继续，并在开头明确说明你所做的假设…`
  - 用户点「跳过」：`用户跳过了这次提问，没有作答（对话仍在继续）。…说明假设…`
  - 会话中断：`对话已被中断，这次提问没有作答。`
  - 异常：走 `docs/ERRORS.md` 的口径——真实原因 + 建议动作，不透传原始报错
- **不进 `READONLY_TOOLS`**：它不是「无副作用」，只是不受审批策略管辖。**必须在 `before_tool`
  里显式跳过它**（否则每个提问都会被当成待审工具，弹出一张四个按钮都不对劲的卡）

---

## 6. 渲染层：`QuestionCard`

复用 `ApprovalCard` 的**骨架与倒计时机制**（`requestedAt + timeoutMs - now` 逐秒回退），
替换内容区与按钮区：

| ApprovalCard | QuestionCard |
|---|---|
| 风险档位徽标（低风险/需确认/高风险） | 「需要你决定」+ 剩余题数 |
| 摘要 + 判定依据 | 问题正文 + 每个选项一行（label + description） |
| 展开看 diff / 完整参数 | **不展开**（没有参数可看；展开就是死交互） |
| 四档按钮 | 每题一组选项按钮（单选 / 多选）+ 底部「提交」「跳过」 |

- 多题**一屏列出**，全部作答后一次提交（与参考实现一致）
- 跳过 = 明确的不回答，不是失败
- **卡片只活在「待答」期间**：落定（作答 / 跳过 / 超时 / 中断）后立即消失，结果由紧跟着的
  `ask_user` 工具结果承载（用户与模型看到的是同一句话）。原先设想「留一张写『已跳过』的卡」——
  那张卡的寿命没有定义（留到什么时候？切会话怎么办？），只会变成过期的悬空块
- 窗口不在前台时，沿用 `approval` 现成的「请求注意」机制（闪任务栏 + 通知），**不抢焦点**

---

## 7. 分批实施（均已落地）

1. **契约 + worker 工具 + 主进程转发**（无 UI）：`shared/worker-protocol.ts` 的
   `askUserRequest` / `askUserResult`、`worker/lib/ask-user-tool.ts`、`main/question-store.ts`
2. **渲染层 `QuestionCard`**：`renderer/src/features/Conversation/QuestionCard.tsx`，
   订阅与处置抽在 `useBlockingCards.ts`（那个文件有体量闸与 hook 数守卫，自定义 hook 是它鼓励的方向）
3. **冒烟断言**：**新开了 `src/dev/smoke/modes/ask-user.ts` 而不是往 `dock.ts` 里塞**
   （dock 已 2281 行；提问链路与右栏无关，独立模式更好定位）
4. **收口补强**（2026-09-18 评审后）：`tests/question-store.test.ts`（9 条，含
   「同一条重复入队不会把新记录判成超时」的回归）；worker 消失时**与审批对称地**清空提问队列
   （`session-manager.ts` 崩溃分支与 `#disposeWorker` 各一处 `cancelAll`）；冒烟补第 7 段
   （worker 被回收后不留幽灵卡）

> 为什么不在第 1 批就接 UI：这条链路的失败模式是**静默**（提问无人回答、或者被自动批准），
> 先在没有 UI 干扰时把「工具阻塞 → 收到答案 → 模型继续」这一段验掉，比一次做完更容易定位。

---

## 8. 验收（已执行）

**单测** `tests/ask-user.test.ts`（14 条）：问卷校验纯函数（题目数 / 选项数 / header 长度 /
重复 label / **重复的问题正文**）、**三档**回落文案彼此分得清、答案格式化。
另 `tests/question-store.test.ts`（9 条）：主进程侧队列的生命周期——入队推全量、作答 / 跳过 /
超时 / 中断各自回发的档位、**不在队列里的条目不再回发**、重复入队时旧定时器被撤。

**冒烟** `COLT_SMOKE=ask-user.png COLT_SMOKE_MODE=ask-user npm run dev`（`src/dev/smoke/modes/ask-user.ts`，23 条）：
提问走**产品里同一条路**——`sessionManager.questions.enqueue(...)` 就是 worker 发来
`askUserRequest` 时主进程调用的那个函数；作答载荷用主进程打桩读回（同 dock 的 `/compact` 那套），
不去猜渲染层发了什么。断言不依赖 class，用 `data-question-*` 钩子（同 `data-conv-attach-notice` 的用法）：

- 卡片真的出现在会话流里，列出全部选项，且写的是**问题**而不是审批文案
- 选项是活的（点了 `aria-pressed` 真的变），未答完时「提交」不可点
- 提交后主进程收到的载荷：**键 = 问题原文，值 = 所选 label**；多选以「、」相连
- 卡片**没有**「始终允许」（那等于永久静默提问，是死控件）
- 跳过走 `skipped` 这一档（**不是** `cancelled`）；超时后卡片收起、队列清空
- `full-access` 下提问照样弹卡；中断后卡片清掉、不留悬空卡
- **worker 被回收后卡片清掉、队列清空**（与审批对称——审批早就清了，提问原先漏了）

**打模型的端到端** `COLT_SMOKE=ask-user-e2e.png COLT_SMOKE_MODE=ask-user-e2e npm run dev`
（`src/dev/smoke/modes/ask-user-e2e.ts`，11 条，**计费**）：上面的免费模式从
`sessionManager.questions.enqueue()` **直接入队**，验的是入队之后的一切；**入队之前**那段
只有真模型能走到。它把 worker 的生死交给渲染层（同 `memory-e2e`：`window.reload()` 等它
自动打开夹具会话、worker 就绪），然后在 `full-access` 下让模型自己发起提问，断言：

- 模型真的看见并调用了 `ask_user`（问卷进了待答队列，且内容与 prompt 点名的一致）
- 提问**没有**流进审批通道（`approvals.listPending` 为空）——这就是「不复用审批通道」的物证，
  也是 `full-access` 下最贵的失败场景（一旦并进审批，模型收到的是「已通过」而不是答案）
- 问卷过了 worker 侧校验、作答后出队
- 答案作为 `ask_user` 的工具结果回到模型（含「用户已回答」与所选 label），
  且模型**接着往下做**（本轮 `completed`、给出新助手消息、复述所选项）

**尚未覆盖（写明，免得被当成验过了）**：上一条断言走的是**主动 dispose**（`sessionManager.close`）；
**意外崩溃**那一支（未标 `disposeReason` 就退出）没被覆盖，它的清理是同一处写法的另一份拷贝：
两处都要保留 `cancelAll`，评测时按「审批清了几处、提问就清几处」对照。
`sessionManager` 的提问桌面通知（`notifyQuestion`）也只在代码上接线、没有断言覆盖。
全权模式下「提问仍要弹」现在有两层凭证：`ask-user-e2e` 的**真实模型**往返（行为层），
以及界面层的免费 `ask-user` 断言；底层依据是提问根本没走审批通道
（`question-store.ts` 里没有任何 policy 调用），再加 `tests/ask-user.test.ts` 钉住
「`ask_user` 不进 `READONLY_TOOLS`」——防止有人把它「顺手并进只读白名单」，
那会让审批策略再次拿到静默批准它的机会。

---

## 9. 明确不做

- 多轮追问链（问完再问）——一轮一问，够用再看
- i18n（参考实现有 6 国语言，本产品界面无 i18n 机制）
- 自由输入富文本：第一版给「跳过 + 选项」两条出路；**自由输入是否要做，等第一版用起来再定**
- 把答案写进记忆 / 沉淀到 AGENTS.md
- 提问卡进右栏 ⑦：它是一次交互，落在会话流里，不占工作区页签
