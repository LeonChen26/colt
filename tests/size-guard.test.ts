/**
 * 体量闸——**只止住漂移，不评判对错**。
 *
 * 定位先讲清楚，否则很快会被当成「啰嗦的卫士」悄悄放宽：
 *
 * - 它**不评判某个文件该不该拆**，只管一条线：**不许再涨**（2200 行）。
 * - 为什么要以「今天这个已经偏大的数」为上限，而不是一个理想值（如 500 行）：
 *   理想值第一天就红，红了没人修，于是被放宽到 3000、再到 5000——最后守卫变成
 *   装饰。**能守住的上限才算上限**。真正的收敛靠重构做成一次，这里负责让它不反弹。
 * - 降低是好事且不必打招呼；**上浮必须改本文件并写清理由**，这是唯一的闸门。
 *
 * 三轮审查下来一条规律很清楚：**用「守卫」解决的都真停住了，靠「记得改」的都漂了**。
 * 与第一轮的契约验证一致（`contract.test.ts`）、与第二轮的常量守卫一致
 * （`limits.test.ts`），这里守的是「**体量**」这个三轮都点了名、一次都没动的维度。
 *
 * 两条互斥的范围，别合并：
 *
 * 1. **已知大户登记**（`KNOWN_LARGE_FILES`）：只记录「谁大、为什么大」，**不给它们单独设上限**。
 *    2026-09-20 之前这里是 4 条棘轮（各自 1658 / 2000 / 1032 / 952），统一到与通用上限
 *    同值后就没有独立约束力了——留着那 4 个同样的数字只是冗余。
 *    登记本身仍有价值：`AGENTS.md` §1.4（「碰已知大户前先算净增行数」）要指名道姓。
 * 2. **通用上限**：`src/` 下**除 `src/dev/`** 的任何文件不得超过 MAX_FILE_LINES。
 *    针对的是「别处不许再冒出一个新的」——覆盖今天没人盯着的文件。
 *    **大户与别的文件现在受同一条线管**。
 *
 * 排除 `src/dev/` 的理由：那是**冒烟夹具**，一个 `modes/dock.ts` 就有 2450 行，
 * 它是场景脚本，长是它的本分；把它算进来只会逼出一个假上限，反而让第 2 条失效。
 *
 * 计数口径（与 `wc -l` 差 1，别混用两套数字）：
 * 这里一律用 `split("\n").length`——文件以换行结尾时它比 `wc -l` 多算一行。
 * 全部结论都由**同一段代码**算出，口径内部自洽即可；不要拿 `wc -l` 的数来对照。
 *
 * 已知的两种不准（写下来，免得将来被当成 bug 或当成可靠来依赖）：
 * - **会假红**：合理地拆分/移动了这些文件时（目的就是红了提醒你同步更新）。
 *   正确做法是**改本文件**，不是把断言放宽成「总和不超过 N」——那样一边涨一边降也能过。
 * - **会假绿**：把大文件切成两个挨着的新文件，行数闸看不见。
 *   它挡不住「拆得没意义」，只能挡「又涨了」；真正的拆分质量靠评审。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const DEV_SMOKE = join(SRC, "dev");

/**
 * 冒烟夹具之外的通用上限：任何文件超过它就红。
 *
 * 2026-09-18 由 1700 **上浮**到 2000（产品决定：给新文件更多余量），
 * 同日再由 2000 上浮到 2200——因为 `session-manager.ts` 的棘轮被上调到 2000，
 * 而本文件有一条断言要求 `MAX_FILE_LINES` **严格大于**棘轮最大值（见下方注释），
 * 两条线一旦相等会分不清该动哪一条。本次只抬 200，把放宽控制在最小。
 *
 * 2026-09-20：棘轮 4 条统一为 2200，**与本值相同**。那条「严格大于」的断言随之
 * 放宽为「不低于」——棘轮从此没有独立约束力，退化为「登记哪些是大户」的台账。
 */
const MAX_FILE_LINES = 2200;

/**
 * 已知大户：**登记，不设独立上限**。
 *
 * 2026-09-20 之前这里有 4 条棘轮，各自一个「许降不许升」的上限
 * （1658 / 2000 / 1032 / 952）。统一到 2200——也就是与通用上限同值——
 * 之后它们不再有独立约束力，数值成了纯冗余，于是删掉，只留这份登记。
 *
 * 登记仍有价值：`AGENTS.md` §1.4 说「碰已知大户前先算净增行数」，
 * 那份名单得有地方查。**没有上限不等于不用量**——大户之所以是大户，
 * 是因为它们已经到了「再加东西就该先搬走点什么」的体量。
 *
 * 将来若某个文件需要单独收紧（例如又要「零余量」那套纪律），
 * 在这里给它加回 `lines` 字段并在 `describe("体量闸")` 里补一条断言即可。
 */
const KNOWN_LARGE_FILES: { file: string[]; why: string }[] = [
  {
    file: ["renderer", "src", "features", "Conversation", "index.tsx"],
    why: "状态机 / IPC / 面板编排混装；单看 hook 一度 81 个",
  },
  {
    file: ["main", "session-manager.ts"],
    why:
      "会话生命周期 + 审批定时器 + 分支树归在一起；" +
      "2026-09-18 曾产品决定由 1235 上调到 2000（见提交说明）",
  },
  {
    file: ["worker", "entry.ts"],
    why: "工具调用分发与事件投影写在同一个函数里",
  },
  {
    file: ["main", "host", "browser-host.ts"],
    why: "原生视图管理 + 下载 + CDP 上传（注入页面的脚本已搬到 browser-scripts.ts）",
  },
];

/** Conversation 的 React 内建 hook 数不许涨（今天实测 50，一度 81） */
const CONVERSATION_HOOK_LIMIT = 50;

/** React 内建 hook——只数这些，不算自定义 hook（自定义 hook 是抽出去的正确手段） */
const REACT_HOOKS = [
  "useState",
  "useEffect",
  "useMemo",
  "useCallback",
  "useRef",
  "useReducer",
  "useLayoutEffect",
  "useImperativeHandle",
  "useContext",
  "useId",
  "useSyncExternalStore",
  "useTransition",
  "useDeferredValue",
  "useDebugValue",
];

function countLines(text: string): number {
  return text.split("\n").length;
}

function sourceFiles(): { path: string; rel: string; text: string }[] {
  const out: { path: string; rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push({
          path: full,
          rel: relative(SRC, full).split(sep).join("/"),
          text: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(SRC);
  return out;
}

/** 是否属于冒烟夹具（`src/dev/`）——它是场景脚本，长是应有的样子，不适用体量闸 */
function isSmokeFixture(path: string): boolean {
  return path.startsWith(DEV_SMOKE + sep) || path === DEV_SMOKE;
}

const files = sourceFiles();

function readRel(parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8");
}

function countReactHooks(text: string): { total: number; per: Record<string, number> } {
  const per: Record<string, number> = {};
  let total = 0;
  for (const hook of REACT_HOOKS) {
    const found = text.match(new RegExp(`\\b${hook}\\s*\\(`, "g"))?.length ?? 0;
    if (found > 0) {
      per[hook] = found;
      total += found;
    }
  }
  return { total, per };
}

describe("体量闸", () => {
  test("Conversation 的 React hook 数不许涨", () => {
    const text = readRel(["renderer", "src", "features", "Conversation", "index.tsx"]);
    const { total, per } = countReactHooks(text);
    assert.ok(
      total <= CONVERSATION_HOOK_LIMIT,
      `hook 数 ${total} 超过上限 ${CONVERSATION_HOOK_LIMIT}（${JSON.stringify(per)}）。\n` +
        `hook 越密，单次重渲染牵动的面越大，也更难在评审里看清副作用边界。\n` +
        `自定义 hook 不计入——那正是推荐的抽出方式。`,
    );
  });

  describe("通用上限：别处不许冒出新的 god 对象", () => {
    test(`冒烟夹具之外，没有文件超过 ${MAX_FILE_LINES} 行`, () => {
      const offenders = files
        .filter((f) => !isSmokeFixture(f.path) && countLines(f.text) > MAX_FILE_LINES)
        .map((f) => `${countLines(f.text)} 行  ${f.rel}`);
      assert.deepEqual(
        offenders,
        [],
        `这些文件超过 ${MAX_FILE_LINES} 行：\n${offenders.join("\n")}\n` +
          `若这是**新出现的**，说明正在形成新的 god 对象——优先拆分，别只在这里加一行豁免。`,
      );
    });
  });

  describe("守卫自身非空转", () => {
    test("行数计数按 \\n 切分（口径自洽，别拿 wc -l 对照）", () => {
      assert.equal(countLines("a\nb\n"), 3);
      assert.equal(countLines("a\nb"), 2);
    });

    test("hook 计数能认出 React 内建 hook，且不把自定义 hook 算进来", () => {
      const probe = [
        "const [a, setA] = useState(0);",
        "useEffect(() => {}, []);",
        "const b = useConversationState();",
        "const c = useMemo(() => 1, []);",
      ].join("\n");
      const { total, per } = countReactHooks(probe);
      assert.equal(per.useState, 1);
      assert.equal(per.useEffect, 1);
      assert.equal(per.useMemo, 1);
      // 自定义 hook 不计入总数——它是抽出去的正确手段，不该被计成负担
      assert.equal(total, 3);
      assert.equal(per.useConversationState, undefined);
    });

    test("登记里的文件都存在（改名或删掉时在这里红，别让大户从视野里溜走）", () => {
      for (const { file } of KNOWN_LARGE_FILES) {
        const rel = file.join("/");
        assert.ok(
          files.some((f) => f.rel === rel),
          `${rel} 在 src 下找不到——若已重命名/删除，请同步更新 KNOWN_LARGE_FILES；\n` +
            `这里**故意让「重命名或删除」也变红**：否则一个对象改个名字就从视野里溜走了。`,
        );
      }
    });
  });
});
