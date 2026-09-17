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
