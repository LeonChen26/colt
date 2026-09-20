// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能接线模块（`worker/lib/skills-command.ts`）的行为测试。
 *
 * 这个模块是 worker 里**唯一**把「清单 / 设置页命令 / 显式调用」三件事接起来的地方，
 * 而它此前只在 `dock` 冒烟里被间接走过（那段对 `skillOrReconnect` 只打桩记账）。
 * 这里用**极小假件**（假 harness / 假 lane）直接钉住三件容易错的事：
 *   ① 未就绪时（没有 host / harness 还没建）——查现状回 `live:false`、重扫**必须报错**
 *      （不能装作扫成功了，那会让设置页显示一份假的「已更新」）；
 *   ② 重扫真的**写回 harness**（`setResources`）并**就地替换容器**，再广播一次；
 *   ③ 显式调用**先按本会话清单自查**再交给内核，内核 `Result.err` 不被吞掉。
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentHarness, AgentLane, Context, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Skill } from "@earendil-works/pi-agent-core";
import type { ViewSkill } from "@shared/worker-protocol";
import {
  EMPTY_SKILLS_STATUS,
  applyDisable,
  createSkillsRuntime,
  dispatchSkills,
  handleSkillsCommand,
  rescanSkills,
  runSkillCommand,
  skillsStatusOf,
  type SkillsHost,
} from "../src/worker/lib/skills-command.ts";
import {
  MAX_SKILL_BODY_CHARS,
  toViewSkills,
  type LoadedSkills,
} from "../src/worker/lib/skills.ts";
import { makeTempDirAsync, removeTempDirAsync } from "./helpers/temp";

const context = BACKGROUND_CONTEXT as Context;

const skillOf = (name: string, filePath: string): Skill => ({
  name,
  description: `${name} 的说明`,
  content: "正文",
  filePath,
});

const loadedOf = (skills: Skill[], disabled: string[] = [], disabledByUser: string[] = []): LoadedSkills => ({
  skills,
  shadowed: [],
  diagnostics: [],
  counts: [skills.length],
  sources: skills.map(() => 0),
  dirSources: ["project"],
  disabled,
  disabledByUser,
});

/** 一个技能要传给 `runSkillCommand` 的那份视图（**带 `disabled`**：判定就看它） */
const viewsOf = (skills: Skill[], disabled: string[] = []): ViewSkill[] =>
  toViewSkills(loadedOf(skills, disabled));

/** 造一个假 harness，只实现本模块用到的 `setResources`，并把入参记下来 */
function fakeHarness(): {
  harness: AgentHarness<ExecutionToolContext>;
  calls: { skills: Skill[] }[];
} {
  const calls: { skills: Skill[] }[] = [];
  const harness = {
    setResources: async (resources: { skills?: Skill[] }) => {
      calls.push({ skills: resources.skills ?? [] });
    },
  } as unknown as AgentHarness<ExecutionToolContext>;
  return { harness, calls };
}

/** 造一个 host：可变容器 + 惰性 harness + 重扫桩 + applyRescan 计数 */
function fakeHost(opts: {
  current: LoadedSkills;
  next?: LoadedSkills;
  harness?: AgentHarness<ExecutionToolContext>;
  cwd?: string;
}): { host: SkillsHost; applyCount: () => number; reloaded: () => number } {
  let apply = 0;
  let reload = 0;
  const host: SkillsHost = {
    skillsRef: { current: opts.current },
    harness: () => opts.harness,
    cwd: opts.cwd ?? "/p",
    reload: async () => {
      reload += 1;
      return opts.next ?? opts.current;
    },
    applyRescan: () => {
      apply += 1;
    },
  };
  return { host, applyCount: () => apply, reloaded: () => reload };
}

describe("skillsStatusOf", () => {
  test("现状 = 视图清单（出处等齐全）+ 逐条告警 + live:true", () => {
    const loaded = loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")]);
    const { host } = fakeHost({ current: loaded });
    const status = skillsStatusOf(host);
    assert.equal(status.live, true);
    assert.deepEqual(status.warnings, []);
    assert.deepEqual(status.skills, [
      {
        name: "pdf",
        description: "pdf 的说明",
        source: "project",
        modelInvocable: true,
        filePath: "/p/.agents/skills/pdf/SKILL.md",
        // 设置页「查看正文」要用它——现状里带**全文**（与随视图下发的 `ViewSkill` 不同）
        content: "正文",
        disabled: false,
        disabledByUser: false,
      },
    ]);
  });

  test("现状里的正文是**全文**（装载结果未被截断）——设置页要看文件里那样", () => {
    const long = "z".repeat(MAX_SKILL_BODY_CHARS + 200);
    const loaded = loadedOf([
      { name: "big", description: "很长的技能", content: long, filePath: "/p/.agents/skills/big/SKILL.md" },
    ]);
    const { host } = fakeHost({ current: loaded });
    assert.equal(skillsStatusOf(host).skills[0]?.content, long);
  });
});

describe("handleSkillsCommand：未就绪的两副面孔", () => {
  test("没有 host 时查现状 → live:false（＝不知道，而非「一个都没装」）", async () => {
    assert.deepEqual(
      await handleSkillsCommand({ type: "skillsStatus" }, undefined, context),
      EMPTY_SKILLS_STATUS,
    );
  });

  test("harness 还没建好时查现状同样回 live:false（此会话尚不可查）", async () => {
    const { host } = fakeHost({ current: loadedOf([]), harness: undefined });
    assert.deepEqual(
      await handleSkillsCommand({ type: "skillsStatus" }, host, context),
      EMPTY_SKILLS_STATUS,
    );
  });

  test("没有 host 时重扫**必须报错**，不能装作扫成功", async () => {
    await assert.rejects(
      () => handleSkillsCommand({ type: "skillsRescan" }, undefined, context),
      /尚未初始化/,
    );
  });

  test("harness 还没建好时重扫也报错（此时无处写回）", async () => {
    const { host } = fakeHost({ current: loadedOf([]), harness: undefined });
    await assert.rejects(
      () => handleSkillsCommand({ type: "skillsRescan" }, host, context),
      /尚未初始化/,
    );
  });

  test("没有 host 时改禁用**也必须报错**——不然界面会显示一个并未发生的状态", async () => {
    await assert.rejects(
      () =>
        handleSkillsCommand({ type: "skillsSetDisabled", name: "pdf", disabled: true }, undefined, context),
      /尚未初始化/,
    );
  });
});

describe("rescanSkills：写回 harness + 换容器 + 广播", () => {
  test("setResources 收到新清单；容器被替换；applyRescan 恰好一次；返回新现状", async () => {
    const before = loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")]);
    const after = loadedOf([
      skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md"),
      skillOf("brand", "/home/u/.agents/skills/brand/SKILL.md"),
    ]);
    const { harness, calls } = fakeHarness();
    const { host, applyCount, reloaded } = fakeHost({ current: before, next: after, harness });

    const status = await rescanSkills(host, context);

    assert.equal(reloaded(), 1, "重扫要真的走一次 reload");
    assert.equal(applyCount(), 1, "清单变了要广播恰好一次");
    assert.equal(calls.length, 1, "要写回 harness 一次");
    assert.deepEqual(
      calls[0]?.skills.map((item) => item.name),
      ["pdf", "brand"],
    );
    assert.deepEqual(
      status.skills.map((item) => item.name),
      ["pdf", "brand"],
      "返回的必须是**新**清单，不是重扫前那份",
    );
    assert.equal(host.skillsRef.current, after, "容器要被就地换成新装载结果");
  });

  test("写回 harness 的是**截断后**的副本（否则重扫一次就把超长正文整段放回上下文）", async () => {
    const long = "x".repeat(MAX_SKILL_BODY_CHARS + 400);
    const next = loadedOf([
      { name: "big", description: "很长的技能", content: long, filePath: "/p/.agents/skills/big/SKILL.md" },
    ]);
    const { harness, calls } = fakeHarness();
    const { host } = fakeHost({ current: loadedOf([]), next, harness });

    await rescanSkills(host, context);

    const written = calls[0]?.skills[0]?.content ?? "";
    assert.ok(written.length < long.length, "写回内核的正文必须被截断");
    assert.match(written, /正文过长已截断/);
    // 但容器里留的仍是全文——设置页「查看正文」要用它
    assert.equal(host.skillsRef.current.skills[0]?.content, long);
  });
});

describe("createSkillsRuntime：装载一次并广播一次", () => {
  test("启动即 publish：视图清单被写回、清单变了被通知、告警走 onNotice", async () => {
    const loaded = loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")]);
    const views: string[][] = [];
    let notices = 0;
    let changed = 0;
    const runtime = await createSkillsRuntime({
      reload: async () => loaded,
      cwd: "/p",
      harness: () => undefined,
      onNotice: () => {
        notices += 1;
      },
      onViewSkills: (list) => views.push(list.map((item) => item.name)),
      onChanged: () => {
        changed += 1;
      },
    });

    assert.deepEqual(views, [["pdf"]], "启动就要把清单写给视图");
    assert.equal(changed, 1, "启动也算「清单就位」，要推一次视图");
    assert.equal(notices, 0, "没有告警时不该制造噪音");
    assert.deepEqual(runtime.view().map((item) => item.name), ["pdf"]);
  });
});

describe("runSkillCommand：先自查、再投递，内核失败不吞", () => {
  const pdf = [skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")];

  test("名字不在清单里 → 直接回报「不存在 + 可用名」，**不调内核**", async () => {
    let called = 0;
    const lane = {
      skill: async () => {
        called += 1;
        return { ok: true, value: undefined };
      },
    } as unknown as AgentLane;

    const error = await runSkillCommand(lane, viewsOf(pdf), { name: "nope" }, context);

    assert.equal(called, 0, "清单里没有的名字不该交给内核");
    assert.match(error ?? "", /技能「nope」不存在/);
    assert.match(error ?? "", /可用：pdf/);
  });

  test("被**禁用**的名字 → 说「已被你禁用」而不是「不存在」，也**不调内核**", async () => {
    let called = 0;
    const lane = {
      skill: async () => {
        called += 1;
        return { ok: true, value: undefined };
      },
    } as unknown as AgentLane;

    const error = await runSkillCommand(lane, viewsOf(pdf, ["pdf"]), { name: "pdf" }, context);

    assert.equal(called, 0, "禁用的技能不该被投递");
    assert.match(error ?? "", /已被你在设置里禁用/);
    // 「不存在」会让人去翻拼写——而这个名字是他自己刚关掉的
    assert.doesNotMatch(error ?? "", /不存在/);
  });

  test("被禁用的名字**不进「可用」候选**（照着候选敲还是会被拒）", async () => {
    const lane = { skill: async () => ({ ok: true, value: undefined }) } as unknown as AgentLane;
    const skills = [skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md"), skillOf("brand", "/p/.agents/skills/brand/SKILL.md")];

    const error = await runSkillCommand(lane, viewsOf(skills, ["brand"]), { name: "nope" }, context);

    assert.match(error ?? "", /可用：pdf/);
    assert.doesNotMatch(error ?? "", /可用：.*brand/);
  });

  test("名字在清单里且内核成功 → 返回 undefined", async () => {
    let seen: string | undefined;
    const lane = {
      skill: async (name: string, instructions: string | undefined) => {
        seen = `${name}|${instructions ?? ""}`;
        return { ok: true, value: undefined };
      },
    } as unknown as AgentLane;

    const error = await runSkillCommand(
      lane,
      viewsOf(pdf),
      { name: "pdf", instructions: "只改这一处" },
      context,
    );

    assert.equal(error, undefined);
    assert.equal(seen, "pdf|只改这一处", "额外指示要原样带到内核");
  });

  test("内核回 `Result.err` → 翻成一句人话（不吞、不抛）", async () => {
    const lane = {
      skill: async () => ({ ok: false, error: { _tag: "UnknownSkill", name: "pdf" } }),
    } as unknown as AgentLane;

    const error = await runSkillCommand(lane, viewsOf(pdf), { name: "pdf" }, context);
    assert.equal(error, "技能「pdf」不存在。");
  });
});

describe("applyDisable：先落盘、再重新装载", () => {
  let dir: string | undefined;
  after(async () => {
    if (dir !== undefined) await removeTempDirAsync(dir);
  });

  test("写项目级 `.colt/skills.json`，随后重扫并写回 harness（顺序不能反）", async () => {
    dir = await makeTempDirAsync("colt-skills-disable-");
    const next = loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")], ["pdf"]);
    const { harness, calls } = fakeHarness();
    const { host, reloaded } = fakeHost({
      current: loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")]),
      next,
      harness,
      cwd: dir,
    });

    const status = await applyDisable(host, "pdf", true, context);

    // 落盘物证：读回来自己断言，别只看「函数被调过」
    const written = JSON.parse(await readFile(join(dir, ".colt", "skills.json"), "utf8")) as {
      disabled?: string[];
    };
    assert.deepEqual(written.disabled, ["pdf"]);
    assert.equal(reloaded(), 1, "写完必须重新装载——否则开关只改了个没人读的文件");
    // 写回内核的那份里**不带**被禁用的技能
    assert.deepEqual(calls[0]?.skills.map((item) => item.name), []);
    assert.equal(status.skills[0]?.disabled, true, "现状要反映刚关掉的状态");
  });

  test("再打开一次：名字从名单里移除（不是追加一条 allow）", async () => {
    if (dir === undefined) throw new Error("上一个用例没建好夹具目录");
    const { harness } = fakeHarness();
    const { host } = fakeHost({
      current: loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")], ["pdf"]),
      next: loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")]),
      harness,
      cwd: dir,
    });

    await applyDisable(host, "pdf", false, context);

    const written = JSON.parse(await readFile(join(dir, ".colt", "skills.json"), "utf8")) as {
      disabled?: string[];
    };
    assert.deepEqual(written.disabled, []);
  });

  test("手工写在同一个文件里的**其它**顶层键要原样保留（读-改-写）", async () => {
    if (dir === undefined) throw new Error("上一个用例没建好夹具目录");
    await mkdir(join(dir, ".colt"), { recursive: true });
    await writeFile(
      join(dir, ".colt", "skills.json"),
      `${JSON.stringify({ disabled: [], note: "手写的" })}\n`,
      "utf8",
    );
    const { harness } = fakeHarness();
    const { host } = fakeHost({ current: loadedOf([]), harness, cwd: dir });

    await applyDisable(host, "brand", true, context);

    const written = JSON.parse(await readFile(join(dir, ".colt", "skills.json"), "utf8")) as {
      disabled?: string[];
      note?: string;
    };
    assert.deepEqual(written.disabled, ["brand"]);
    assert.equal(written.note, "手写的", "别的顶层键不该被我们顺手抹掉");
  });

  test("文件坏掉时**拒绝覆盖**并报错（不可逆的事不做）", async () => {
    if (dir === undefined) throw new Error("上一个用例没建好夹具目录");
    await mkdir(join(dir, ".colt"), { recursive: true });
    await writeFile(join(dir, ".colt", "skills.json"), "{ 这不是 JSON", "utf8");
    const { harness } = fakeHarness();
    const { host, reloaded } = fakeHost({ current: loadedOf([]), harness, cwd: dir });

    await assert.rejects(() => applyDisable(host, "pdf", true, context), /不是合法 JSON/);
    assert.equal(reloaded(), 0, "写盘失败就不该继续重扫");
    // 手写内容原样还在
    assert.equal(await readFile(join(dir, ".colt", "skills.json"), "utf8"), "{ 这不是 JSON");
  });
});

describe("dispatchSkills / enqueue：技能命令串行化（并发不丢写）", () => {
  /** 一个「无副作用」的 runtime：只为拿到 enqueue，回话与播报都无所谓 */
  const runtimeOf = async (
    dir: string,
    harness: AgentHarness<ExecutionToolContext>,
    loaded: LoadedSkills,
  ) =>
    createSkillsRuntime({
      reload: async () => loaded,
      cwd: dir,
      harness: () => harness,
      onNotice: () => undefined,
      onViewSkills: () => undefined,
      onChanged: () => undefined,
    });

  test("后一件要等前一件**跑完**才开始（读-改-写不能并发）", async () => {
    const dir = await makeTempDirAsync("colt-skills-serial-");
    try {
      const { harness } = fakeHarness();
      const runtime = await runtimeOf(dir, harness, loadedOf([]));
      const order: string[] = [];
      const first = runtime.enqueue(async () => {
        order.push("a:start");
        await sleep(25);
        order.push("a:end");
      });
      const second = runtime.enqueue(async () => {
        order.push("b:start");
        await sleep(1);
        order.push("b:end");
      });
      await Promise.all([first, second]);
      assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
    } finally {
      await removeTempDirAsync(dir);
    }
  });

  test("前一件失败也**放行**后一件（一次写盘报错不该把队列永久卡死）", async () => {
    const dir = await makeTempDirAsync("colt-skills-serial-fail-");
    try {
      const { harness } = fakeHarness();
      const runtime = await runtimeOf(dir, harness, loadedOf([]));
      await assert.rejects(
        () => runtime.enqueue(async () => Promise.reject(new Error("写盘失败"))),
        /写盘失败/,
      );
      assert.equal(await runtime.enqueue(async () => 42), 42);
    } finally {
      await removeTempDirAsync(dir);
    }
  });

  test("两个不同名字**并发**禁用 → 文件里两条都在（这是 enqueue 存在的理由）", async () => {
    const dir = await makeTempDirAsync("colt-skills-race-");
    try {
      const two = [
        skillOf("a", "/p/.agents/skills/a/SKILL.md"),
        skillOf("b", "/p/.agents/skills/b/SKILL.md"),
      ];
      const { harness } = fakeHarness();
      const runtime = await runtimeOf(dir, harness, loadedOf(two));
      const state = { lane: {} as AgentLane, skills: runtime };

      const [first, second] = await Promise.all([
        dispatchSkills({ type: "skillsSetDisabled", name: "a", disabled: true }, state, context),
        dispatchSkills({ type: "skillsSetDisabled", name: "b", disabled: true }, state, context),
      ]);

      assert.equal(first.kind, "replied");
      assert.equal(second.kind, "replied");
      const written = JSON.parse(await readFile(join(dir, ".colt", "skills.json"), "utf8")) as {
        disabled?: string[];
      };
      assert.deepEqual([...(written.disabled ?? [])].sort(), ["a", "b"], "并发改禁用不该丢写");
    } finally {
      await removeTempDirAsync(dir);
    }
  });
});
