/**
 * IPC 契约的**防漂移回退**守卫。
 *
 * 定位先说清楚，免得将来被误用或被悄悄削弱：
 * 它守的是**「协议与实现有没有走散」**，**不是「功能行为对不对」**。
 * 某个通道注册了但 handler 里是空的、事件发了但载荷错了——本文件一概看不见，
 * 那些要靠真起 `ipc/index.ts` 的测试。它只回答一个问题：
 * **这套通道名 / 事件名的集合，两边是不是同一份。**
 *
 * 背景：`protocol.ts` 已经有双向编译期断言（通道白名单 ↔ `IpcInvokeMap` 的键、
 * 事件白名单 ↔ `IpcEventMap` 的键），`preload` 的白名单也与协议同源。
 * 但这些断言只保证「两边**类型**对得上」，**不保证任何一边真的被实现或真的被用**。
 *
 * 结果是长出过这样一批东西：通道在协议里声明了、在主进程里注册了 handler，
 * 但全仓没有一处调用它（`app.info` / `secrets.status` / `session.steer`）；
 * 事件声明了类型、却既没有发送点也没有监听点（`file.changed`）。
 * 类型检查全绿、单测全绿，没有任何一道工序能发现——因为从来没人断言过「覆盖」。
 *
 * 这里补上那一道工序：把「协议 ↔ 实现」的两个集合各自断言成**相等**（不是包含）。
 * 相等才能两边都防：漏注册（渲染层调用会挂起）与多注册（协议里没有，白名单直接拒）。
 *
 * 做法与 `set-model.test.ts` 一致：**读源码文本**而不是 import。
 * `ipc/index.ts` 与 `session-manager.ts` 都直接依赖 electron，node 测试里起不来。
 * 这个折衷是正当的，但代价要知道：
 *   - **会假红**：把 `handle("x", …)` 改成表驱动分发这类**无害重构**，本文件会变红，
 *     而行为一点没变。这时该改的是**本文件的正则**，不是把「相等」降级成「包含」——
 *     降级会把漏注册与多注册一起放过，守卫就白写了。
 *   - **会假绿**：通道名若来自**变量**（动态注册），正则看不见它，
 *     「多注册」那条会静默通过；同时已注册的通道还会被 `missing` 误判成漏注册（假红）。
 *     真出现动态注册，说明这套正则已经不够用，得换成能覆盖它的写法。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_CHANNELS, IPC_EVENTS } from "../src/shared/protocol.ts";

const SRC_MAIN = fileURLToPath(new URL("../src/main", import.meta.url));

/** 递归收集 src/main 下的 .ts 文件（事件发送点分散在多个模块里，不能只看一个文件） */
function mainSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith(".ts")) out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(SRC_MAIN);
  return out;
}

const IPC_INDEX = readFileSync(join(SRC_MAIN, "ipc/index.ts"), "utf8");
const MAIN_SOURCES = mainSources();

/** 取出源码里所有 `handle("x"` / `handleWithSender("x"` 的通道名 */
function registered(): Set<string> {
  const found = new Set<string>();
  const re = /\bhandle(?:WithSender)?\(\s*"([^"]+)"/g;
  for (const m of IPC_INDEX.matchAll(re)) found.add(m[1]!);
  return found;
}

/** 取出源码里所有事件发送点的名字：`#emit("x"` 与 `webContents.send("x"` */
function sentEvents(): Set<string> {
  const found = new Set<string>();
  // 注意 `#emit` 前不能加 \b：`this.#emit(` 里 `#` 不是单词字符，"." 与 "#" 之间不存在词边界，
  // 加了会让全部私有方法调用静默失配（表现为「所有事件都没发送」这种必然为假的结论）。
  const re = /(?:#emit|webContents\.send|\bsend)\(\s*"([a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*)"/g;
  for (const { text } of MAIN_SOURCES) {
    for (const m of text.matchAll(re)) found.add(m[1]!);
  }
  return found;
}

describe("IPC 契约覆盖：协议 ↔ 实现", () => {
  test("通道白名单本身没有重复项", () => {
    const dup = IPC_CHANNELS.filter((c, i) => IPC_CHANNELS.indexOf(c) !== i);
    assert.deepEqual(dup, [], `IPC_CHANNELS 有重复项：${dup.join(", ")}`);
  });

  test("协议里声明的通道，主进程必须都注册了 handler", () => {
    const reg = registered();
    const missing = IPC_CHANNELS.filter((c) => !reg.has(c));
    assert.deepEqual(
      missing,
      [],
      `这些通道在协议里声明了却没有 handler，渲染层一调用就会挂起：${missing.join(", ")}`,
    );
  });

  test("主进程注册的 handler，必须都在协议里声明过", () => {
    const declared = new Set<string>(IPC_CHANNELS);
    const extra = [...registered()].filter((c) => !declared.has(c));
    assert.deepEqual(
      extra,
      [],
      `这些 handler 没有对应的协议声明，会被 preload 白名单直接拒绝：${extra.join(", ")}`,
    );
  });

  test("协议里声明的事件，主进程必须真的发送过", () => {
    const sent = sentEvents();
    const never = IPC_EVENTS.filter((e) => !sent.has(e));
    assert.deepEqual(
      never,
      [],
      `这些事件声明了类型却从不发送，渲染层的监听永远等不到：${never.join(", ")}`,
    );
  });

  test("主进程发送的事件名，必须都在协议里声明过", () => {
    const declared = new Set<string>(IPC_EVENTS);
    const extra = [...sentEvents()].filter((e) => !declared.has(e));
    assert.deepEqual(
      extra,
      [],
      `这些发送点用了协议外的事件名，preload 白名单会直接丢掉：${extra.join(", ")}`,
    );
  });
});

/**
 * 「根只由主进程反查」的守卫。
 *
 * 背景（2026-10-11 的架构评审 🔴2）：`git.status` 原先收**渲染层给的 `cwd`**，而同组的
 * `git.committed`、`file.read`、`terminal.open` 全都只收 `sessionId` 再由主进程反查项目根。
 * 它破坏的不只是这一条通道：根同时决定审批边界（「项目内 = moderate、项目外 = 高危」），
 * 所以「谁决定根」是一条**不变量**，而当时的注释恰恰写着「渲染层会渲染 agent 生成的
 * Markdown，是不可信来源」——注释与代码在同一个文件里互相打脸。
 *
 * 为什么值得一条守卫：这条不变量**没有类型上的强制力**——契约里把 `sessionId` 换成
 * `cwd` 一样能编译通过，行为看起来也正常（chip 照样能显示），只是信任边界悄悄塌了一格。
 * 下一个照抄这条通道写法的人未必只读。
 */
describe("信任边界：文件系统根只由主进程反查", () => {
  const REPO = fileURLToPath(new URL("..", import.meta.url));
  const PROTOCOL = readFileSync(join(REPO, "src/shared/protocol.ts"), "utf8");
  const RENDERER_CONVERSATION = readFileSync(
    join(REPO, "src/renderer/src/features/Conversation/index.tsx"),
    "utf8",
  );
  /**
   * 取协议里某个通道的**请求形状**源码。
   *
   * 从 `request:` 切到它那一行的 `;` 为止——不能切到下一个 `};`：`request: { sessionId: string };`
   * 本身就以 `};` 结尾，那样会把结尾的 `}` 一起切掉，于是「形状里有闭合括号」的断言永远为假
   * （我第一版就是这么写的，被这条用例自己逮住）。
   */
  function requestShape(channel: string): string {
    const at = PROTOCOL.indexOf(`"${channel}": {`);
    assert.notEqual(at, -1, `协议里找不到通道 ${channel}`);
    const start = PROTOCOL.indexOf("request:", at);
    assert.notEqual(start, -1, `${channel} 的声明里找不到 request:`);
    const end = PROTOCOL.indexOf(";", start);
    assert.notEqual(end, -1, `${channel} 的 request 没有以 ; 结束`);
    return PROTOCOL.slice(start, end);
  }

  /** 取 `handle("<name>"` 起到下一个 `handle(` 为止的**整段** handler 源码 */
  function handlerBody(channel: string): string {
    const from = IPC_INDEX.indexOf(`handle("${channel}"`);
    assert.notEqual(from, -1, `找不到 ${channel} 的 handler（改成了别的注册方式？请更新本用例而不是删掉它）`);
    const next = IPC_INDEX.indexOf("handle(", from + 10);
    return IPC_INDEX.slice(from, next === -1 ? undefined : next);
  }

  test("git.status 的请求里只有 sessionId，没有路径", () => {
    const shape = requestShape("git.status");
    assert.match(shape, /request:\s*\{\s*sessionId:\s*string\s*\}/);
    assert.doesNotMatch(shape, /\bcwd\b/, "请求里不该再出现 cwd");
    assert.doesNotMatch(shape, /\bpath\b/, "请求里不该出现任何路径字段");
  });

  test("git.status 的 handler 不接受渲染层给的路径，且认草稿会话", () => {
    // ⚠️ 必须看**整段** handler，不能只看 `handle("git.status"` 那一行：
    // 这个 handler 是多行的，只取首行等于把「第二行起再塞一个 request.cwd」放过
    // （我第一版就是这么写的——守卫看着在守，实际漏一半）。
    const body = handlerBody("git.status");
    assert.doesNotMatch(body, /request\.cwd/, "handler 里又出现了渲染层给的路径");
    assert.match(body, /request\.sessionId/, "handler 应当按 sessionId 反查根");
    // 草稿态也要能答出根：会话要等首条消息才落库，而会话头的 chip 在草稿态就该显示
    assert.match(IPC_INDEX, /resolveSessionRootOrDraft/, "缺少草稿感知的根解析");
    assert.match(IPC_INDEX, /drafts\.get\(/, "草稿感知必须真的读 drafts，否则草稿态会落空");
    // 判据必须是「会话是否真的不存在」，不能用 catch 兜住一切（那会连库故障一起咽掉）
    const helper = IPC_INDEX.slice(IPC_INDEX.indexOf("function resolveSessionRootOrDraft"));
    const helperBody = helper.slice(0, helper.indexOf("\n}\n"));
    assert.match(helperBody, /getSession\(sessionId\)/, "该先用 getSession 判断存在性");
    assert.doesNotMatch(helperBody, /catch/, "不要用 catch 兜——真故障（库没初始化）不该被当成「不是仓库」");
  });

  test("渲染层调用 git.status 时只传 sessionId", () => {
    const calls = [...RENDERER_CONVERSATION.matchAll(/invoke\("git\.status",\s*(\{[^}]*\})/g)];
    assert.equal(calls.length, 1, "预期恰好一处 git.status 调用点");
    const args = calls[0]![1]!;
    assert.match(args, /\bsessionId\b/);
    assert.doesNotMatch(args, /\bcwd\b/, "渲染层不得再传 cwd —— 那就是把根交给不可信来源");
  });
});
