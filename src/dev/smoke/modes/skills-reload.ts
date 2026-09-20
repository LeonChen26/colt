// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：skills-reload
 *
 * 技能的**设置页可见性 + 热重载**链路（**不调模型、不计费**）。
 *
 * 为什么单独一条：单测覆盖了装载纯函数与 `skills-command` 的编排，但**从渲染层到主进程、
 * 再到 worker、再绕回来**这一段——`skills.status` / `skills.rescan` 两个 IPC →
 * `SessionManager` 的 FIFO 兑现 → worker 的 `skillsStatus` / `skillsRescan` 命令 →
 * 重扫 + `harness.setResources` 写回——此前**一个字节都没验过**。这段全是「名字对不上就
 * 静默失效」的接线（协议字段名、FIFO 配对、命令路由），与 `mcp-reload` 同源
 * （`AGENTS.md` §四「只有定义、没有调用」那一类，必须跑一遍真实链路才放得下心）。
 *
 * 夹具：`out/smoke-skills-fixture/.agents/skills/`，全程改写三版：
 * ① 只有 `alpha`（短正文）→ ② 加上 `beta`（新增技能，**不重启会话**即可用）→
 * ③ 加上 `big`（正文远超上限：给用户看的是**全文**，告警如实说模型只收到截断后的）。
 * 另有一个**永远不开会话**的项目 `out/smoke-skills-other`，验「没有活 worker」那条退路。
 *
 * 与 `mcp-reload` 一样**不含设置页 DOM 断言**：设置页那段跟渲染层的 `activeProject` 走，
 * 而冒烟里它是渲染层自己的选择（并发参与者）。界面层的判据落在这两个 IPC 上——组件只是
 * 把它们画出来；DOM 那一半靠人工看一眼截图。
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSession, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { isolateUserHome, sleep, uncaughtErrors } from "../context";

/**
 * `big` 技能的正文长度：刻意远大于任何合理上限，用来验「超长正文只把前半段交给模型」。
 * 若上限被调到这个量级，③ 组的告警断言会**当场红**——而不是静默地不再测到截断。
 */
const BIG_BODY_CHARS = 100_000;

/** alpha 的正文：断言「设置页看到的就是文件里那样」时**逐字**比对（frontmatter 之后、trim 过） */
const ALPHA_BODY = "alpha 的正文：先读文件再动手。";

const skillMd = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: 夹具技能 ${name}\n---\n\n${body}\n`;

export async function runSkillsReload(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-skills-fixture");
  const otherDir = join(process.cwd(), "out", "smoke-skills-other");
  const skillsDir = join(fixtureDir, ".agents", "skills");

  const writeSkill = (name: string, body: string): void => {
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd(name, body), "utf8");
  };

  /** 只把文本写进输入框、**不回车**——`/` 候选浮层要在「还没提交」的状态下观察 */
  const typeIntoInput = (text: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);

  /** 当前 `/` 候选（`data-slash-item` 的值，见 `slashCandidates`：存的是**整条命令**，不是名字） */
  const slashItems = (): Promise<string[]> =>
    run<string[]>(
      `[...document.querySelectorAll("[data-slash-menu] [data-slash-item]")]` +
        `.map((el) => el.getAttribute("data-slash-item") ?? "")`,
    );

  /**
   * 候选里**技能**那一列的名字。
   *
   * ⚠️ 别拿 `slashItems()` 直接 `.includes("beta")` 判「排除了没」：`data-slash-item` 是**整条
   * 命令**（`/skill beta`），而 `Array.includes` 是**整串相等**——`["/skill beta"].includes("beta")`
   * 恒为 **false**，于是「禁用后不含 beta」这条会**必然为真**（真没排除也过）。这类「必然为真的
   * 假阴性」比红断言贵得多（`AGENTS.md` §四 同款）。剥掉前缀、断言落在**裸名字**上，比对就是
   * 整串相等，两个方向都分得清。
   */
  const skillNamesOf = (items: string[]): string[] =>
    items
      .filter((item) => item.startsWith("/skill "))
      .map((item) => item.slice("/skill ".length));

  /** 读项目级偏好文件（落盘物证：断言别只看「函数被调过」） */
  const readDisabledList = (): string[] => {
    try {
      const parsed = JSON.parse(
        readFileSync(join(fixtureDir, ".colt", "skills.json"), "utf8"),
      ) as { disabled?: string[] };
      return parsed.disabled ?? [];
    } catch {
      return [];
    }
  };

  // 起点干净：上一次运行留下的技能目录 / 偏好文件会让「初始只有 alpha」变成假红
  rmSync(join(fixtureDir, ".agents"), { recursive: true, force: true });
  rmSync(join(fixtureDir, ".colt"), { recursive: true, force: true });
  writeSkill("alpha", ALPHA_BODY);
  // 用户级那份也要显式置空：本模式断言的是「初始只有 alpha（+ 内置）」，而用户级
  // `~/.agents/skills` 与 `~/.colt/skills.json` 对本机所有项目生效——开发机上装过技能时，
  // 清单会多出几条、甚至出现被用户级禁用的名字（`AGENTS.md` §五⑬：前提要自己建立）。
  isolateUserHome("skills-reload", log);
  // 本模式是**唯一**要验「内置技能真的随包带上了」的地方，所以要把 `runSmoke` 装的那个
  // 「内置目录指向空目录」的隔离口**撤掉**，让 worker 去解析**真实的**随包目录
  // （`out/main/builtin-skills`）。必须在会话 fork 之前删——worker 继承的是 fork 那一刻的
  // 环境（`session-manager` 的 `...process.env`），晚一步就只能验到那个空目录了。
  delete process.env.COLT_BUILTIN_SKILLS_DIR;
  log("内置技能目录：撤掉冒烟的隔离口，验随包那份（out/main/builtin-skills）");
  mkdirSync(otherDir, { recursive: true });
  const otherProject = upsertProject(otherDir);

  // ⚠️ 必须**跨毫秒**：`listProjects()` 只按 `last_opened_at DESC` 排、没有次级键，
  // 两次 upsert 落在同一毫秒时排序不定，渲染层自动打开的可能是**没有会话的那个项目**
  // （同 `mcp-reload` 与 `AGENTS.md` ⑬：前提要显式建立，别指望「恰好不同毫秒」）。
  await sleep(5);
  // 顺序有意：夹具项目**最后** upsert，last_opened_at 严格最新 ⇒ 渲染层自动打开它
  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  log(`夹具项目：${fixtureDir}（.agents/skills 第一版：只有 alpha）`);
  log(`会话：${session.id}（项目：${project.name}）`);
  log(`无会话项目：${otherDir}`);

  const checks: [string, boolean][] = [];
  try {
    // 与 mcp-reload 同一条路：worker 的生死交给渲染层（挂载时自动打开「当前项目」的最新会话）
    window.reload();
    await sleep(4000);
    const readyDeadline = Date.now() + 60_000;
    let opened = false;
    while (Date.now() < readyDeadline) {
      if (sessionManager.getView(session.id)) {
        opened = true;
        break;
      }
      await sleep(1000);
    }
    checks.push(["渲染层自动打开夹具会话（worker 就绪）", opened]);
    if (!opened) return;

    // ① 冷启动装载：alpha 装上了，形状齐全——设置页画的就是这些字段
    const initial = await sessionManager.skillsStatus(session.id);
    const alpha = initial.skills.find((item) => item.name === "alpha");
    log(`初始状态：live=${initial.live}，技能=${initial.skills.map((s) => s.name).join("、")}`);
    checks.push([
      "冷启动装载：alpha 装上、来源=项目级、对模型公开，且**带正文全文**（「查看正文」的底子）",
      initial.live === true &&
        alpha !== undefined &&
        alpha.source === "project" &&
        alpha.modelInvocable === true &&
        alpha.content === ALPHA_BODY &&
        alpha.filePath.length > 0,
    ]);

    // ①b 内置技能：随应用分发，任何会话都会装上它，来源标成 builtin。
    // 这条钉的是**构建时真的把它复制进 out/ 了**——漏掉那一步它只会静默消失，
    // 而装载、告警、计数、设置页全都照常绿（`AGENTS.md` §四 那类「只有定义、没有调用」）。
    // 所以判据要落在**路径**上：它得来自产物目录里的 `builtin-skills/`，而不是仓库里的
    // `src/worker/lib/builtin-skills/`——只看「名字出现」的话，直接读源码树也能满足。
    const builtin = initial.skills.find((item) => item.name === "skill-creator");
    const builtinFromBuild =
      builtin !== undefined &&
      /[\\/]builtin-skills[\\/]/.test(builtin.filePath) &&
      !/[\\/]src[\\/]/.test(builtin.filePath);
    log(`内置技能：${builtin ? builtin.filePath : "（没装上）"}`);
    checks.push([
      "内置技能随包装载：skill-creator 在清单里、来源=内置、对模型公开、且**来自 out/ 那份产物**",
      builtinFromBuild && builtin.source === "builtin" && builtin.modelInvocable === true,
    ]);

    // ② 热重载：新增 beta —— 不重启会话就能用（报告 A2）
    writeSkill("beta", "beta 的正文。");
    const added = await sessionManager.skillsRescan(session.id);
    const addedNames = added.skills.map((item) => item.name);
    log(`加 beta 后：${addedNames.join("、")}`);
    checks.push([
      "重新扫描（加技能）：beta 当场出现、alpha 仍在——会话**没重启**",
      addedNames.includes("alpha") && addedNames.includes("beta"),
    ]);

    // ③ 超长正文：给用户看全文，告警如实说模型只收到截断后的（P7）
    writeSkill("big", "x".repeat(BIG_BODY_CHARS));
    const withBig = await sessionManager.skillsRescan(session.id);
    const big = withBig.skills.find((item) => item.name === "big");
    log(`加 big 后：技能=${withBig.skills.map((s) => s.name).join("、")}，告警=${withBig.warnings.length} 条`);
    checks.push([
      "超长正文：现状里给的是**全文**（用户看到的就是文件里那样，与给模型的那份不同）",
      big !== undefined && big.content.length === BIG_BODY_CHARS,
    ]);
    checks.push([
      "超长正文：告警如实说「模型只会收到截断后的正文」并点名 big（不静默）",
      withBig.warnings.some((line) => line.includes("截断") && line.includes("big")),
    ]);

    // ④ 两个 IPC 的返回形状（设置页看到的正是这两条）
    const live = await run<{ skills: { name: string; content: string }[]; live: boolean }>(
      `window.colt.invoke("skills.status", ${JSON.stringify({ projectId: project.id })})`,
    );
    checks.push([
      "IPC skills.status（有活会话）：live=true，清单里带正文（设置页据此渲染「查看正文」）",
      live.live === true &&
        live.skills.some((item) => item.name === "alpha" && item.content.length > 0),
    ]);

    const idle = await run<{ skills: unknown[]; live: boolean }>(
      `window.colt.invoke("skills.status", ${JSON.stringify({ projectId: otherProject.id })})`,
    );
    log(`无会话项目 skills.status：${JSON.stringify({ live: idle.live, count: idle.skills.length })}`);
    checks.push([
      "IPC skills.status（无活会话）：live=false 且清单为空（「没开会话」≠「没装」）",
      idle.live === false && idle.skills.length === 0,
    ]);

    const ipcRescan = await run<{ skills: { name: string }[]; live: boolean }>(
      `window.colt.invoke("skills.rescan", ${JSON.stringify({ projectId: project.id })})`,
    );
    checks.push([
      "IPC skills.rescan（有活会话）：live=true，重扫后三个技能都在",
      ipcRescan.live === true &&
        ["alpha", "beta", "big"].every((name) =>
          ipcRescan.skills.some((item) => item.name === name),
        ),
    ]);

    const idleRescan = await run<{ skills: unknown[]; live: boolean }>(
      `window.colt.invoke("skills.rescan", ${JSON.stringify({ projectId: otherProject.id })})`,
    );
    checks.push([
      "IPC skills.rescan（无活会话）：照实回 live=false，**不假装扫成功**",
      idleRescan.live === false && idleRescan.skills.length === 0,
    ]);

    // ⑤ 禁用（P6）：写项目级 `.colt/skills.json` → 当场重装 → 界面随之更新
    const offStatus = await run<{
      skills: { name: string; disabled: boolean; disabledByUser: boolean }[];
      live: boolean;
    }>(
      `window.colt.invoke("skills.setDisabled", ${JSON.stringify({ projectId: project.id, name: "beta", disabled: true })})`,
    );
    const betaOff = offStatus.skills.find((item) => item.name === "beta");
    log(`禁用 beta 后：live=${offStatus.live}，beta.disabled=${String(betaOff?.disabled)}`);
    checks.push([
      "IPC skills.setDisabled：现状里 beta 变「已禁用」（开关据此显示），且「不是用户级禁的」",
      offStatus.live === true && betaOff?.disabled === true && betaOff.disabledByUser === false,
    ]);
    // 落盘物证：偏好写在**项目级** `.colt/skills.json`（`.colt/` 被 gitignore，本地偏好不入库）
    checks.push([
      "落盘在项目级 `.colt/skills.json`（不是技能目录，也不进版本控制）",
      readDisabledList().includes("beta"),
    ]);

    // 界面侧的判据：`/` 候选**不该再列出**被禁用的技能——敲了必被拒的名字不该摆进候选
    await sleep(800); // 等 worker 的 publish + 视图重推落到渲染层
    await typeIntoInput("/");
    await sleep(400);
    const itemsAfterDisable = await slashItems();
    log(`禁用 beta 后 / 候选：${itemsAfterDisable.join("、")}`);
    checks.push([
      "`/` 候选排除被禁用的技能（不把用户往墙上引），别的技能照常列出",
      !skillNamesOf(itemsAfterDisable).includes("beta") &&
        skillNamesOf(itemsAfterDisable).includes("alpha"),
    ]);

    // ⑥ 启用回来：名字从名单里移除，候选也恢复
    const onStatus = await run<{
      skills: { name: string; disabled: boolean }[];
      live: boolean;
    }>(
      `window.colt.invoke("skills.setDisabled", ${JSON.stringify({ projectId: project.id, name: "beta", disabled: false })})`,
    );
    checks.push([
      "IPC skills.setDisabled（启用回来）：beta 回到「已启用」，名单里不再有它",
      onStatus.skills.find((item) => item.name === "beta")?.disabled === false &&
        !readDisabledList().includes("beta"),
    ]);
    await sleep(800);
    await typeIntoInput("/");
    await sleep(400);
    const itemsAfterEnable = await slashItems();
    log(`启用后 / 候选：${itemsAfterEnable.join("、")}`);
    checks.push([
      "启用后 `/` 候选恢复列出 beta（证明视图确实被重推，不是停在上一次）",
      skillNamesOf(itemsAfterEnable).includes("beta"),
    ]);
    await typeIntoInput("");

    // ⑦ 定位（P6）：「不做删除」的替代出口——只做形状校验，不读内容、不写盘
    // ⚠️ **不测成功路径**：`shell.showItemInFolder` 会真的弹出资源管理器，抢焦点、干扰
    // 同一趟里的其它断言。成功路径就是那一行调用，不值得弹一个窗口去验。
    const badShape = await run<{ ok: boolean; reason?: string }>(
      `window.colt.invoke("skills.reveal", ${JSON.stringify({ filePath: "/etc/passwd" })})`,
    );
    const ghost = await run<{ ok: boolean; reason?: string }>(
      `window.colt.invoke("skills.reveal", ${JSON.stringify({ filePath: join(skillsDir, "ghost", "SKILL.md") })})`,
    );
    log(`skills.reveal：坏形状=${JSON.stringify(badShape)}，文件不在=${JSON.stringify(ghost)}`);
    checks.push([
      "skills.reveal 对**任意路径**拒绝（只认 `.agents/skills/<名字>/SKILL.md`）",
      badShape.ok === false && typeof badShape.reason === "string",
    ]);
    checks.push([
      "skills.reveal 对**不存在的技能文件**如实回「已不在」（不是静默无反应）",
      ghost.ok === false && (ghost.reason ?? "").includes("不在"),
    ]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    try {
      await run(
        `window.colt.invoke("session.close", ${JSON.stringify({ sessionId: session.id })})`,
      );
    } catch (error) {
      log(`关闭会话失败（无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[skills-reload] 断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
