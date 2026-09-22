/**
 * 草稿会话的契约测试。
 *
 * 回归背景：`session.create` 过去立刻 INSERT 一行，于是「点了新建就退出」会在侧栏留下
 * 一串 `message_count=0`、点开还没反应的空会话——用户一个字都没发过。
 * 现在改为**首次发消息才落库**：新建只分配 id（草稿），不 fork worker、不建 JSONL。
 *
 * ipc 层依赖 Electron，node 测试里起不了真进程，故这里做**源码契约**校验，
 * 把「谁负责落库」这条不变量钉住：一旦有人在 create 里重新写库、或让草稿提前拉起
 * worker，用例立刻变红。端到端行为由冒烟的 [session/draft] 用例覆盖。
 *
 * 后半段是同一族的两件事：**丢弃草稿**（`session.discardDraft`）与**起手区的新工作目录**
 * （`project.createScratch` + `scratch-dir` 的路径算术）——它们都只在「会话还没用起来」时出场。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  WORKSPACE_LEAF,
  defaultScratchBase,
  scratchDirName,
  scratchRootPath,
} from "../src/main/lib/scratch-dir.ts";

const IPC_SOURCE = readFileSync(new URL("../src/main/ipc/index.ts", import.meta.url), "utf8");

/** 取出某个 IPC handler 的函数体（从 `handle("名"` 起到下一个 handler 为止） */
function handlerBody(channel: string): string {
  const start = IPC_SOURCE.indexOf(`handle("${channel}"`);
  assert.notEqual(start, -1, `找不到通道 ${channel}`);
  const end = IPC_SOURCE.indexOf("handle(", start + 1);
  return IPC_SOURCE.slice(start, end === -1 ? undefined : end);
}

describe("草稿会话：首次发消息才落库", () => {
  test("session.create 不写库，只登记草稿", () => {
    const body = handlerBody("session.create");
    assert.doesNotMatch(body, /createSession\(/, "create 一旦落库，空会话就会重新出现");
    assert.match(body, /drafts\.set\(/, "必须登记成草稿，否则首次发消息无从落库");
  });

  test("session.open 对草稿直接返回，不为它 fork worker", () => {
    const body = handlerBody("session.open");
    assert.match(body, /drafts\.has\([\s\S]*?\)\s*return/, "草稿不该被 session.open 拉起");
    assert.match(body, /openSessionWorker\(/, "非草稿仍要正常打开");
  });

  test("session.prompt 先落库再投递（worker 启动时要读得到会话行）", () => {
    const body = handlerBody("session.prompt");
    const materializeAt = body.indexOf("materializeDraft(");
    const postAt = body.indexOf("promptOrReconnect(");
    assert.notEqual(materializeAt, -1, "首次发消息必须落库");
    assert.notEqual(postAt, -1, "找不到投递路径，用例本身需要更新");
    assert.ok(materializeAt < postAt, "落库必须早于投递");
  });

  test("session.compact 同样先落库（它也会把 worker 拉起来）", () => {
    const body = handlerBody("session.compact");
    assert.match(body, /materializeDraft\(/, "compact 也会 fork worker，同样必须先有会话行");
  });

  test("session.setModel 对草稿只记内存：不写库、也不拉起 worker", () => {
    const body = handlerBody("session.setModel");
    const draftAt = body.indexOf("drafts.get(");
    assert.notEqual(draftAt, -1, "草稿上的选择要记在草稿里");
    assert.ok(
      draftAt < body.indexOf("setSessionModel("),
      "草稿还没落库，UPDATE 会打在 0 行上——必须在落库分支之前拦截",
    );
    assert.ok(
      draftAt < body.indexOf("setModelOrReconnect("),
      "草稿不该因为「切个模型」就被拉起 worker",
    );
  });

  test("session.delete 对草稿只丢内存记录", () => {
    assert.match(handlerBody("session.delete"), /drafts\.delete\(/);
  });

  test("materializeDraft 沿用草稿 id，并带上草稿期选定的模型", () => {
    const start = IPC_SOURCE.indexOf("function materializeDraft(");
    assert.notEqual(start, -1, "找不到 materializeDraft");
    const body = IPC_SOURCE.slice(start, IPC_SOURCE.indexOf("\n}", start));
    assert.match(
      body,
      /draft\.projectId, jsonlPathFor\(draft\.projectId\), sessionId/,
      "必须沿用界面手里的那个 id，否则界面持有的会话不存在",
    );
    assert.match(body, /if \(draft\.modelRef\) setSessionModel\(/, "草稿期选定的模型要跟着落库");
  });
});

describe("丢弃草稿：session.discardDraft", () => {
  test("只丢内存记录，不去动库（能用它的一定还没落库）", () => {
    const body = handlerBody("session.discardDraft");
    assert.match(body, /drafts\.delete\(request\.sessionId\)/, "丢弃要落到那张内存表上");
    assert.doesNotMatch(body, /deleteSession\(/, "它不该去删库里的行——那属于 session.delete");
  });

  test("如实回报「丢掉了没」：渲染层据此知道该不该刷新侧栏", () => {
    assert.match(handlerBody("session.discardDraft"), /discarded:/);
  });
});

describe("新建工作目录：project.createScratch", () => {
  test("先建目录、再登记项目（否则库里会多出一个不存在的路径）", () => {
    const body = handlerBody("project.createScratch");
    const mkdirAt = body.indexOf("mkdirSync(");
    const upsertAt = body.indexOf("upsertProject(");
    assert.notEqual(mkdirAt, -1, "找不到建目录");
    assert.notEqual(upsertAt, -1, "找不到登记项目");
    assert.ok(mkdirAt < upsertAt, "目录必须先存在：登记之后渲染层马上会去打开它");
    assert.match(body, /scratchRootPath\(/, "路径要由纯函数算，别在 handler 里现拼时间戳");
  });
});

describe("注销工作区：project.delete", () => {
  test("「运行中」检查排在任何删除动作之前——拒绝时库与磁盘都还没动过", () => {
    const body = handlerBody("project.delete");
    const guardAt = body.indexOf("isRunning(");
    assert.notEqual(guardAt, -1, "找不到运行态检查：守卫缺失，运行中的会话会被连根删掉");
    assert.ok(
      guardAt < body.indexOf("sessionManager.close("),
      "关 worker 必须排在拒绝之后，否则「拒绝」已经有了副作用",
    );
    assert.ok(
      guardAt < body.indexOf("deleteProject("),
      "删库必须排在拒绝之后，否则拒绝之后数据已经回不来了",
    );
  });

  test("项目不存在时如实报错，而不是静默成功", () => {
    assert.match(handlerBody("project.delete"), /if \(!getProject\(request\.projectId\)\) throw/);
  });
});

describe("起手区的目录算术（scratch-dir）", () => {
  test("默认父目录是家目录下的 .colt/（与用户级记忆同一个命名空间）", () => {
    assert.equal(defaultScratchBase(join("/home", "u")), join("/home", "u", ".colt"));
  });

  test("目录名精确到秒，月/日/时/分/秒都补零", () => {
    // 用本地时间构造，避免时区把断言带偏
    assert.equal(scratchDirName(new Date(2026, 8, 19, 15, 30, 45)), "20260919-153045");
    assert.equal(scratchDirName(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405");
  });

  test("完整路径是 <父目录>/<时间戳>/workspace：项目根名固定，引用它不必跟着时间戳变", () => {
    assert.equal(
      scratchRootPath("/base", new Date(2026, 8, 19, 15, 30, 45)),
      join("/base", "20260919-153045", "workspace"),
    );
    // 最后一段必须就是那个固定叶子——换名会让「项目根目录叫 workspace」这条承诺失效
    assert.equal(
      scratchRootPath("/base", new Date(2026, 8, 19, 15, 30, 45)).split(/[\\/]/).pop(),
      WORKSPACE_LEAF,
    );
  });

  test("相隔一秒的两次「新建工作目录」得到**两个**目录（两次意图不能共用一个地方）", () => {
    const first = scratchRootPath("/base", new Date(2026, 8, 19, 15, 30, 45));
    const second = scratchRootPath("/base", new Date(2026, 8, 19, 15, 30, 46));
    assert.notEqual(first, second);
    // 而且必须只差最后那个时间戳层：父目录与叶子都不能跟着变
    assert.equal(dirname(dirname(first)), dirname(dirname(second)));
  });

  test("同一秒内重复算出同一个路径（那是双击，一次意图别攒两个空目录）", () => {
    const a = scratchRootPath("/base", new Date(2026, 8, 19, 15, 30, 45, 100));
    const b = scratchRootPath("/base", new Date(2026, 8, 19, 15, 30, 45, 900));
    assert.equal(a, b);
  });

  test("override 非空时原样使用（冒烟靠它把产物钉在 out/ 下、不污染真实家目录）", () => {
    const at = new Date(2026, 8, 19, 15, 30);
    assert.equal(scratchRootPath("/base", at, "/tmp/x"), "/tmp/x");
    assert.equal(scratchRootPath("/base", at, "  /tmp/x  "), "/tmp/x");
    // 原样 = 既不拼时间戳也不拼 workspace/：覆盖的是**最终项目根**，不是父目录
    assert.equal(scratchRootPath("/base", at, "/tmp/x").endsWith(WORKSPACE_LEAF), false);
  });

  test("override 为空串或纯空白时回落到默认（空串不等于「指定了目录」）", () => {
    const at = new Date(2026, 8, 19, 15, 30, 45);
    // 这条测的是**回落行为**，不是时间戳格式（格式由上面两条钉住），所以按同源函数算期望
    const expected = join("/base", scratchDirName(at), "workspace");
    assert.equal(scratchRootPath("/base", at, ""), expected);
    assert.equal(scratchRootPath("/base", at, "   "), expected);
    assert.equal(scratchRootPath("/base", at), expected);
  });
});
