/**
 * 压缩设置**接线**的契约测试（源契约，不 import 那两个模块）。
 *
 * 为什么值得单独一条：这一条链有四段，**任何一段断了都不会报错**
 * ——设置页能保存、界面显示新值、看着一切正常，而 worker 用的还是旧阈值：
 *
 *   ① 协议声明两个通道          （缺 → 渲染层调用直接被 preload 白名单拒）
 *   ② 主进程 handler 落库 + 广播（缺广播 → 已开着的会话不生效，只有下次 init 才对）
 *   ③ init 载荷带上 compaction  （缺 → 新会话拿不到设置，全走内核默认值）
 *   ④ worker 收到 setCompaction 时**调内核**（只存变量 → 新阈值要等下次压缩才被读到）
 *
 * `session-manager` / `ipc` / `worker entry` 都依赖 Electron 或内核运行时，node 测试里
 * 起不来真进程，故这里读源码文本断言——与 `tests/set-model.test.ts` 同一手法。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const PROTOCOL = read("src/shared/protocol.ts");
const WORKER_PROTOCOL = read("src/shared/worker-protocol.ts");
const IPC = read("src/main/ipc/index.ts");
const MANAGER = read("src/main/session-manager.ts");
const WORKER_ENTRY = read("src/worker/entry.ts");
const SETTINGS_UI = read("src/renderer/src/features/Settings.tsx");

/** 取 `handle("<name>"` 起到下一个 `handle(` 为止的源码片段 */
function ipcHandler(name: string): string {
  const from = IPC.indexOf(`handle("${name}"`);
  assert.notEqual(from, -1, `ipc 里没有注册 ${name}`);
  const next = IPC.indexOf("handle(", from + 10);
  return IPC.slice(from, next === -1 ? undefined : next);
}

describe("① 协议层：两个通道都在，且请求形状正确", () => {
  test("通道名进了白名单与调用映射", () => {
    for (const channel of ["compaction.config.get", "compaction.config.set"]) {
      // 白名单里出现一次（列表项）、映射里声明一次
      const occurrences = PROTOCOL.split(`"${channel}"`).length - 1;
      assert.ok(occurrences >= 2, `${channel} 在白名单或映射里缺失`);
    }
  });

  test("请求形状：get 无参，set 收 config 并回**归一化后**的值", () => {
    const set = PROTOCOL.slice(PROTOCOL.indexOf('"compaction.config.set": {'));
    assert.match(set.slice(0, 300), /request:\s*\{\s*config:\s*unknown\s*\}/);
    // 回的是 config 类型（不是 unknown）：界面要拿它显示真实生效值
    assert.match(set.slice(0, 300), /response:\s*\{\s*config:\s*CompactionConfig/);
  });
});

describe("② 主进程：落库 + 广播（缺广播就只有下次 init 才生效）", () => {
  test("get 会带上 isDefault（界面据此说「跟随默认」而不是复述数字）", () => {
    assert.match(ipcHandler("compaction.config.get"), /isDefault:\s*isDefaultCompactionConfig\(/);
  });

  test("set 先归一化落库、再广播，且返回归一化后的值", () => {
    const body = ipcHandler("compaction.config.set");
    assert.match(body, /setCompactionConfig\(request\.config\)/, "没走归一化的写入路径");
    assert.match(body, /broadcastCompactionConfig\(config\)/, "落库了但没广播");
    assert.match(body, /return\s*\{\s*config/, "返回值该是归一化后的 config，不是回显");
  });

  test("广播真的推给池中全部 worker，且用的是 #post（就绪前会排队补发）", () => {
    const from = MANAGER.indexOf("broadcastCompactionConfig(");
    assert.notEqual(from, -1);
    const body = MANAGER.slice(from, MANAGER.indexOf("\n  }", from));
    assert.match(body, /this\.#workers\.keys\(\)/, "只推给部分 worker？压缩是全局设置");
    assert.match(body, /this\.#post\(/, "绕过 #post 会在 worker 未就绪时被直接拒绝");
    assert.match(body, /type:\s*"setCompaction"/, "命令名与 worker 侧必须一致");
  });
});

describe("③ init 载荷：新会话必须拿到设置（否则全走内核默认值）", () => {
  test("契约里有 compaction 字段且不是可选的", () => {
    const init = WORKER_PROTOCOL.slice(WORKER_PROTOCOL.indexOf('type: "init"'));
    assert.match(init.slice(0, 4000), /\n\s+compaction:\s*CompactionConfig;/, "字段缺失或成了可选");
  });

  test("主进程 fork 时把它塞进 init", () => {
    assert.match(MANAGER, /compaction:\s*getCompactionConfig\(\)/, "init 里没带上设置");
  });

  test("worker 把它交给 harness.create（不是自己存着）", () => {
    assert.match(WORKER_ENTRY, /compaction:\s*command\.compaction/, "harness.create 没收到设置");
  });
});

describe("④ 运行中变更：必须调内核，而不是只改自己的变量", () => {
  test("worker dispatch 有 setCompaction 分支", () => {
    assert.match(WORKER_ENTRY, /case "setCompaction":/, "命令没人处理：设置改了但运行中的会话不变");
  });

  test("该分支调 harness.setCompactionSettings（改了当轮生效）", () => {
    const from = WORKER_ENTRY.indexOf('case "setCompaction":');
    const body = WORKER_ENTRY.slice(from, WORKER_ENTRY.indexOf('case "', from + 10));
    assert.match(
      body,
      /setCompactionSettings\(command\.config/,
      "没调内核的 setCompactionSettings：新阈值要等下次压缩才被读到",
    );
  });
});

describe("⑤ 界面：设置页真的提供了入口（否则「可调」只是后端的自说自话）", () => {
  test("Settings.tsx 读写这两个通道", () => {
    assert.match(SETTINGS_UI, /invoke\("compaction\.config\.get"/, "设置页没有读入口");
    assert.match(SETTINGS_UI, /invoke\("compaction\.config\.set"/, "设置页没有写入口");
  });

  test("界面用 describeCompaction 说明「现在是什么行为」（可见性正是 A2 的诉求）", () => {
    assert.match(SETTINGS_UI, /describeCompaction/, "只给三个输入框、不解释行为，用户看不懂在调什么");
  });
});
