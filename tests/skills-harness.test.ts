// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能接线的**端到端**用例（免模型、不打网络、不计费）。
 *
 * 为什么值得单独一个文件：`tests/skills.test.ts` 覆盖的是纯函数与「真装载」，
 * 而 `resources.skills → 内核 lane.skill` 这一段是**接线**——它此前没有任何断言，
 * 于是「技能列得出来、却调不出来」可以全绿通过（`AGENTS.md` §四「只有定义、没有调用」
 * 的同族盲区）。
 *
 * 这里把内核真拉起来，模型用 `pi-ai` 自带的 **faux provider**（脚本化回复，
 * 本地回放，不出网），于是「免模型」也覆盖得住 `lane.skill` 的完整路径：
 *   ① 名字在 `resources.skills` 里 → 内核认得，并跑完（不报 `UnknownSkill`）；
 *   ② 技能正文与那半句额外指示**真的**以一条 user 消息进了 transcript；
 *   ③ 名字不在清单里 → `Result.err` 且 `_tag === "UnknownSkill"`（**不是抛异常**）；
 *   ④ 会话关闭后仍调 → `Result.err` 且 `_tag === "Closed"`。
 *
 * 外加一条**隐性前提**的断言（`⑤`）：工作区外的技能文件（用户级
 * `~/.agents/skills`）必须能被 `read` 工具读到——「模型自己想起来用技能」全靠
 * 这一条，而它此前没有任何用例护着。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDirAsync, removeTempDirAsync } from "./helpers/temp";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  createReadTool,
  type AgentLane,
  type Context,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  MAX_SKILL_BODY_CHARS,
  capSkillBodies,
  loadSkillsForSession,
} from "../src/worker/lib/skills.ts";
import { MAIN_LANE } from "../src/worker/lib/telemetry.ts";

type Harness = Awaited<ReturnType<typeof AgentHarness.create>>["harness"];
type Watch = Awaited<ReturnType<AgentLane["watch"]>>;
type Faux = ReturnType<typeof fauxProvider>;

const SKILL_NAME = "processing-pdfs";
/** 正文里放一句独一无二的串：断言它**真的**进了发给模型的那条 user 消息 */
const SKILL_BODY = "技能的绝密正文：先读 PDF 再动手。";
const EXTRA_INSTRUCTIONS = "只改这一处";

let root = "";
let skillsRoot = "";
let skills: Skill[] = [];
let sessionSeq = 0;

/** 从消息 content 里取文本——口径同 worker 的 `projectTranscript`（只认 text 块） */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((block) => {
      return (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      );
    })
    .map((block) => (block as { text: string }).text)
    .join("");
}

/** 把 transcript 投影成「role → 文本」，用于断言那条技能调用的 user 消息 */
function messagesOf(watch: Watch, context: Context): Promise<{ role: string; text: string }[]> {
  return watch.resnapshot(context).then((snapshot) => {
    const entries = snapshot.transcript as unknown as {
      type?: string;
      message?: { role?: string; content?: unknown };
    }[];
    return entries
      .filter((entry) => entry.type === "message" && entry.message !== undefined)
      .map((entry) => ({
        role: entry.message?.role ?? "",
        text: textOf(entry.message?.content),
      }));
  });
}

/**
 * 起一个真 harness + 主 lane（每个用例各起一份，互不影响）。
 * `override` 传了就换掉默认那份技能清单（用来验「超限正文被截断后才交给内核」）。
 */
async function openHarness(override?: Skill[]): Promise<{
  harness: Harness;
  lane: AgentLane;
  watch: Watch;
  faux: Faux;
}> {
  const env = new NodeExecutionEnv({ cwd: root });
  const sessionsRoot = join(root, "sessions", String((sessionSeq += 1)));
  await mkdir(sessionsRoot, { recursive: true });
  const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
  const session = await repo.create({ cwd: root }, BACKGROUND_CONTEXT);

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const { harness } = await AgentHarness.create(
    {
      session,
      models,
      model: faux.getModel(),
      resources: (override ?? skills).length > 0 ? { skills: override ?? skills } : undefined,
      systemPrompt: "测试用系统提示词",
    },
    BACKGROUND_CONTEXT,
  );
  const lane = await harness.lane(MAIN_LANE, BACKGROUND_CONTEXT);
  const watch = await lane.watch(BACKGROUND_CONTEXT);
  return { harness, lane, watch, faux };
}

describe("技能接线：resources.skills → lane.skill", () => {
  before(async () => {
    root = await makeTempDirAsync("colt-skill-harness-");
    // 工作区**外**的技能目录：模拟用户级 `~/.agents/skills`
    skillsRoot = await makeTempDirAsync("colt-skill-outside-");
    const dir = join(skillsRoot, ".agents", "skills", SKILL_NAME);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: 处理 PDF。\n---\n\n${SKILL_BODY}\n`,
      "utf8",
    );

    const env = new NodeExecutionEnv({ cwd: root });
    const loaded = await loadSkillsForSession(
      env,
      [{ dir: join(skillsRoot, ".agents", "skills"), source: "project" }],
      BACKGROUND_CONTEXT,
    );
    // 前置：装载本身要成立，否则下面的红是假红（先怀疑接入，别先怀疑被测对象）
    assert.deepEqual(loaded.skills.map((item) => item.name), [SKILL_NAME]);
    skills = loaded.skills;
  });

  after(async () => {
    await removeTempDirAsync(root, skillsRoot);
  });

  test("名字在清单里 → 内核认得并跑完；正文与额外指示真的进了 user 消息", async () => {
    const { harness, lane, watch, faux } = await openHarness();
    try {
      faux.setResponses([fauxAssistantMessage("好的。")]);
      const result = await lane.skill(SKILL_NAME, EXTRA_INSTRUCTIONS, BACKGROUND_CONTEXT);
      assert.equal(
        result.ok,
        true,
        result.ok ? "" : `调用失败：${JSON.stringify((result.error as { _tag?: string })._tag)}`,
      );

      const messages = await messagesOf(watch, BACKGROUND_CONTEXT);
      const skillMessage = messages.find((item) => item.role === "user" && item.text.includes("<skill"));
      assert.ok(
        skillMessage !== undefined,
        `transcript 里应有一条技能调用消息，实得：${JSON.stringify(messages)}`,
      );
      // 内核 formatSkillInvocation 的形状：带名字、带位置，正文原样在内
      assert.ok(skillMessage.text.includes(`<skill name="${SKILL_NAME}"`), skillMessage.text);
      assert.ok(skillMessage.text.includes(SKILL_BODY), "技能正文必须真的发出去");
      assert.ok(
        skillMessage.text.includes(EXTRA_INSTRUCTIONS),
        "那半句额外指示不能被吞掉（v1.43 的用户可见缺陷）",
      );
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  test("名字不在清单里 → Result.err 且是 UnknownSkill（走返回值，不是抛异常）", async () => {
    const { harness, lane } = await openHarness();
    try {
      const result = await lane.skill("no-such-skill-colt", undefined, BACKGROUND_CONTEXT);
      assert.equal(result.ok, false, "未知技能不该被当成有效调用");
      assert.equal(!result.ok ? (result.error as { _tag?: string })._tag : "", "UnknownSkill");
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  test("会话关闭后再调 → Result.err 且是 Closed", async () => {
    const { harness, lane } = await openHarness();
    await harness.close(BACKGROUND_CONTEXT);
    const result = await lane.skill(SKILL_NAME, undefined, BACKGROUND_CONTEXT);
    assert.equal(result.ok, false);
    assert.equal(!result.ok ? (result.error as { _tag?: string })._tag : "", "Closed");
  });

  test("工作区外的技能文件能被 read 工具读到（模型自选技能的隐性前提）", async () => {
    const env = new NodeExecutionEnv({ cwd: root });
    const tool = createReadTool();
    const path = join(skillsRoot, ".agents", "skills", SKILL_NAME, "SKILL.md");
    // 工具签名里 `onUpdate` / `invocation` 本用例用不上（内核实现也忽略它们），
    // 收敛成一个明确的最小形态，避免为一次调用把整套类型搬进来。
    const execute = tool.execute as unknown as (
      id: string,
      params: { path: string },
      onUpdate: undefined,
      toolContext: { env: NodeExecutionEnv },
      invocation: undefined,
      context: Context,
    ) => Promise<{ content: { type: string; text?: string }[] }>;

    const result = await execute("call-1", { path }, undefined, { env }, undefined, BACKGROUND_CONTEXT);
    const text = result.content.map((block) => block.text ?? "").join("");
    assert.ok(text.includes(SKILL_BODY), `工作区外的技能文件必须读得到，实得：${text}`);
  });

  test("超限正文：模型收到的是截断后的正文 + 指回文件的标记（P7 的 cap 真的经内核生效）", async () => {
    const long = "x".repeat(MAX_SKILL_BODY_CHARS + 300);
    const big: Skill = {
      name: "big",
      description: "很长的技能",
      content: long,
      filePath: join(root, "big", "SKILL.md"),
    };
    // 入口给内核的就是 `capSkillBodies(...)` 的产物（见 `worker/entry.ts`），这里照抄那一步
    const { harness, lane, watch, faux } = await openHarness(capSkillBodies([big]));
    try {
      faux.setResponses([fauxAssistantMessage("好的。")]);
      const result = await lane.skill("big", undefined, BACKGROUND_CONTEXT);
      assert.equal(result.ok, true);

      const messages = await messagesOf(watch, BACKGROUND_CONTEXT);
      const skillMessage = messages.find(
        (item) => item.role === "user" && item.text.includes('<skill name="big"'),
      );
      assert.ok(
        skillMessage !== undefined,
        `transcript 里应有一条技能调用消息，实得：${JSON.stringify(messages)}`,
      );
      assert.ok(skillMessage.text.includes("x".repeat(MAX_SKILL_BODY_CHARS)), "上限内的正文照常带上");
      assert.ok(
        !skillMessage.text.includes("x".repeat(MAX_SKILL_BODY_CHARS + 1)),
        "超出上限的正文不该整段进上下文",
      );
      assert.match(skillMessage.text, /正文过长已截断/);
      assert.ok(skillMessage.text.includes(big.filePath), "要指回文件——被裁掉的尾部仍可 read 到");
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});
