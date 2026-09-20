/**
 * 跨进程常量的**防漂移**守卫。
 *
 * 定位先讲清楚，免得将来被误用或悄悄削弱：
 * 它守的是「**同一个语义的阈值有没有被写成两份**」，**不是「这个值定得对不对」**。
 * 5 分钟合不合适、8000 字节够不够——本文件一概不管，那些是设计判断。
 *
 * 背景：`src/shared/limits.ts` 里的每个值都被 **main 与 worker 各读一次**，
 * 而两侧谁也不校验对方。漂成两份时的症状**不是报错**，是挂在半路：
 *   · 审批超时：main 按它自动拒绝、worker 按它解除阻塞。谁短谁先放弃，
 *     另一边还在等一个已经不存在的答复——界面停在「等待授权」，没有任何失败信号。
 *   · 嗅探字节：预览与净值基线各判一次「是不是二进制」。判据窗口不同，
 *     同一个文件会「预览看得到、净值却说算不出」。
 *   · MCP 单步超时：worker 拿它当连接 / 列工具的超时，主进程拿它算「等 MCP 回话」的
 *     预算。主进程那边更短时，设置页会弹「查询 MCP 状态超时」——**假失败**，
 *     因为 worker 正在正常连接（这条是 2026-09-19 补的，实际就发生过）。
 *
 * 所以这里断言三件事：
 *   1. 值本身（改值时必须**有意识地**改这里，而不是顺手在别处写一份新的）；
 *   2. `src/` 下除 `shared/limits.ts` 外**不存在同名定义**——直接挡住「图省事再写一份」；
 *   3. 已知消费方**确实 import 自 `@shared/limits`**——挡住「换个名字照样写死」。
 *
 * 做法与 `contract.test.ts` 一致：**读源码文本**而不是 import 消费方
 * （`session-manager.ts` / `entry.ts` 都依赖 electron 与 pi，node 测试里起不来）。
 * 代价同样要知道：
 *   - **会假红**：某个消费方合理地不再需要这个常量时，第 3 条会变红——
 *     这时该**删掉那条清单项**，不是把断言放宽成「至少一个文件 import 了」。
 *     放宽之后，只剩一处 import 也能通过，守卫就等于没了。
 *   - **会假绿**：若有人从 `shared/limits.ts` 之外的新文件里 export 同名常量，
 *     第 2 条按「文件路径」排除会漏掉它——所以第 2 条排除的是**唯一那一个路径**，
 *     新增第二个真源时要连本文件的注释一起改，别只改正则。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_TIMEOUT_MS,
  MCP_STARTUP_BUDGET_MS,
  MCP_STEP_TIMEOUT_MS,
  SNIFF_BYTES,
} from "../src/shared/limits.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const LIMITS_PATH = join(SRC, "shared", "limits.ts");

/** 递归收集 src 下的 .ts 文件 */
function allSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name.endsWith(".ts")) out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(SRC);
  return out;
}

const sources = allSources();

/** 「已知消费方 → 它应当 import 的符号」。改动实现时同步改这里，别放宽断言 */
const CONSUMERS: { file: string; symbol: string }[] = [
  { file: join(SRC, "main", "file-read.ts"), symbol: "SNIFF_BYTES" },
  { file: join(SRC, "worker", "lib", "baseline.ts"), symbol: "SNIFF_BYTES" },
  { file: join(SRC, "main", "approval", "store.ts"), symbol: "APPROVAL_TIMEOUT_MS" },
  { file: join(SRC, "main", "session-manager.ts"), symbol: "APPROVAL_TIMEOUT_MS" },
  { file: join(SRC, "worker", "entry.ts"), symbol: "APPROVAL_TIMEOUT_MS" },
  { file: join(SRC, "worker", "lib", "mcp-tools.ts"), symbol: "MCP_STEP_TIMEOUT_MS" },
  { file: join(SRC, "main", "session-manager.ts"), symbol: "MCP_STEP_TIMEOUT_MS" },
  { file: join(SRC, "worker", "lib", "mcp-tools.ts"), symbol: "MCP_STARTUP_BUDGET_MS" },
  { file: join(SRC, "main", "session-manager.ts"), symbol: "MCP_STARTUP_BUDGET_MS" },
];

/** 从 `@shared/limits` 的 import 语句里取花括号内容——`[^}]*` 不会跨到别的 import 上 */
function importedFromLimits(text: string): string | undefined {
  return /import\s*\{([^}]*)\}\s*from\s*"@shared\/limits"/.exec(text)?.[1];
}

describe("跨进程常量", () => {
  test("值本身：改这里应当是一个有意识的动作", () => {
    assert.equal(APPROVAL_TIMEOUT_MS, 5 * 60 * 1000);
    assert.equal(SNIFF_BYTES, 8000);
    assert.equal(MCP_STEP_TIMEOUT_MS, 15_000);
    assert.equal(MCP_STARTUP_BUDGET_MS, 15_000);
  });

  test("除 shared/limits.ts 外，src 下不存在同名定义", () => {
    const pattern =
      /^\s*(?:export\s+)?const\s+(APPROVAL_TIMEOUT_MS|SNIFF_BYTES|MCP_STEP_TIMEOUT_MS|MCP_STARTUP_BUDGET_MS)\s*=/m;
    const offenders = sources
      .filter((f) => f.path !== LIMITS_PATH && pattern.test(f.text))
      .map((f) => f.path);
    assert.deepEqual(
      offenders,
      [],
      `这些文件自己定义了同名常量，会与 @shared/limits 漂成两份：\n${offenders.join("\n")}`,
    );
  });

  test("已知消费方确实 import 自 @shared/limits", () => {
    for (const { file, symbol } of CONSUMERS) {
      const text = readFileSync(file, "utf8");
      const clause = importedFromLimits(text);
      assert.notEqual(
        clause,
        undefined,
        `${file} 没有从 @shared/limits 导入任何东西——它若改用本地常量，两侧就会漂开`,
      );
      assert.ok(
        new RegExp(`\\b${symbol}\\b`).test(clause ?? ""),
        `${file} 从 @shared/limits 导入的内容里没有 ${symbol}`,
      );
    }
  });

  test("守卫自身非空转：能认出一份写死的第二定义", () => {
    // 拿一段「在本地写死同名常量」的源码喂给同一条正则，它必须命中。
    const probe =
      "const APPROVAL_TIMEOUT_MS = 1234;\nconst SNIFF_BYTES = 16;\n" +
      "const MCP_STEP_TIMEOUT_MS = 15_000;\nconst MCP_STARTUP_BUDGET_MS = 15_000;";
    assert.match(
      probe,
      /^\s*(?:export\s+)?const\s+(APPROVAL_TIMEOUT_MS|SNIFF_BYTES|MCP_STEP_TIMEOUT_MS|MCP_STARTUP_BUDGET_MS)\s*=/m,
    );
    // 反向对照：import 语句不该被当成定义
    assert.doesNotMatch(
      'import { SNIFF_BYTES } from "@shared/limits";',
      /^\s*(?:export\s+)?const\s+(APPROVAL_TIMEOUT_MS|SNIFF_BYTES|MCP_STEP_TIMEOUT_MS|MCP_STARTUP_BUDGET_MS)\s*=/m,
    );
  });
});
