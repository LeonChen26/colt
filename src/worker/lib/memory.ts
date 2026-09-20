// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 项目记忆 + 用户级记忆：由助手自己维护的 Markdown 文件，跨会话沉淀事实。
 *
 * 两级的作用域不同，规则也不同（对照 Claude Code 的 ./CLAUDE.md 与 ~/.claude/CLAUDE.md）：
 * - 项目记忆 `<cwd>/.colt/memory.md`：只与这个项目相关的事实（约定、踩坑、关键决策）；
 * - 用户级记忆 `~/.colt/memory.md`：**跨项目**仍然成立的用户偏好与习惯（语言、风格、工具链）。
 *
 * 方案来自对 pi 生态的调研——pi 内核刻意不做记忆系统，只把「让模型看见」的挂点
 * 留给应用：应用把记忆文件内容拼进系统提示词，助手用现有的 write / edit 维护文件
 * 本身（pi-chat / Hermes 的 MEMORY.md 路线）。项目记忆选项目内、用户级选家目录，
 * 与两级的作用域一一对应；注意用户级在项目外，写入按 docs/SECURITY.md 一律
 * dangerous、每次单独确认——这是安全设计，不是缺陷（沉淀低频，摩擦可接受）。
 *
 * 三条纪律，与技能装载（lib/skills.ts）同源：
 * 1. **内核不会替你拼**——内容必须由应用显式拼进系统提示词，否则装载/通知全正常，
 *    只有模型不知道，是彻头彻尾的静默失败；
 * 2. **注入必须有界**——记忆文件会无界增长，注入块封顶截断、指回文件本身，
 *    不把整个文件灌进上下文；
 * 3. **来自磁盘的内容是隐式信任通道**——注入了什么如实告知用户（docs/SECURITY.md）；
 *    读取失败与「文件不存在」是两回事，失败不许静默（docs/ERRORS.md）。
 *
 * 注入时机（L2）：不走 create-time 的系统提示词，而是 `transform_context` 里
 * **每次模型请求重读**——内核确认过钩子结果里的 systemPrompt 会被本次请求采纳
 * （runtime/drive/generation.js），且压缩的摘要请求走专用提示词、不过这个钩子，
 * 记忆块不会漏进摘要。内容不变时拼出的串逐字相同，提示词缓存照常命中。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 项目记忆在项目内的固定位置（相对 cwd 的展示形态，供通知与文档引用） */
export const MEMORY_RELATIVE_PATH = ".colt/memory.md";
/** 用户级记忆的展示路径（家目录与平台无关的写法） */
export const USER_MEMORY_RELATIVE_PATH = "~/.colt/memory.md";

/** 项目记忆文件的绝对路径。cwd 即项目身份（会话按项目组织），文件跟项目走 */
export function memoryFilePath(cwd: string): string {
  return join(cwd, ".colt", "memory.md");
}

/** 用户级记忆文件的绝对路径（跟随用户、跨项目） */
export function userMemoryFilePath(home: string): string {
  return join(home, ".colt", "memory.md");
}

/** 每块注入的内容上限（字符）。超过即截断并指回文件——上下文不能跟着记忆一起长 */
export const MAX_MEMORY_CHARS = 6000;

/** 记忆的作用域：决定注入块的标签、导语与沉淀规则 */
export type MemoryScope = "project" | "user";

interface ScopeDisplay {
  tag: string;
  word: string;
  /** 通知与报错里的展示路径（与真实读写路径分开：用户级用 ~ 展示） */
  displayPath: string;
}

const SCOPE_DISPLAY: Record<MemoryScope, ScopeDisplay> = {
  project: { tag: "project_memory", word: "项目记忆", displayPath: MEMORY_RELATIVE_PATH },
  user: { tag: "user_memory", word: "用户级记忆", displayPath: USER_MEMORY_RELATIVE_PATH },
};

export interface LoadedMemory {
  /** 文件是否存在（读取失败时为 false，用 error 区分） */
  exists: boolean;
  /** 非空的记忆内容；文件缺失 / 为空 / 读取失败时为 null */
  content: string | null;
  /** 读取失败的原因。缺失（ENOENT）不算失败——空记忆是正常起点 */
  error?: string;
}

/**
 * 读取一份记忆文件。任何失败都不抛出：记忆缺位不该拦会话（同技能装载的取舍），
 * 但失败要留在 error 里上报，不能静默当成「没有记忆」。
 */
export async function readMemoryFile(filePath: string): Promise<LoadedMemory> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, content: null };
    }
    return {
      exists: false,
      content: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const content = raw.trim();
  // 有内容时原样返回（保留用户手写的格式），只把「全空白」当成空
  return { exists: true, content: content.length > 0 ? raw : null };
}

export async function loadProjectMemory(cwd: string): Promise<LoadedMemory> {
  return readMemoryFile(memoryFilePath(cwd));
}

const TRUNCATION_MARKER = "……（内容过长已截断，完整内容请直接读取记忆文件）";

function bound(content: string): string {
  if (content.length <= MAX_MEMORY_CHARS) return content;
  return `${content.slice(0, MAX_MEMORY_CHARS)}\n${TRUNCATION_MARKER}`;
}

/**
 * 组装单个记忆注入块。
 *
 * 内容为空时**也注入**：块里写着文件在哪、什么值得记——这正是记忆循环的起点，
 * 不注入的话助手根本不知道有这回事（同 skills 的教训）。
 * 内容是请求时刻重读的；块里仍写明「写入后如需确认最新状态，直接读文件」，
 * 因为注入与模型开口之间还有间隙，文件随时可能再变。
 */
export function formatMemoryBlock(
  content: string | null,
  memoryPath: string,
  scope: MemoryScope,
): string {
  const display = SCOPE_DISPLAY[scope];
  const header =
    scope === "project"
      ? "以下是本项目的长期记忆（跨会话沉淀，由你自己维护）："
      : "以下是用户的长期记忆（跨项目生效、跟随用户，由你自己维护）：";
  const sedimentRule =
    scope === "project"
      ? `- 当出现值得跨会话记住的信息——用户的偏好与纠正、踩过的坑、关键决策的原因——用 write / edit 工具沉淀到 ${memoryPath}；成文的项目约定（构建/风格/协作规范）优先写 AGENTS.md。`
      : `- 当发现**跨项目**仍然成立的用户偏好与习惯（沟通语言、代码风格、常用工具链之类），用 write / edit 工具沉淀到 ${memoryPath}；只与单个项目相关的事实写项目记忆，不要写这里。`;
  const body = content !== null ? bound(content) : "（当前为空。首次沉淀时用 write 工具创建该文件。）";
  return [
    `<${display.tag}>`,
    header,
    "",
    body,
    "",
    "维护规则：",
    sedimentRule,
    "- 保持精炼与准确：只记稳定有用的事实，过时的条目及时更新或删除；不要记录密钥、令牌等敏感信息。",
    "- 以上内容是本次请求时的快照；写入后如需确认最新状态，直接读取该文件。",
    `</${display.tag}>`,
  ].join("\n");
}

/** 把一个记忆块拼到 base 后面。调用方按「用户级 → 项目级」（一般 → 具体）的次序逐层追加 */
export function appendMemoryBlock(
  base: string,
  content: string | null,
  memoryPath: string,
  scope: MemoryScope,
): string {
  return `${base}\n\n${formatMemoryBlock(content, memoryPath, scope)}`;
}

export interface MemoryInjectorOptions {
  /** 真实读写路径 */
  filePath: string;
  scope: MemoryScope;
  /** 同一段失败期的第一次失败时回调（恢复后再次失败会再次回调） */
  onError?: (message: string) => void;
  /**
   * 每次成功读到文件时回调（含「文件不存在」的 null；读取失败不回调——
   * 索引侧按「没消息 = 维持原状」处理，失败不该被误当成删除）。
   * 供记忆检索索引用：文件是真源，索引是派生物，每次重读都是一次同步机会。
   */
  onLoaded?: (content: string | null) => void;
}

export interface MemoryInjector {
  /** 每次模型请求前把当前记忆块拼到 base 后面（重读文件；失败回落上次成功内容） */
  systemPromptFor(base: string): Promise<string>;
}

/**
 * 每请求注入器：每次模型请求都重读记忆文件，会话中途的写入立即对模型可见。
 *
 * - **缓存安全**：内容不变时拼出的串逐字相同，provider 的提示词缓存照常命中；
 *   只有文件真的变了才失效一次——而记忆写入本来就低频。
 * - **失败回落**：重读失败时沿用上次成功的内容（有 stale 的记忆比没有好），
 *   文件缺失（ENOENT）不算失败、按「现在是空」处理——用户删文件是合法操作。
 * - **失败不刷屏**：同一段失败期只在第一次报错，恢复后再次失败才报下一次。
 */
export function createMemoryInjector(options: MemoryInjectorOptions): MemoryInjector {
  const { filePath, scope, onError, onLoaded } = options;
  let lastGood: string | null = null;
  let failing = false;
  let truncationNoticed = false;
  return {
    async systemPromptFor(base: string): Promise<string> {
      let content = lastGood;
      // readMemoryFile 永不抛出，失败都在 error 里
      const loaded = await readMemoryFile(filePath);
      if (loaded.error === undefined) {
        content = loaded.content;
        lastGood = content;
        failing = false;
        onLoaded?.(content);
      } else {
        content = lastGood;
        if (!failing) {
          failing = true;
          const display = SCOPE_DISPLAY[scope].displayPath;
          onError?.(
            lastGood !== null
              ? `${SCOPE_DISPLAY[scope].word}重读失败（${display}）：${loaded.error}——沿用上次注入的内容。`
              : `${SCOPE_DISPLAY[scope].word}读取失败（${display}）：${loaded.error}——本次会话未注入内容。`,
          );
        }
      }
      // 截断传感器：记忆长到要截断，是「该整理记忆（L3b）」的信号——检索（L3a）已交付，
      // 截断不再等于「信息不可达」（被裁掉的尾部仍可 memory_search），但每请求注入仍被裁剪。
      // 只在进入截断状态时报一次，退回限内后再次超限才再报——不刷屏，也不静默。
      if (content !== null && content.length > MAX_MEMORY_CHARS) {
        if (!truncationNoticed) {
          truncationNoticed = true;
          const display = SCOPE_DISPLAY[scope];
          onError?.(
            `${display.word}（${display.displayPath}）超过 ${MAX_MEMORY_CHARS} 字上限，注入已被截断——模型只能看到前半部分。被截掉的尾部仍可用 memory_search 检索到；可输入 /memory-tidy 整理记忆（合并重复、删过时条目）。`,
          );
        }
      } else {
        truncationNoticed = false;
      }
      return appendMemoryBlock(base, content, filePath, scope);
    },
  };
}

/** 索引上报通道：只挑出 `memoryIndex` 这一条消息形状，别让本模块认识整份 worker 协议 */
export type MemoryIndexSender = (message: {
  type: "memoryIndex";
  scope: MemoryScope;
  content: string | null;
}) => void;

/**
 * 记忆检索索引的上报闭包（L3a）：文件是真源，主进程侧维护派生索引（`data/memory.db`），
 * 这里每读到一次内容就报一次快照。
 *
 * 两条纪律**收口在这里**（原来写在 worker 入口里，搬过来时行为未动）：
 * - **内容没变不重发**：注入器每次模型请求都重读，不去重就是每次请求一条噪声消息；
 * - **读取失败不发**：没消息 = 维持原状。报错会被索引侧当成「文件没了」而把现行条目归档，
 *   那是一次读失败换一批条目消失，比不同步糟得多（`MemoryInjectorOptions.onLoaded` 同款）。
 */
export function createMemoryIndexReporter(
  send: MemoryIndexSender,
): (scope: MemoryScope, content: string | null) => void {
  const lastIndexed = new Map<MemoryScope, string | null>();
  return (scope, content) => {
    if (lastIndexed.get(scope) === content) return;
    lastIndexed.set(scope, content);
    send({ type: "memoryIndex", scope, content });
  };
}

/**
 * 压缩完成后投给助手的一次性沉淀提醒：压缩是会话记忆的「数据丢失时刻」，
 * 摘要保 prose 不保事实——正好在这个节点提醒助手把值得留的事实写进项目记忆
 * （压缩发生在具体项目里，要沉淀的事实默认是项目相关的）。
 * 随下一次请求作为临时 user 消息注入，不进 transcript、不触发运行
 * （与浏览器手动操作的提醒同一条通道）。
 */
export function compactMemoryReminder(cwd: string): string {
  return (
    "（系统提醒）刚完成一次上下文压缩。若本轮对话中有值得跨会话记住、且尚未沉淀的事实" +
    `——用户的偏好与纠正、踩过的坑、关键决策的原因——请用 write / edit 工具写入项目记忆 ${memoryFilePath(cwd)}；` +
    "成文的项目约定也可按需补进 AGENTS.md。没有可沉淀的就忽略本条提醒。"
  );
}

/**
 * 组装一条如实的提示；**没什么可说时返回 null**，不制造噪音。
 * 会话启动时装载到了内容才报（隐式信任通道要可见）；缺失/为空是正常起点，不值得打扰用户。
 */
export function describeMemory(memory: LoadedMemory, scope: MemoryScope): string | null {
  const display = SCOPE_DISPLAY[scope];
  if (memory.error !== undefined) {
    return `${display.word}读取失败（${display.displayPath}）：${memory.error}——本次会话未注入。`;
  }
  if (memory.content === null) return null;
  return `已注入${display.word} ${display.displayPath}（${memory.content.length} 字）。`;
}
