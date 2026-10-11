// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 每条 lane 现在跑在哪个模型上——**用量记账的口径来源**。
 *
 * ## 为什么必须有这份账
 *
 * 内核的 `UsageRow`（`harness/session/types.d.ts`）里**没有** provider/model 字段，
 * 用量事件是**按 lane** 报的（`event.lane` + `row.usage`）。于是「这条用量是哪家模型花的」
 * 这个问题，唯一能回答它的东西就是「这条 lane 此刻用的是什么模型」。
 *
 * 而 `entry.ts` 的用量处理过去一律用**会话模型**理解所有 lane。这在子代理不能换模型时
 * 是**对的**（每个子 lane 必然跑会话模型），但工作包 C 让子代理定义能写 `model:` 之后
 * 就不对了：一个被路由到便宜服务的子代理，它的用量行会被记成会话那一家。后果是
 * 那一行**自相矛盾**——`costUsd` 是内核按**实际**模型算的，于是「便宜模型的 token 数 +
 * 贵模型的服务名与费率基准」同处一行，而按 provider 聚合出的「哪个服务在花钱」永远不准。
 *
 * ## 数据源为什么是 config_update
 *
 * 内核 `lane.setModel()` 会发 `config_update`（`property: "model"`，带 `lane` 与
 * `value: { provider, modelId }`），而 `lane_created` **不带模型**。
 * 选它而不是「在每个我自己改了模型的地方各记一遍」，是因为后者靠自觉：主 lane 的
 * setModel 命令、子代理 spawn 的 setModel、将来任何新增路径，漏一处就静默记错账，
 * 而漏的那一处**不会有任何征兆**。内核事件是唯一覆盖全部改模型路径的口径。
 *
 * ## 回落语义
 *
 * 没记到就回落会话模型，**不是**编一个值——新建 lane 继承 harness 默认模型（= 会话模型）
 * 且不发 `config_update`，那种情况本来就该按会话模型记。
 *
 * ## 但「没记到」这件事本身也要收紧（lane 自报优先）
 *
 * 回落只在**真的没别的信息**时才该发生。有两条路径会让「没记到 + 会话模型已变」同时成立：
 *   ① 子代理 lane 新建后**没人给它 setModel**（定义里没写 `model:`）→ 它继承的是**创建那一刻**
 *      的会话模型，而用户完全可能在它跑着的时候切模型（`setModelOrReconnect` 允许）；
 *   ② 主 lane 恢复旧会话时沿用自己持久化的模型，未必等于 init 报的那个。
 * 两种情况都会让「回落会话模型」变成**拿现在的会话模型去解释过去的 lane**——正是本模块要修的病。
 * 故：**能直接问 lane 就别推**。`recordLaneModelFrom(lane)` 从 lane 自己的配置读（内核
 * `getModel()` 读的就是它），在 init 与子代理 spawn 各调一次，把那两条路径堵死。
 */
import type { AgentLane, Context } from "@earendil-works/pi-agent-core";

/** lane 名 → 该 lane 的模型引用（`"providerId/modelId"`，与协议同形） */
const laneModels = new Map<string, string>();

/**
 * 记账上限。子代理 lane 名带随机 id、**永不复用**，长会话里会一笔笔攒下来；
 * 条目本身很小（一个约 40 字符的串），但「无界增长」这个性质本身不该留着。
 * 与 `tool-bookkeeping` 的两张表同款处置（满了丢最早一条）。
 */
const LANE_MODEL_LIMIT = 512;

/**
 * 内核 `config_update` 事件里我们关心的那部分（只做结构收窄，不依赖内核类型）。
 *
 * `type` 也列出来：不是要读它（调用方已经按事件名订阅了），而是让**真实载荷**能直接
 * 当作参数传进来（测试里 `{ type: "config_update", … }` 这种字面量会被多余属性检查拦下，
 * 逼着测试把载荷写得不完整——那正好丢掉了「真实事件长什么样」这个前提）。
 */
export interface ConfigUpdateLike {
  type?: unknown;
  property?: unknown;
  lane?: unknown;
  value?: unknown;
}

/**
 * 记录一条 `config_update`。
 *
 * 直接把它当 `harness.events.on("config_update", …)` 的回调用（见 `entry.ts`）——
 * 这样「哪些事件该被记下来」这个判断只有一处，好测也好读。
 */
export function noteModelConfig(event: ConfigUpdateLike): void {
  // 只认 model：thinkingLevel / activeTools 也走 config_update，混进来会把账写歪
  if (event.property !== "model") return;
  if (typeof event.lane !== "string" || event.lane === "") return;
  const value = event.value as { provider?: unknown; modelId?: unknown } | null | undefined;
  const provider = typeof value?.provider === "string" ? value.provider : "";
  const modelId = typeof value?.modelId === "string" ? value.modelId : "";
  // 形状不对就**不记**：宁可回落会话模型（可能不准但自洽），也不写入一个编出来的引用
  // ——记错的值会被当成事实，而「没记到」至少是可解释的状态。
  if (provider === "" || modelId === "") return;
  rememberLaneModel(event.lane, `${provider}/${modelId}`);
}

/** 记下（或覆盖）一条 lane 的模型引用 */
export function rememberLaneModel(lane: string, modelRef: string): void {
  if (lane === "" || modelRef === "") return;
  if (!laneModels.has(lane) && laneModels.size >= LANE_MODEL_LIMIT) {
    const oldest = laneModels.keys().next().value;
    if (oldest !== undefined) laneModels.delete(oldest);
  }
  laneModels.set(lane, modelRef);
}

/** 该 lane 的模型引用；没记到（新 lane 继承了默认模型）时为 undefined，调用方回落会话模型 */
export function laneModelRef(lane: string): string | undefined {
  return laneModels.get(lane);
}

/**
 * 直接问 lane「你现在用的是什么模型」，并把答案记下来。
 *
 * 这是比回落**更可靠**的一手来源（`getModel()` 读的是 lane 自己的配置），用在两个
 * 「回落会答错」的时机：主 lane 刚恢复完（它可能沿用持久化的模型，未必等于 init 报的）、
 * 子代理 lane 刚建好（无论定义有没有写 `model:`，它此刻用的就是这里读到的那个）。
 *
 * 取不到不报错也不记：那说明 lane 读不出模型（还没配 / 已关闭），此时**没有**答案，
 * 而记一个猜的值比留空更糟（详见文件头对两条路径的说明）。
 */
export async function recordLaneModelFrom(lane: AgentLane, context: Context): Promise<void> {
  const model = await lane.getModel(context).catch(() => undefined);
  const provider = typeof model?.provider === "string" ? model.provider : "";
  const id = typeof model?.id === "string" ? model.id : "";
  if (provider === "" || id === "") return;
  rememberLaneModel(lane.name, `${provider}/${id}`);
}

/**
 * 卸掉一条 lane 的账（子代理跑完时调用）。
 *
 * **不是**为了省内存：一条 lane 的用量在它跑完时就全部产生过了（usage 行随模型请求走），
 * 之后不会再有。留着它只会让「这条 lane 还在用这个模型」这个陈述一直为真下去。
 */
export function forgetLaneModel(lane: string): void {
  laneModels.delete(lane);
}

/** 会话收口时清空（worker 进程反正要退出，清是为了不留下「跨会话的假事实」） */
export function clearLaneModels(): void {
  laneModels.clear();
}
