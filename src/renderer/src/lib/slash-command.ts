/**
 * 输入框里的「斜杠命令」识别。
 *
 * 本仓**没有**命令注册表，也**不做**命令菜单 / 自动补全（`NEXT-PHASE.md` §3.2 的 D3：后端没有
 * 命令注册，画菜单就是死菜单）。这里只识别**确实有实现**的那两条命令，判定在前端本地，
 * 不引入任何「点了没反应的入口」（`AGENTS.md` §3.6）。
 *
 * 两条命令的参数形状**不一样**，所以匹配规则也分两档：
 * - `/compact` 是**零参数**动作 → 必须**独占整条输入**（`"/compact"` 或 `"/compact  "`），
 *   不做前缀匹配——否则用户想发一段以 `/` 开头的正文（例如贴路径 `/usr/local/bin`）会被误吞。
 * - `/skill <名字> [额外指示]` 是**带参数**命令 → 只能做前缀匹配，于是用两道阀守住代价：
 *   ① 命令字必须**整段相等**于 `skill`（`/skills`、`/skillfoo` 都不算命令）；
 *   ② 后面必须真有一个**非空名字段**，裸 `/skill` 一律放行。
 *
 * **未知的 `/xxx` 一律不算命令**，回落成普通提问照常发给模型（模型自己能理解它）。
 * 即「只有白名单里的命令才被拦截」——漏写的命令只会「原样发出去」，不会静默丢失。
 *
 * 唯一的例外是 `/skill <名字>` 里名字不存在：那**不回落**，而是**就地拦下**（渲染层拿着本会话的
 * 技能清单，判据见下面的 `resolveSkillCommand`），报一条可见错误、列出可用技能名，**且不清空输入**
 * ——用户改一个字母就能重敲。这不违反上面那条原则的本意：那条怕的是**静默**丢输入。
 * 渲染层拿不到清单时交给 worker 报同一句话（文案在 `@shared/skill-error`，两边共用同一份）。
 */

import { unknownSkillMessage } from "@shared/skill-error";

export type SlashCommand =
  | { name: "compact" }
  | { name: "skill"; skillName: string; instructions: string | undefined };

/** 命令字 → 该命令是否接受参数。两张表分开，免得将来加命令时误用另一档的规则 */
const NO_ARG_COMMANDS = ["compact"] as const;
const ARG_COMMANDS = ["skill"] as const;

/** `首段` + `其余原样`（其余可为空） */
function splitHead(text: string): { head: string; rest: string } {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  return { head: match?.[1] ?? "", rest: match?.[2]?.trim() ?? "" };
}

/**
 * 解析输入框文本。
 *
 * @returns 命中的命令；不是命令（含未知 `/xxx`、空串、以 `/` 开头的普通文本）时返回 `null`
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const { head, rest } = splitHead(trimmed.slice(1));
  // 命令字不区分大小写（`/COMPACT` 也算）；**参数原样保留**——
  // 尤其技能名不转小写：内核按精确名查找，转写会造出一个「我们改了用户输入」的隐式行为，
  // 而打错大小写时那条报错会直接给出正确写法（自纠，比猜用户意图稳）。
  const lower = head.toLowerCase();

  if ((NO_ARG_COMMANDS as readonly string[]).includes(lower)) {
    // 零参数命令：**多出任何内容都不算命令**。若只取第一段比对，`/compact 一下` 会被吞掉——
    // 用户那句「用 /compact 手动压缩」就永远发不出去了（v1.34 的教训）。
    return rest.length === 0 ? { name: "compact" } : null;
  }

  if ((ARG_COMMANDS as readonly string[]).includes(lower)) {
    // 带参数命令：裸命令（没有参数）放行，别把它当命令吞掉
    if (rest.length === 0) return null;
    const { head: skillName, rest: instructions } = splitHead(rest);
    if (skillName.length === 0) return null;
    return {
      name: "skill",
      skillName,
      instructions: instructions.length > 0 ? instructions : undefined,
    };
  }

  return null;
}

/** `/skill <名字>` 该不该发出去 */
export type SkillDispatch =
  | { readonly kind: "invoke" }
  | { readonly kind: "reject"; readonly message: string };

/**
 * 决定 `/skill <名字>` 是发出去还是就地拦下。
 *
 * **为什么要在本地先判一次**：`invoke("session.skill")` 返回的是「**已投递**」，worker 的校验
 * 失败走 `session.error` **推送**——提交那一刻渲染层判不了成败。所以若照旧先清空输入再发，
 * 名字打错时那半句额外指示就跟着一起没了（用户看到的现象：打错一个字母，白敲一整句话）。
 * 本地拦下则输入原样留着，改一个字母重敲即可。
 *
 * `knownSkills` 的**三种取值必须区别对待**，这是本函数的全部要点：
 * - **`undefined`**（拿不到视图：没有 worker / 还没上报）→ **不拦**，照常发。此时清单是
 *   **不知道**，不是「空的」；凭它拒绝会把一次**有效**调用误判成失败——那是另一种丢输入，
 *   而且用户看不懂（「明明有这个技能文件」）。由 worker 兜底报错。
 * - **`[]`**（知道，且确实一个技能都没装）→ 拦：此时名字**必然**不存在。
 * - **非空列表** → 在里面找，找不到才拦（报错带上可用名，那是用户唯一能知道正确写法的地方）。
 */
export function resolveSkillCommand(
  skillName: string,
  knownSkills: readonly string[] | undefined,
): SkillDispatch {
  if (knownSkills === undefined) return { kind: "invoke" };
  if (knownSkills.includes(skillName)) return { kind: "invoke" };
  return { kind: "reject", message: unknownSkillMessage(skillName, knownSkills) };
}
