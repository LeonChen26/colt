/**
 * 协议白名单一致性测试。
 *
 * 渲染层只能调用 IPC_CHANNELS / IPC_EVENTS 里列出的通道，preload 会对未授权项直接抛错。
 * 漏登记会让渲染层在订阅瞬间崩溃，且类型检查发现不了——`satisfies` 只校验
 * 「写进去的合法」，抓不到「该写却没写」。故用测试强制两者与类型定义保持同步。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { IPC_CHANNELS, IPC_EVENTS } from "../src/shared/protocol.ts";

/**
 * 从共享协议里读出所有调用通道与事件的键名。
 * 用 ts-resolve hook 加载源码后无法直接拿到类型，故改为解析源码文本：
 * 类型定义就在同一文件里，解析简单且足以发现遗漏。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "shared", "protocol.ts"), "utf8");

function keysOf(interfaceName: string): string[] {
  const start = source.indexOf(`export interface ${interfaceName} {`);
  assert.ok(start >= 0, `未找到 interface ${interfaceName}`);
  // 取该 interface 的完整块（到下一个顶层 export 或文件末尾）
  const rest = source.slice(start);
  const end = rest.indexOf("\nexport ", 1);
  const block = end === -1 ? rest : rest.slice(0, end);
  return [...block.matchAll(/^\s{2}"([^"]+)":/gm)].map((match) => match[1]!);
}

describe("IPC 白名单同步", () => {
  test("所有调用通道都已登记", () => {
    const declared = keysOf("IpcInvokeMap");
    assert.ok(declared.length > 0, "未能解析出任何通道，检查解析逻辑");
    const registered = new Set<string>(IPC_CHANNELS);
    const missing = declared.filter((channel) => !registered.has(channel));
    assert.deepEqual(missing, [], `以下通道未登记到 IPC_CHANNELS，渲染层会调用失败：${missing}`);
  });

  test("所有事件都已登记", () => {
    const declared = keysOf("IpcEventMap");
    assert.ok(declared.length > 0, "未能解析出任何事件，检查解析逻辑");
    const registered = new Set<string>(IPC_EVENTS);
    const missing = declared.filter((event) => !registered.has(event));
    assert.deepEqual(missing, [], `以下事件未登记到 IPC_EVENTS，渲染层订阅时会崩溃：${missing}`);
  });

  test("白名单里没有多余项", () => {
    const channels = new Set(keysOf("IpcInvokeMap"));
    const events = new Set(keysOf("IpcEventMap"));
    assert.deepEqual(IPC_CHANNELS.filter((item) => !channels.has(item)), []);
    assert.deepEqual(IPC_EVENTS.filter((item) => !events.has(item)), []);
  });
});
