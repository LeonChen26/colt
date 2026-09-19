// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能与 harness / 设置页之间的**接线**，四件事一处：
 *  1. `createSkillsRuntime`——装载一次并给出「可变清单 + 设置页宿主」，入口只持有它；
 *  2. `runSkillCommand`——显式 `/skill <名字>` 的判定与投递（原先是 `entry.ts` 的 `case "skill"`）；
 *  3. `handleSkillsCommand`——设置页那三个命令（查现状 / 重新扫描 / 禁用启用）的落点；
 *  4. `dispatchSkills`——入口那四条技能命令的共同出口（把 `send` 留在入口、判定留在这里）。
 *
 * 为什么单独成文件：worker 入口有体量闸（`AGENTS.md` §1.4），这些逻辑各要 3~5 个依赖
 * （lane / harness / 装载容器 / 重扫回调），塞进入口既长又难读；它们本身都是机械的
 * 「取 → 判 → 写回」，自成一体（同 `mcp-reload.ts` 的理由）。
 */
import type {
  AgentHarness,
  AgentLane,
  Context,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { describeSkillError, disabledSkillMessage, unknownSkillMessage } from "@shared/skill-error";
import { setSkillDisabled as writeSkillDisabled } from "@shared/skills-config";
import type { SkillsStatus, ViewSkill, WorkerCommand, WorkerMessage } from "@shared/worker-protocol";
import {
  describeSkillWarnings,
  modelSkills,
  skillWarningParts,
  toSkillDetails,
  toViewSkills,
  type LoadedSkills,
} from "./skills";

/** 没有活会话时的空现状：`live: false`（清单为空 ≠ 没装，见 `SkillsStatus`） */
export const EMPTY_SKILLS_STATUS: SkillsStatus = { skills: [], warnings: [], live: false };

/**
 * 显式技能调用的判定与投递。返回**要报的错误文案**（无错时 `undefined`），由入口决定怎么发
 * ——本模块不认识 `send`，只做「判 + 调内核」这件纯事，便于单测。
 *
 * 先按**本会话装到的清单**自查一遍再交给内核：内核的 `UnknownSkill` 只带名字、不带候选，
 * 而技能名是用户自己在磁盘上定的——打错时必须把可用名一起给出来，否则用户无从修正。
 * 渲染层有一份同样的清单（`ConversationView.skills`）会先拦一次，这里是**兜底**：
 * 渲染层不知道清单时（无 worker / 还没上报）或有人直接调 IPC 时，这条负责说同一句话。
 */
export async function runSkillCommand(
  lane: AgentLane,
  skills: readonly ViewSkill[],
  command: { name: string; instructions?: string | undefined },
  context: Context,
): Promise<string | undefined> {
  const target = skills.find((item) => item.name === command.name);
  if (target === undefined) {
    // 候选里**只列可调用的**：把被禁用的名字当候选给出来，用户照着敲还是会被拒
    return unknownSkillMessage(
      command.name,
      skills.filter((item) => !item.disabled).map((item) => item.name),
    );
  }
  // 被禁用的技能**不是「未知」**——用户自己关的，就该明说是他关的、去哪开回来。
  // （说成「未知技能」会让人以为名字打错了，而名字恰恰是他刚关掉的那个。）
  if (target.disabled) {
    return disabledSkillMessage(command.name);
  }
  const result = await lane.skill(command.name, command.instructions, context);
  // 内核的技能调用失败**走 `Result.err` 而不是抛异常**，不查返回值就是「敲了没反应」。
  // （对照 prompt 不查：那一条的失败由视图里的 `lastRun` 终态体现；而 LaneBusy /
  //   Closed / UnknownSkill 只走这条路，不查就静默。）
  return result.ok ? undefined : describeSkillError(result.error);
}

/**
 * 设置页「技能」分区的宿主：入口把可变容器与几个回调交进来，本模块只做机械编排。
 *
 * `skillsRef` 之所以是**可变容器**（而不是直接传一份 `LoadedSkills`）：重扫要就地替换清单，
 * 而每请求拼系统提示词的钩子读的是**同一个容器**——换掉它，下一次请求立刻看到新清单。
 *
 * `harness` 是**惰性取值**：它比技能容器晚建好（装载在 `AgentHarness.create` 之前），
 * 而只有重扫用到它。
 */
export interface SkillsHost {
  skillsRef: { current: LoadedSkills };
  harness: () => AgentHarness<ExecutionToolContext> | undefined;
  /** 重新扫盘并去重（入口提供：它才握着 executionEnv / cwd / homedir） */
  reload: () => Promise<LoadedSkills>;
  /**
   * 工作目录（项目根）。禁用偏好**只写项目级** `<cwd>/.colt/skills.json`——这份配置的读者
   * 就是这个模块的装载路径，读写同一处才不会出现两套口径。
   */
  cwd: string;
  /** 清单变了的写回（更新视图清单 + 报事件 + 推视图），由入口注入 */
  applyRescan: () => void;
}

/** 技能运行期：一份可变清单 + 一个设置页宿主。入口只持有它，不直接碰内部状态。 */
export interface SkillsRuntime {
  ref: { current: LoadedSkills };
  host: SkillsHost;
  /** 随视图下发的那份（与 `state.meta.skills` 同源） */
  view: () => ViewSkill[];
  /**
   * 把一件技能命令**串到队尾**执行（返回它自己的结果）。
   *
   * 为什么必须有：worker 的命令入口是 **fire-and-forget**（`entry.ts` 的
   * `void handle(command)`，没有队列），而「禁用 / 启用」对偏好文件是**读-改-写**——
   * 两次并发就在文件上打架（TOCTOU）：后写覆盖先写，**静默丢掉一条禁用**，
   * 而且回给界面的现状也可能与文件不一致。所有技能命令都从这条队走。
   */
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * 建技能运行期：装载一次，并把「清单变了要广播什么」收敛到 `publish` 一处。
 *
 * 启动时就会 `publish()` 一次（播报装载告警）——`onViewSkills` 此时是空操作（`state` 还没
 * 建好，入口那边会另设初值），但告警与「事件」页签的语义要求它**当下可见**，不能等到第一次重扫。
 */
export async function createSkillsRuntime(opts: {
  reload: () => Promise<LoadedSkills>;
  harness: () => AgentHarness<ExecutionToolContext> | undefined;
  /** 工作目录（项目根）：禁用偏好写 `<cwd>/.colt/skills.json` */
  cwd: string;
  /** 播报一条装载告警（走 notice → 「事件」页签，安全类） */
  onNotice: (message: string) => void;
  /** 把当前清单写回视图（入口里就是 `state.meta.skills`） */
  onViewSkills: (skills: ViewSkill[]) => void;
  /** 清单变了（入口里就是 `scheduleFlush`） */
  onChanged: () => void;
}): Promise<SkillsRuntime> {
  const ref: { current: LoadedSkills } = { current: await opts.reload() };
  const view = (): ViewSkill[] => toViewSkills(ref.current);
  const publish = (): void => {
    opts.onViewSkills(view());
    const notice = describeSkillWarnings(ref.current);
    if (notice !== null) opts.onNotice(notice);
    opts.onChanged();
  };
  const host: SkillsHost = {
    skillsRef: ref,
    harness: opts.harness,
    reload: opts.reload,
    cwd: opts.cwd,
    applyRescan: publish,
  };
  /**
   * 串行化器：`tail` **永不 reject**——一件失败也要放行下一件，否则一次写盘报错（比如
   * `.colt/skills.json` 坏了）会把后续所有技能命令永久卡死在队尾。
   */
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run: Promise<T> = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  publish();
  return { ref, host, view, enqueue };
}

/** 当前装载现状（只读，不扫盘） */
export function skillsStatusOf(host: SkillsHost): SkillsStatus {
  return {
    // 设置页要「查看正文」，故这里给**带全文**的详情（与随视图下发的 `ViewSkill` 不是一回事，
    // 见 `ViewSkillDetail`）。装载结果本身没被截断，用户看到的就是文件里那样。
    skills: toSkillDetails(host.skillsRef.current),
    warnings: skillWarningParts(host.skillsRef.current),
    live: true,
  };
}

/**
 * 重新装载并广播：装载 → 写回 harness 的 `resources.skills` → 替换容器 → 广播。
 *
 * `setResources` 是内核给的官方写回口（`AgentHarness` 上就有），换掉的是**按名取正文**
 * 那一份；系统提示词那份由入口的每请求钩子重拼（技能清单本来就该每请求可变），
 * 于是新技能 / 新开关**不必重启会话**即可用（报告 A2）。重扫与改开关共用这一段，
 * 免得只修好其中一条路径。
 */
async function reloadAndPublish(host: SkillsHost, context: Context): Promise<SkillsStatus> {
  const harness = host.harness();
  if (harness === undefined) throw new Error("会话尚未初始化");
  const next = await host.reload();
  // 写回内核的是**滤掉禁用、且截断过**的副本（与入口 create 时同一份口径），
  // 否则「重扫 / 改开关」会悄悄把被禁用的、或超长正文整段放回模型上下文。
  await harness.setResources({ skills: modelSkills(next) }, context);
  host.skillsRef.current = next;
  host.applyRescan();
  return skillsStatusOf(host);
}

/** 重新扫描技能目录并**热更新**（设置页「重新扫描」） */
export async function rescanSkills(host: SkillsHost, context: Context): Promise<SkillsStatus> {
  return reloadAndPublish(host, context);
}

/**
 * 改一个技能的禁用状态：**先落盘、再重新装载**。
 *
 * 顺序不能颠倒：名单是装载的输入，不重装的话开关只改了一个「没人再读」的文件，
 * 界面回的那份现状也还是旧的——那正是「点了没反应」。
 */
export async function applyDisable(
  host: SkillsHost,
  name: string,
  disabled: boolean,
  context: Context,
): Promise<SkillsStatus> {
  await writeSkillDisabled(host.cwd, name, disabled);
  return reloadAndPublish(host, context);
}

/**
 * 设置页那三个命令的落点。未就绪时（`host` 不存在或 harness 还没建好）：查现状回空、
 * 其余两个报错——**不假装成功**，否则界面会显示一份并不存在的现状。
 */
export async function handleSkillsCommand(
  command: Extract<WorkerCommand, { type: "skillsStatus" | "skillsRescan" | "skillsSetDisabled" }>,
  host: SkillsHost | undefined,
  context: Context,
): Promise<SkillsStatus> {
  if (command.type === "skillsStatus") {
    return host === undefined || host.harness() === undefined ? EMPTY_SKILLS_STATUS : skillsStatusOf(host);
  }
  if (host === undefined) throw new Error("会话尚未初始化");
  if (command.type === "skillsRescan") return reloadAndPublish(host, context);
  return applyDisable(host, command.name, command.disabled, context);
}

/** 入口四条技能命令的共同结果：要么回一条消息，要么「已投递、请补推一次终态」 */
export type SkillsDispatchResult =
  | { kind: "replied"; message: WorkerMessage }
  | { kind: "delivered" };

/**
 * 入口 `case "skill" / "skillsStatus" / "skillsRescan" / "skillsSetDisabled"` 的实现。
 *
 * 为什么把四条合成一个出口：它们共用同一份「会话未就绪怎么办」的判断，且四条都只做
 * 「取 → 判 → 回」（`AGENTS.md` §1.4 那种**一个完整往返**的搬运）。`send` 与 `pushView`
 * 仍留在入口——这里只回「该发什么」，不碰通道。
 *
 * **四条都从 `enqueue` 这条队走**：命令入口不排队，而「禁用 / 启用」是读-改-写（见
 * `SkillsRuntime.enqueue`）。顺带把「查现状」也排在队里——它读到的是同一份可变容器，
 * 排一下才能保证回给界面的是**某一时刻自洽**的现状，而不是重扫进行到一半的中间态。
 */
export async function dispatchSkills(
  command: Extract<
    WorkerCommand,
    { type: "skill" | "skillsStatus" | "skillsRescan" | "skillsSetDisabled" }
  >,
  state: { lane: AgentLane; skills: SkillsRuntime } | undefined,
  context: Context,
): Promise<SkillsDispatchResult> {
  // 会话未就绪时没有 runtime 可排队：那几条只会立刻回空现状 / 报错，串不串行无所谓
  if (state === undefined) return dispatchOne(command, undefined, context);
  return state.skills.enqueue(() => dispatchOne(command, state, context));
}

async function dispatchOne(
  command: Extract<
    WorkerCommand,
    { type: "skill" | "skillsStatus" | "skillsRescan" | "skillsSetDisabled" }
  >,
  state: { lane: AgentLane; skills: SkillsRuntime } | undefined,
  context: Context,
): Promise<SkillsDispatchResult> {
  if (command.type === "skill") {
    if (state === undefined) throw new Error("会话尚未初始化");
    const error = await runSkillCommand(state.lane, state.skills.view(), command, context);
    return error === undefined
      ? { kind: "delivered" }
      : { kind: "replied", message: { type: "error", message: error, fatal: false } };
  }
  return {
    kind: "replied",
    message: {
      type: "skillsStatus",
      status: await handleSkillsCommand(command, state?.skills.host, context),
    },
  };
}
