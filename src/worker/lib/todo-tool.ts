// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `todo` 工具：模型自己的账本。
 *
 * 与其它自研工具同款形态——worker 侧**薄封装**，真正的状态机与写入在主进程
 * （`main/todo-store.ts`，经 `HostBridge.call("todo", action, params)`）。
 *
 * 免审批：名字已在 `READONLY_TOOLS` 里 → `policy.ts` 自动放行，`after_tool` 的
 * 「未经闸门即执行」纵深防御也自动豁免。故**不需要**在 `before_tool` 里写特例——
 * 这是它与 `ask_user` 相反的地方（`ask_user` 必须显式跳过，因为名字不在白名单里）。
 * 白名单的判据是「不对**用户工作区**产生副作用」，本工具会写库但参数里没有任何路径
 * （见 `shared/readonly-tools.ts` 与 `docs/SECURITY.md`）。
 *
 * ⚠️ `description` 是本仓**唯一的引导落点**：内核的 `AgentTool` 没有
 * `promptSnippet` / `promptGuidelines`（实测，见 `docs/ARCHITECTURE.md` §四），
 * 所以「什么时候该开清单、什么时候不许标完成」这些规矩只能写在这里。
 */
import { Type } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import {
  MAX_ACTIVE_FORM_CHARS,
  MAX_BLOCKED_BY,
  MAX_SUBJECT_CHARS,
  MAX_TODOS,
  TODO_TOOL_NAME,
} from "@shared/todo";
import { definedParams, hostResultToContent, type HostBridge } from "./host-bridge";

const statusSchema = Type.Union(
  [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
  { description: "目标状态。只允许 pending → in_progress → completed；已完成要重开先标回 pending" },
);

const todoSchema = Type.Object({
  // 动作集合与校验侧同源（`shared/todo.ts` 的 TODO_ACTIONS）
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("list"),
      Type.Literal("delete"),
      Type.Literal("clear"),
    ],
    { description: "create 新建 / update 改状态或内容 / list 看全量 / delete 删 / clear 清空" },
  ),
  subject: Type.Optional(
    Type.String({ description: `祈使句，一句话说清要做什么（≤${MAX_SUBJECT_CHARS} 字符）。create 必填` }),
  ),
  activeForm: Type.Optional(
    Type.String({
      description: `进行中时的动名词（如「正在写 todo-store」），≤${MAX_ACTIVE_FORM_CHARS} 字符`,
    }),
  ),
  id: Type.Optional(Type.String({ description: "条目 id（update 必填；list 会给出全部 id）" })),
  status: Type.Optional(statusSchema),
  blockedBy: Type.Optional(
    Type.Array(Type.String(), {
      description: `依赖的条目 id（≤${MAX_BLOCKED_BY} 项）。被依赖项未完成时本项不可标 in_progress`,
    }),
  ),
  ids: Type.Optional(Type.Array(Type.String(), { description: "要删除的条目 id（delete 必填）" })),
});

export function createTodoTools(bridge: HostBridge): AgentHarnessTool<ExecutionToolContext>[] {
  const todo: AgentHarnessTool<ExecutionToolContext, typeof todoSchema, undefined> = {
    name: TODO_TOOL_NAME,
    label: "Todo",
    description:
      "维护本次任务的待办清单（跨请求持久，界面右栏也能看到）。" +
      "何时用：任务**能拆成 3 步以上**、或用户给了多条要求要逐条推进时——先把清单列出来，" +
      "再一条条做，你和用户都能看出进行到哪。何时不用：一两步就能做完的小事，直接做更快" +
      "（列了还要维护，反而拖慢）。" +
      "使用规矩：① 开工前把当前要做的那条标 in_progress（同时只允许一条，新的开工会让上一条自动退回待办）；" +
      "② **完成一条立即标 completed，不要批量补标**——攒到最后一起标，界面上的进度是假的；" +
      "③ 还有测试红着、或有未解决的报错时，不许把它标成 completed；" +
      "④ 任务有先后依赖时用 blockedBy 声明（被依赖项没完成就不能标 in_progress）；" +
      `⑤ 清单保持精炼，最多 ${MAX_TODOS} 项，做完的及时用 delete / clear 收掉。` +
      "调用要点：create 给 subject（可选 activeForm / blockedBy）；update 给 id（可带 status / subject / " +
      "activeForm / blockedBy）；delete 给 ids；list 与 clear 无参数。" +
      "每次调用都会返回**整份清单**，不需要自己拼接；参数不合法时你会收到一条报错与正确写法，照着改即可。",
    parameters: todoSchema,
    async execute(_toolCallId, params) {
      // 校验与写入都在主进程（它才是唯一写入方）；参数不合法时它是**抛错**，
      // 于是这里的 await 直接抛出去，内核把这次调用标成 isError——
      // 模型因此能明确看到「这次失败了」并按报错里的正确写法重发（同 ask_user）。
      const result = await bridge.call(
        "todo",
        params.action,
        definedParams(params as unknown as Record<string, unknown>),
      );
      return { content: hostResultToContent(result), details: undefined };
    },
  };
  return [todo];
}
