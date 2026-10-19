// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能与设置页之间的**接线**，三件事一处：
 *  1. `createSkillsRuntime`——装载一次并给出「可变清单 + 设置页宿主」，入口只持有它；
 *  2. `handleSkillsCommand`——设置页那三个命令（查现状 / 重新扫描 / 禁用启用）的落点；
 *  3. `reloadAndPublish`——重扫与改开关共用的一段（装载 → 替换容器 → 广播）。
 *
 * `/skill <名字>` 的投递在 durable 入口里：它走 `conversation.submit`，
 * 不再经过内核的 `lane.skill`；但「名字对不对 / 是否被禁用 / 正文包成什么」这段判定
 * 仍在本模块（`resolveSkillInvocation`），因为它与设置页共用同一份清单口径。
 *
 * 为什么单独成文件：worker 入口有体量闸（`AGENTS.md` §1.4），这些逻辑各要 3~5 个依赖
 * （装载容器 / 重扫回调），塞进入口既长又难读；它们本身都是机械的
 * 「取 → 判 → 写回」，自成一体（同 `mcp-reload.ts` 的理由）。
 */
import { setSkillDisabled as writeSkillDisabled } from "@shared/skills-config";
import { disabledSkillMessage, unknownSkillMessage } from "@shared/skill-error";
import type { SkillsStatus, ViewSkill, WorkerCommand } from "@shared/worker-protocol";
import { formatSkillInvocation } from "./skills-loader";
import {
  capSkillBodies,
  describeSkillWarnings,
  skillWarningParts,
  toSkillDetails,
  toViewSkills,
  type LoadedSkills,
} from "./skills";

/** 没有活会话时的空现状：`live: false`（清单为空 ≠ 没装，见 `SkillsStatus`） */
export const EMPTY_SKILLS_STATUS: SkillsStatus = { skills: [], warnings: [], live: false };

/**
 * 设置页「技能」分区的宿主：入口把可变容器与几个回调交进来，本模块只做机械编排。
 *
 * `skillsRef` 之所以是**可变容器**（而不是直接传一份 `LoadedSkills`）：重扫要就地替换清单，
 * 而每请求拼系统提示词的钩子读的是**同一个容器**——换掉它，下一次请求立刻看到新清单。
 */
export interface SkillsHost {
  skillsRef: { current: LoadedSkills };
  /** 重新扫盘并去重（入口提供：它才握着 cwd / homedir） */
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
 * 重新装载并广播：装载 → 替换容器 → 广播。
 *
 * 系统提示词由入口的每请求钩子重拼（技能清单本来就该每请求可变），
 * 于是新技能 / 新开关**不必重启会话**即可用（报告 A2）。
 * 重扫与改开关共用这一段，免得只修好其中一条路径。
 */
async function reloadAndPublish(host: SkillsHost): Promise<SkillsStatus> {
  const next = await host.reload();
  host.skillsRef.current = next;
  host.applyRescan();
  return skillsStatusOf(host);
}

/** 重新扫描技能目录并**热更新**（设置页「重新扫描」） */
export async function rescanSkills(host: SkillsHost): Promise<SkillsStatus> {
  return reloadAndPublish(host);
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
): Promise<SkillsStatus> {
  await writeSkillDisabled(host.cwd, name, disabled);
  return reloadAndPublish(host);
}

/**
 * 设置页那三个命令的落点。未就绪时（`host` 不存在）：查现状回空、
 * 其余两个报错——**不假装成功**，否则界面会显示一份并不存在的现状。
 */
export async function handleSkillsCommand(
  command: Extract<WorkerCommand, { type: "skillsStatus" | "skillsRescan" | "skillsSetDisabled" }>,
  host: SkillsHost | undefined,
): Promise<SkillsStatus> {
  if (command.type === "skillsStatus") {
    return host === undefined ? EMPTY_SKILLS_STATUS : skillsStatusOf(host);
  }
  if (host === undefined) throw new Error("会话尚未初始化");
  if (command.type === "skillsRescan") return reloadAndPublish(host);
  return applyDisable(host, command.name, command.disabled);
}

/** 显式调用的一次判定结果：要么是可以投递的正文，要么是一句要报给用户的错 */
export type SkillInvocation = { ok: true; text: string } | { ok: false; error: string };

/**
 * `/skill <名字>` 的**判定**：名字在不在、是否被禁用、正文怎么包。
 *
 * 为什么先自查再投递：名字是用户在磁盘上定的，打错时给一条**可见报错并列出可用名**
 * 最有用；而且只有渲染层/入口在提交那一刻判成败，才能做到「拦下时不清空输入」。
 * 正文按 `MAX_SKILL_BODY_CHARS` 截断——`/skill` 投递的是**正文**（不是提示词里那份清单），
 * 告警里那句「模型只会收到截断后的正文」才不会变成假话。
 */
export function resolveSkillInvocation(
  loaded: LoadedSkills,
  name: string,
  instructions?: string,
): SkillInvocation {
  const view = toViewSkills(loaded);
  const available = (): string[] =>
    view.filter((item) => !item.disabled).map((item) => item.name);
  const target = view.find((item) => item.name === name);
  if (target === undefined) return { ok: false, error: unknownSkillMessage(name, available()) };
  if (target.disabled) return { ok: false, error: disabledSkillMessage(name) };
  const skill = loaded.skills.find((item) => item.name === name);
  if (skill === undefined) return { ok: false, error: unknownSkillMessage(name, available()) };
  const capped = capSkillBodies([skill])[0] ?? skill;
  return { ok: true, text: formatSkillInvocation(capped, instructions) };
}

