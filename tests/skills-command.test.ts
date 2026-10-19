// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能接线模块（`worker/lib/skills-command.ts`）的行为测试。
 *
 * 这个模块是 worker 里**唯一**把「清单 / 设置页命令 / 显式调用判定」接起来的地方。
 * 这里用**极小假件**（假 host / 假装载结果）直接钉住四件容易错的事：
 *   ① 未就绪时（没有 host）——查现状回 `live:false`、重扫**必须报错**
 *      （不能装作扫成功了，那会让设置页显示一份假的「已更新」）；
 *   ② 重扫真的**就地替换容器**并广播一次；
 *   ③ 显式调用**先按本会话清单自查**，禁用 / 不存在 / 正文截断各有各的说法；
 *   ④ 技能命令**串行化**——并发改禁用不丢写。
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  EMPTY_SKILLS_STATUS,
  applyDisable,
  createSkillsRuntime,
  handleSkillsCommand,
  rescanSkills,
  resolveSkillInvocation,
  skillsStatusOf,
  type SkillsHost,
} from "../src/worker/lib/skills-command.ts";
import {
  MAX_SKILL_BODY_CHARS,
  type LoadedSkills,
} from "../src/worker/lib/skills.ts";
import type { Skill } from "../src/worker/lib/skills-loader.ts";
import { makeTempDirAsync, removeTempDirAsync } from "./helpers/temp";

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

/** 造一个 host：可变容器 + 重扫桩 + applyRescan 计数 */
function fakeHost(opts: {
  current: LoadedSkills;
  next?: LoadedSkills;
  cwd?: string;
}): { host: SkillsHost; applyCount: () => number; reloaded: () => number } {
  let apply = 0;
  let reload = 0;
  const host: SkillsHost = {
    skillsRef: { current: opts.current },
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
      await handleSkillsCommand({ type: "skillsStatus" }, undefined),
      EMPTY_SKILLS_STATUS,
    );
  });

  test("没有 host 时重扫**必须报错**，不能装作扫成功", async () => {
    await assert.rejects(
      () => handleSkillsCommand({ type: "skillsRescan" }, undefined),
      /尚未初始化/,
    );
  });

  test("没有 host 时改禁用**也必须报错**——不然界面会显示一个并未发生的状态", async () => {
    await assert.rejects(
      () =>
        handleSkillsCommand({ type: "skillsSetDisabled", name: "pdf", disabled: true }, undefined),
      /尚未初始化/,
    );
  });
});

describe("rescanSkills：换容器 + 广播", () => {
  test("容器被替换；applyRescan 恰好一次；返回新现状", async () => {
    const before = loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")]);
    const after = loadedOf([
      skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md"),
      skillOf("brand", "/home/u/.agents/skills/brand/SKILL.md"),
    ]);
    const { host, applyCount, reloaded } = fakeHost({ current: before, next: after });

    const status = await rescanSkills(host);

    assert.equal(reloaded(), 1, "重扫要真的走一次 reload");
    assert.equal(applyCount(), 1, "清单变了要广播恰好一次");
    assert.deepEqual(
      status.skills.map((item) => item.name),
      ["pdf", "brand"],
      "返回的必须是**新**清单，不是重扫前那份",
    );
    assert.equal(host.skillsRef.current, after, "容器要被就地换成新装载结果");
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

describe("resolveSkillInvocation：先自查、再给正文", () => {
  const pdf = [skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")];

  test("名字不在清单里 → 回报「不存在 + 可用名」", () => {
    const result = resolveSkillInvocation(loadedOf(pdf), "nope");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /技能「nope」不存在/);
    assert.match(result.ok ? "" : result.error, /可用：pdf/);
  });

  test("被**禁用**的名字 → 说「已被你禁用」而不是「不存在」", () => {
    const result = resolveSkillInvocation(loadedOf(pdf, ["pdf"]), "pdf");
    assert.equal(result.ok, false);
    const error = result.ok ? "" : result.error;
    assert.match(error, /已被你在设置里禁用/);
    // 「不存在」会让人去翻拼写——而这个名字是他自己刚关掉的
    assert.doesNotMatch(error, /不存在/);
  });

  test("被禁用的名字**不进「可用」候选**（照着候选敲还是会被拒）", () => {
    const skills = [
      skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md"),
      skillOf("brand", "/p/.agents/skills/brand/SKILL.md"),
    ];
    const result = resolveSkillInvocation(loadedOf(skills, ["brand"]), "nope");
    assert.equal(result.ok, false);
    const error = result.ok ? "" : result.error;
    assert.match(error, /可用：pdf/);
    assert.doesNotMatch(error, /可用：.*brand/);
  });

  test("名字在清单里 → 正文包成与旧内核逐字一致的块，额外指示原样跟在后面", () => {
    const result = resolveSkillInvocation(loadedOf(pdf), "pdf", "只改这一处");
    assert.equal(result.ok, true);
    const text = result.ok ? result.text : "";
    assert.ok(text.startsWith('<skill name="pdf" location="/p/.agents/skills/pdf/SKILL.md">\n'), text);
    assert.ok(text.includes("References are relative to /p/.agents/skills/pdf."), text);
    assert.ok(text.includes("\n正文\n</skill>"), text);
    assert.ok(text.endsWith("\n\n只改这一处"), text);
  });

  test("超长正文按上限截断并指回文件（告警里那句「只会收到截断后的正文」得是真的）", () => {
    const long = "x".repeat(MAX_SKILL_BODY_CHARS + 400);
    const result = resolveSkillInvocation(
      loadedOf([{ name: "big", description: "很长的技能", content: long, filePath: "/p/.agents/skills/big/SKILL.md" }]),
      "big",
    );
    assert.equal(result.ok, true);
    const text = result.ok ? result.text : "";
    assert.ok(text.length < long.length, "投递的正文必须被截断");
    assert.match(text, /正文过长已截断/);
  });
});

describe("applyDisable：先落盘、再重新装载", () => {
  let dir: string | undefined;
  after(async () => {
    if (dir !== undefined) await removeTempDirAsync(dir);
  });

  test("写项目级 `.colt/skills.json`，随后重扫（顺序不能反）", async () => {
    dir = await makeTempDirAsync("colt-skills-disable-");
    const next = loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")], ["pdf"]);
    const { host, reloaded } = fakeHost({
      current: loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")]),
      next,
      cwd: dir,
    });

    const status = await applyDisable(host, "pdf", true);

    // 落盘物证：读回来自己断言，别只看「函数被调过」
    const written = JSON.parse(await readFile(join(dir, ".colt", "skills.json"), "utf8")) as {
      disabled?: string[];
    };
    assert.deepEqual(written.disabled, ["pdf"]);
    assert.equal(reloaded(), 1, "写完必须重新装载——否则开关只改了个没人读的文件");
    assert.equal(status.skills[0]?.disabled, true, "现状要反映刚关掉的状态");
  });

  test("再打开一次：名字从名单里移除（不是追加一条 allow）", async () => {
    if (dir === undefined) throw new Error("上一个用例没建好夹具目录");
    const { host } = fakeHost({
      current: loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")], ["pdf"]),
      next: loadedOf([skillOf("pdf", "/p/.agents/skills/pdf/SKILL.md")]),
      cwd: dir,
    });

    await applyDisable(host, "pdf", false);

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
    const { host } = fakeHost({ current: loadedOf([]), cwd: dir });

    await applyDisable(host, "brand", true);

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
    const { host, reloaded } = fakeHost({ current: loadedOf([]), cwd: dir });

    await assert.rejects(() => applyDisable(host, "pdf", true), /不是合法 JSON/);
    assert.equal(reloaded(), 0, "写盘失败就不该继续重扫");
    // 手写内容原样还在
    assert.equal(await readFile(join(dir, ".colt", "skills.json"), "utf8"), "{ 这不是 JSON");
  });
});

describe("enqueue：技能命令串行化（并发不丢写）", () => {
  /** 一个「无副作用」的 runtime：只为拿到 enqueue 与 host，回话与播报都无所谓 */
  const runtimeOf = async (dir: string, loaded: LoadedSkills) =>
    createSkillsRuntime({
      reload: async () => loaded,
      cwd: dir,
      onNotice: () => undefined,
      onViewSkills: () => undefined,
      onChanged: () => undefined,
    });

  test("后一件要等前一件**跑完**才开始（读-改-写不能并发）", async () => {
    const dir = await makeTempDirAsync("colt-skills-serial-");
    try {
      const runtime = await runtimeOf(dir, loadedOf([]));
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
      const runtime = await runtimeOf(dir, loadedOf([]));
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
      const runtime = await runtimeOf(dir, loadedOf(two));

      await Promise.all([
        runtime.enqueue(() =>
          handleSkillsCommand({ type: "skillsSetDisabled", name: "a", disabled: true }, runtime.host),
        ),
        runtime.enqueue(() =>
          handleSkillsCommand({ type: "skillsSetDisabled", name: "b", disabled: true }, runtime.host),
        ),
      ]);

      const written = JSON.parse(await readFile(join(dir, ".colt", "skills.json"), "utf8")) as {
        disabled?: string[];
      };
      assert.deepEqual([...(written.disabled ?? [])].sort(), ["a", "b"], "并发改禁用不该丢写");
    } finally {
      await removeTempDirAsync(dir);
    }
  });
});
