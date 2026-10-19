/**
 * 设置页「MCP」屏的安装流水**必须活在组件外**（源契约，不 import 渲染层）。
 *
 * 为什么值得一条测试：`mcp.installProgress` 由主进程逐条推送，接收方若是组件的
 * `useEffect`，切到别的屏再回来组件卸载重挂，`steps` 与 `busy` 一起清零——用户看到
 * 「安装按钮又变回安装」，而 pip 还在跑几十秒到几分钟。这个 bug 不会报错、不会崩，
 * 只会让人觉得「点了没反应」，所以靠断言钉住比靠记性可靠。
 *
 * 与 `tests/compaction-wiring.test.ts` 同一手法：读源码文本，因为渲染层组件要 React
 * 运行时才能挂载，node 测试里起不来。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
  new URL("../src/renderer/src/features/settings/Mcp.tsx", import.meta.url),
  "utf8",
);

describe("MCP 安装流水的状态位置", () => {
  test("流水从模块级 store 读，而不是组件的 useState", () => {
    assert.match(
      SOURCE,
      /useSyncExternalStore\(\s*subscribeInstall,\s*getInstallState,?\s*\)/,
      "组件没订阅模块级 store：切换设置分屏会把安装进度丢掉",
    );
  });

  test("组件里没有自己的 busy / steps state", () => {
    assert.doesNotMatch(
      SOURCE,
      /const \[busy, setBusy\]/,
      "busy 回到了组件里：切屏后按钮会变回「安装」，而安装其实还在跑",
    );
    assert.doesNotMatch(
      SOURCE,
      /const \[steps, setSteps\]/,
      "steps 回到了组件里：切屏后进度流水会消失",
    );
  });

  test("busy 由 store 写入（安装开始时置位、落定后清空）", () => {
    assert.match(SOURCE, /emitInstall\(\{ busy: preset\.id/, "安装开始时没在 store 里置 busy");
    assert.match(
      SOURCE,
      /emitInstall\(\{ busy: null, revision:/,
      "落定后没清 busy / 没递增 revision（组件就不会重拉目录）",
    );
  });

  test("进度事件的监听只注册一次，且不挂在组件上", () => {
    assert.match(SOURCE, /if \(!installWired\)/, "事件监听没有单次守卫：每个订阅者都会装一个监听器");
    assert.match(
      SOURCE,
      /installWired = true;\s*\n\s*window\.colt\.on\("mcp\.installProgress"/,
      "监听器应写在 subscribeInstall 里（跨挂载只装一次），而不是组件的 useEffect 里",
    );
  });

  test("安装失败原因与读取错误分开存", () => {
    // `load` 每次挂载都会 `reportError(null)`；若安装结论也写在 `error` 里，
    // 用户切屏回来看到的是一片干净——失败原因被刷没了
    assert.match(SOURCE, /installError: string \| null;/, "store 里没有独立的 installError");
    assert.match(
      SOURCE,
      /installError: result\.ok \? null : result\.error/,
      "安装落定的结论没进 installError（会随 load 一起被清掉）",
    );
    assert.match(SOURCE, /installError \?\? error/, "界面没有优先显示安装结论");
  });
});

describe("外壳能看见后台安装", () => {
  const SHELL = readFileSync(
    new URL("../src/renderer/src/features/Settings.tsx", import.meta.url),
    "utf8",
  );

  test("外壳订阅了模块级的 busy，而不是只看自己那一屏", () => {
    assert.match(SHELL, /useMcpInstallBusy/, "外壳没订阅安装状态：切到别的屏就不知道还在装");
  });

  test("导航项上有「正在安装」的指示", () => {
    assert.match(
      SHELL,
      /item\.id === "mcp" && mcpInstalling/,
      "导航项没有指示：用户切走后不知道后台还在装",
    );
  });
});
