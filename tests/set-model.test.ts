/**
 * 切换模型的契约测试。
 *
 * 回归背景（用户实测）：「选不了模型，选模型时报错：会话未运行，死循环了」。
 * 三个缺陷叠加：
 *  1. Conversation 在缺密钥时直接 return，不发 session.open → 会话没有 worker；
 *  2. session.setModel 走裸 #post → 没有 worker 时抛「会话未运行」，且**不落库**；
 *  3. 模型下拉列出所有 provider 的模型（含无密钥的）→ 选中即触发 2。
 * 于是用户「选了报错、报错再选」，重启后 model_ref 仍是旧值，看上去就是死循环。
 *
 * session-manager 依赖 Electron（utilityProcess / app），没法在 node 测试里起真实
 * worker。这里退一步做**源码契约**校验：把「不许直连 #post」这条不变量钉住，
 * 避免以后有人图省事把 setModel 改回裸投递、让 bug 复现。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../src/main/session-manager.ts", import.meta.url), "utf8");
const IPC_SOURCE = readFileSync(new URL("../src/main/ipc/index.ts", import.meta.url), "utf8");

/**
 * 取出一个方法体（从 `名(` 起到方法自身的收尾 `}` 为止）。
 *
 * 收尾必须认「独占一行的 `  }`」：形参里的多行内联类型（`{ ... }): Promise<void> {`）
 * 也会以 `  }` 开头，只按 `\n  }` 找会在签名处提前截断，把函数体整个丢掉。
 */
function methodBody(name: string): string {
  const start = SOURCE.indexOf(`\n  ${name}(`);
  const alt = SOURCE.indexOf(`\n  async ${name}(`);
  const from = start !== -1 ? start : alt;
  assert.notEqual(from, -1, `找不到方法 ${name}`);
  const rest = SOURCE.slice(from);
  const closing = /\n  \}(\r?\n|$)/.exec(rest);
  assert.ok(closing, `方法 ${name} 没有正常闭合`);
  return rest.slice(0, closing.index);
}

/**
 * 取一个 IPC handler 的源码片段：从 `handle("<name>"` 起，到**下一个** `handle(` 为止。
 *
 * 不要写成「到某个具体的相邻 handler 为止」——早先这里是切到 `handle("session.steer"`，
 * 而那个通道后来被当成死代码删掉了，切片边界随之失效（indexOf 返回 -1 → slice 到 -1 →
 * 拿到空串 → 断言以「找不到」的形式失败，看不出是邻居没了）。以「下一个 handle」为界，
 * 增删邻居都不会破。
 */
function handlerBody(name: string): string {
  const start = IPC_SOURCE.indexOf(`handle("${name}"`);
  assert.notEqual(start, -1, `找不到 ${name} 处理器`);
  const rest = IPC_SOURCE.slice(start);
  const next = /\n\s+handle(?:WithSender)?\("/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

describe("session.setModel 的自愈契约", () => {
  test("setModelOrReconnect 先落库，再决定是否投递", () => {
    const body = methodBody("setModelOrReconnect");
    const persistAt = body.indexOf("setSessionModel(");
    const postAt = body.indexOf("this.setModel(");
    assert.notEqual(persistAt, -1, "必须落库 model_ref，否则重启后选择丢失");
    assert.notEqual(postAt, -1, "有 worker 时应把切换下发给 worker");
    assert.ok(
      persistAt < postAt,
      "落库必须早于投递：投递可能失败（worker 不在池中），选择不能因此丢失",
    );
  });

  test("无 worker 且未给 recover 时直接返回，不抛错", () => {
    const body = methodBody("setModelOrReconnect");
    assert.match(
      body,
      /if \(!recover\) return;/,
      "没有 cwd 时不该抛「会话未运行」——只落库即可，下次打开会话会带上新模型",
    );
  });

  test("rebuild 失败被吞掉并记日志，不冒泡给界面", () => {
    const body = methodBody("setModelOrReconnect");
    assert.match(
      body,
      /\.catch\(/,
      "重建失败必须 catch：模型已落库，不该让界面弹红",
    );
    assert.match(body, /console\.error/, "失败要留日志，不能静默吞掉");
  });

  test("setModel 仍走 #post（有 worker 时才调用），守住「未运行」错误的唯一来源", () => {
    const body = methodBody("setModel");
    assert.match(body, /this\.#post\(/, "setModel 是给已在池中的 worker 用的");
  });

  test("IPC 处理：无密钥的 provider 只落库并回 needsKey，不启动会话", () => {
    const body = handlerBody("session.setModel");
    assert.match(body, /hasSecret\(/, "必须先判断密钥：没密钥时启动 worker 必然失败");
    assert.match(body, /needsKey: true/, "无密钥要回可识别的信号，让界面引导去设置页");
    assert.match(
      body,
      /setSessionModel\(/,
      "无密钥时也要落库：用户常常是先选服务、再去填它的密钥",
    );
    assert.match(body, /setModelOrReconnect\(/, "有密钥时走自愈路径");
  });
});

/**
 * worker **就绪前**的命令投递契约。
 *
 * 回归背景（用户实测）：切模型报错「会话尚未初始化」。根因是「在池中」被当成「能收命令」：
 * 条目在 fork 之后立刻进 `#workers`，而 worker 的 `init`（重放整份 JSONL，历史大时要好几秒）
 * 才把 `state` 建好。这期间下发任何命令，worker 都会从 `if (!state)` 抛「会话尚未初始化」。
 *
 * 修法是让 `#post` 成为唯一屏障：就绪前一律暂存、ready 时按序补发。
 * 这里把三条不能破的边钉住，防止以后有人「图省事」把某条命令改回裸投递。
 */
describe("worker 就绪前的命令投递契约", () => {
  test("#post 在未就绪时暂存命令并保序，而不是直接下发", () => {
    const body = methodBody("#post");
    assert.match(body, /entry\.pendingCommands/, "未就绪时不能直接下发");
    assert.match(body, /push\(command\)/, "暂存要保序，后到的不能插队");
  });

  test("init 直接下发、不走 #post（否则会被暂存，worker 永不就绪）", () => {
    const body = methodBody("#spawnWorker");
    assert.match(body, /child\.postMessage\(\{\s*type: "init"/, "init 必须直接下发");
    assert.doesNotMatch(
      body,
      /#post\([\s\S]{0,40}type: "init"/,
      "init 若走 #post 会被「就绪前暂存」攒起来永不发出，worker 永远不就绪",
    );
  });

  test("ready 时先按序补发暂存命令，再放行等待方", () => {
    const body = methodBody("#spawnWorker");
    const flushAt = body.indexOf("for (const command of queued)");
    const resolveAt = body.indexOf("readyDeferred.resolve()");
    assert.notEqual(flushAt, -1, "就绪时必须补发暂存命令");
    assert.ok(
      flushAt < resolveAt,
      "补发必须早于 resolve：否则「就绪后下发的」会插到「就绪前下发的」前面，命令乱序",
    );
  });

  test("init 致命失败时解除暂存标记，不留下静默吞命令的黑洞", () => {
    const body = methodBody("#spawnWorker");
    assert.match(
      body,
      /entry\.pendingCommands = undefined;[\s\S]*readyDeferred\.reject/,
      "init 失败后 worker 永远不会就绪：不解除标记，后续命令会被静默攒着、界面毫无反馈",
    );
  });
});
