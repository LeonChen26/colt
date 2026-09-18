/**
 * 冒烟模式：dock
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { BrowserWindow, clipboard, WebContentsView } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createSession, getProject, recordFileBaseline } from "../../../main/db/repo";
import { hostBridge } from "../../../main/host";
import { sessionManager } from "../../../main/session-manager";
import { toolOutputDir } from "../../../main/tool-output";
import { join, resolve } from "node:path";
import type { ConversationView, ViewFileChange } from "@shared/worker-protocol";
import type { ApprovalRequest } from "@shared/protocol";
import { DEFAULT_THINKING_LEVEL } from "@shared/thinking-level";
import { createFixtureServer } from "../../../../scripts/fixture-server.mjs";
import { sleep, uncaughtErrors } from "../context";

/**
 * 工作区（右栏）端到端冒烟：把 A1/A2/A3 的界面行为放到**真实渲染层**上验证。
 *
 * 为什么必须有这一条：拖拽、折叠、以及「折叠时原生视图必须同步收起」都横跨
 * 「渲染层 DOM ↔ 主进程 WebContentsView」两层，纯逻辑单测覆盖不到；而肉眼截图又
 * 看不见浮在渲染层之上的原生视图。这里两条腿一起走：
 *   1) 在主进程里用 executeJavaScript 驱动渲染层 DOM，并**真派发鼠标事件**模拟拖拽；
 *   2) 读主进程侧 WebContentsView 的 `getVisible()`——折叠是否真的收起视图，只有它说了算。
 *
 * ⑦-G 的「正在处理」（进行中的动作 + 底部总账）同样用**真实的事件通道**（`session.view`）推一个
 * **受控视图**来驱动：不跑模型，但走的是产品里一模一样的那条链路（事件 → DOM → 点击 → 落点）。
 * ⑦-G 第四步之后「点文件路径 → 预览」落进「正在处理」的下钻**内容层**（工具卡是唯一入口），
 * 而「本次改动」成了同一处的下钻**清单层**——原「改动」「文件」两个页签都已取消，
 * 故这两件事在同一段里连起来验：总账 → 清单 → diff → 内容，再逐层退回去。
 * 越界路径与「工具卡传绝对路径」也顺带钉一下。
 *
 * A3-3 的「页签关闭 + 「+」新增视图」同样在这里验：关闭**激活**页签后激活位是否交还默认视图、
 * 以及**关闭「浏览器」后原生视图是否真的收起 / 重开是否重新可见**
 * （这条又是截图看不见的——原生视图的可见性只有主进程知道）。
 *
 * A3-4 的「清单层」验三件容易出错的：目录分组是否正确（一层目录标签，不是可折叠树）、
 * **越界条目是否被排除并如实计数**（放进去就是死条目）、以及**逐层回退是否真的回得去**
 * （面包屑 / 底部「返回」/ ESC 三条出口）。
 * 原「本次改动树」的窄栏容器查询已随树一起作废（`styles.css` 里的 `.file-view` / `fv-tree` 已删）。
 *
 * A3-5 的「面板迁入页签」验的是**迁移动到位**：② 的入口点下去之后，面板真的渲染在 ⑦ 内
 * （按工作区正文判定，而非断言某个 class）、页签数量随之增加、新页签都能关且能重开；
 * 最硬的一条是 **`aside` 数不变**——迁入前每开一个面板就会多一个中栏浮层 `aside`，
 * 迁入后多开面板 `aside` 数仍与开局一致。
 * ⑦-H / ⑦-G 之后 ② 只剩「统计 / 规则」两个入口，⑦ 的「+」菜单也只剩三项。
 *
 * 工具截图的「按需读回」链路（落盘 → 读回 → 不越界 → 随会话删除清理）也在这一段里验：
 * 它横跨 worker（写）/ 主进程（读）/ 删除清理三处，只有真 userData + 真 IPC 才覆盖得到。
 *
 * 不调用模型、不产生计费；浏览器靶子复用夹具站（port 0，跑完即关）。
 *
 * B2 的「观测抽屉」验的是**同一份数据能否从主进程走到界面**：先在真实夹具页上点出
 * 控制台报错 / 请求失败 / 下载，再断言抽屉把三类都显示了（计数徽标 + 行文本）。
 * 其中「收起抽屉后原生视图 bounds 变高」是截图看不出来的那条——抽屉占的是页面区域的高度，
 * 只改 DOM 不上报矩形，页面就会被裁掉一块。
 *
 * B1 的「前进 / 后退 / 刷新」验的是**用户自己那条链路**：先在夹具站里真实加载第二页造出历史，
 * 再点界面上的按钮（渲染层点击 → IPC → 主进程 navigationHistory），判据取主进程读到的真实 URL。
 * 按钮的可用性也必须跟着历史走——「退到最早一页时后退必须变灰」正是最容易漏的那种状态。
 */
export async function runDock(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  const server = await createFixtureServer({ port: 0 });
  /** 夹具站那次下载的落盘文件名（B2 用它判「下载页签有没有列出这条」） */
  const payloadName = "colt-payload.txt";
  log(`会话：${session.id}`);
  log(`夹具站：${server.url}`);

  const checks: [string, boolean][] = [];
  /** 与 Conversation/index.tsx 的 MIN_DOCK_WIDTH / MIN_CENTER_WIDTH 保持一致 */
  const MIN_DOCK = 220;
  const MIN_CENTER = 360;
  /** 与 WorkspaceDock.tsx 的 DOCK_DEFAULT_WIDTH 保持一致（未拖拽时的统一宽度，不随页签变） */
  const DEFAULT_DOCK = 544;
  const clamp = (px: number, space: number): number =>
    Math.min(Math.max(MIN_DOCK, px), Math.max(MIN_DOCK, space - MIN_CENTER));

  /** 折叠旋钮所在的那个 aside 就是工作区；顺带量出宽度、根容器可用宽度与折叠态特征 */
  const probeExpr = `(() => {
    const aside = [...document.querySelectorAll("aside")].find((a) =>
      a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
    if (!aside) return { found: false };
    const root = aside.closest("div.grid");
    return {
      found: true,
      width: Math.round(aside.getBoundingClientRect().width),
      space: root ? root.clientWidth : -1,
      collapsed: aside.querySelector('button[aria-label="展开工作区"]') !== null,
      grip: document.querySelector(".dock-grip") !== null,
      railBrowser: aside.querySelector('button[aria-label="浏览器"]') !== null,
      urlShown: document.body.innerText.includes("127.0.0.1"),
      // 页签计数与激活态都按 data-dock-tab 认：容器里还挂着别的可切换控件
      // （B2 观测抽屉的三个页签同样用 aria-pressed 表达选中），只按 aria-pressed 会多算
      tabCount: aside.querySelectorAll("[data-dock-tab]").length,
      activeLabel: (
        aside.querySelector('[data-dock-tab][aria-pressed="true"]')?.textContent ?? ""
      ).trim(),
      tabClose: [...aside.querySelectorAll('button[aria-label^="关闭"]')].map((b) =>
        b.getAttribute("aria-label")),
      addButton: aside.querySelector('button[aria-label="新增视图"]') !== null,
      menuItems: [...aside.querySelectorAll("[data-dock-add]")].map((b) =>
        b.getAttribute("data-dock-add")),
      // A3-5：四个面板迁入 ⑦ 后，多开面板**不该**再新增 aside（左栏导航 + 本工作区 = 2 个）。
      // 若中栏浮层面板还在，panel 一开这里就会变成 3。
      asideCount: document.querySelectorAll("aside").length,
    };
  })()`;
  type Probe = {
    found: boolean;
    width: number;
    space: number;
    collapsed: boolean;
    grip: boolean;
    railBrowser: boolean;
    urlShown: boolean;
    tabCount: number;
    activeLabel: string;
    tabClose: string[];
    addButton: boolean;
    menuItems: string[];
    asideCount: number;
  };
  const probe = (): Promise<Probe> => run<Probe>(probeExpr);

  /** 只在工作区内找按钮并点击：避免误点会话流/侧栏里同名的元素 */
  const clickInDock = (matcher: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      if (!aside) return false;
      const el = [...aside.querySelectorAll("button")].find((b) => ${matcher});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 主进程侧：内嵌浏览器的 WebContentsView（排除主窗口自身的那个） */
  const browserView = (): Electron.View | undefined => {
    try {
      return window.contentView.children.find(
        (child) => child instanceof WebContentsView && child.webContents.id !== window.webContents.id,
      );
    } catch {
      return undefined;
    }
  };
  const waitVisible = async (want: boolean, timeoutMs = 8000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (browserView()?.getVisible() === want) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  /**
   * 模拟一次拖拽。必须拆成「按下」与「移动+抬起」两次 executeJavaScript：
   * 只有按下之后 React 才会在 window 上挂 mousemove/mouseup 监听，
   * 同一个同步块里紧接着派发 move 会丢事件（AGENTS.md 1.2 的时机坑）。
   * deltaX < 0 = 向左拖（右栏变宽）；用固定基准点，避免依赖把手真实坐标。
   */
  const dragGrip = async (deltaX: number): Promise<void> => {
    const base = 1000;
    await run(`(() => {
      const grip = document.querySelector(".dock-grip");
      if (!grip) return false;
      grip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: ${base} }));
      return true;
    })()`);
    await sleep(150);
    await run(`(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: ${base + deltaX} }));
      window.dispatchEvent(new MouseEvent("mouseup", {}));
      return true;
    })()`);
    await sleep(150);
  };

  /**
   * 点「正在处理」里路径为 path 的文件行——⑦-G 之后这个函数只用来**断言该行已经不在了**：
   * 段一不再列已完成文件（硬约束一），文件行的入口改为下钻（清单 → 内容）。
   * 用 title 做**精确匹配**（旧 FollowPanel 的文件行标题是 `点击预览 <path>`），
   * 避免用文本包含匹配时被别的行或路径前缀误中。
   */
  const clickFileRow = (path: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      if (!aside) return false;
      const want = "点击预览 " + ${JSON.stringify(path)};
      const el = [...aside.querySelectorAll("button")].find(
        (b) => (b.getAttribute("title") ?? "") === want);
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 读「正在处理」底部的**总账**（⑦-G：由「本次改动」段二降级而来的一行状态）。
   * `clickable` 按标签判定：有改动时是 `button`（进入清单的出口），没有改动时是 `div`
   * ——「空」时**不给**一个点了没反应的出口（那正是死控件）。
   * `idle` 读段一的空态标记：面板必须能显示「空」（⑦-E 的安全判断），这条得能验。
   */
  const ledgerProbe = (): Promise<{
    present: boolean;
    text: string;
    clickable: boolean;
    idle: boolean;
  }> =>
    run(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      const el = aside ? aside.querySelector("[data-follow-ledger]") : null;
      if (!el) return { present: false, text: "", clickable: false, idle: false };
      return {
        present: true,
        text: (el.textContent ?? "").replace(/\\s+/g, " ").trim(),
        clickable: el.tagName === "BUTTON",
        idle: aside.querySelector("[data-follow-empty]") !== null,
      };
    })()`);

  /** 点「正在处理」底部的总账（⑦-G 进入清单的出口） */
  const clickLedger = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      const el = aside ? aside.querySelector("[data-follow-ledger]") : null;
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 读下钻**内容层**的文件预览状态：被预览的路径、是否渲染文本、正文是否含指定片段、拒绝原因。
   * ⑦-G 之后内容层挂在「正在处理」的下钻里，故 `[data-file-view]` 只在内容层出现。
   */
  const fileProbe = (
    needle: string,
  ): Promise<{ path: string | null; hasText: boolean; hasNeedle: boolean; errorShown: boolean }> =>
    run(`(() => {
      const root = document.querySelector("[data-file-view]");
      const body = document.body.innerText;
      return {
        path: root ? root.getAttribute("data-file-view") : null,
        hasText: document.querySelector("[data-file-text]") !== null,
        hasNeedle: ${JSON.stringify(needle)}.length > 0 && body.includes(${JSON.stringify(needle)}),
        errorShown: body.includes("无法预览该文件"),
      };
    })()`);

  /**
   * 读 ⑥ 的运行状态段（C1 / C2）：判定值（`data-run-state`）、文案、点是不是红的。
   * ⑥ 没有别的冒烟覆盖，故按「真实事件通道推视图 → 读真实 DOM」验，不靠单测代偿。
   */
  const liveProbe = (): Promise<{ state: string; text: string; danger: boolean }> =>
    run(`(() => {
      const node = document.querySelector("[data-run-state]");
      if (!node) return { state: "", text: "", danger: false };
      const dot = node.querySelector(".live-dot");
      return {
        state: node.getAttribute("data-run-state") ?? "",
        text: node.textContent.trim(),
        danger: dot !== null && dot.classList.contains("danger-dot"),
      };
    })()`);

  /** 点「+」菜单里 data-dock-add=<kind> 的那一项（菜单挂在 aside 上，全文档查即可） */
  const clickMenuItem = (kind: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-dock-add="${kind}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 读「正在处理」的**下钻**状态（⑦-G）：当前在哪一层、面包屑上有哪几段、清单里有什么。
   *
   * 层用 `data-drill` 认（`list` / `diff` / `content`），不在下钻时整个容器不存在。
   * 清单的目录与文件分别用 `data-clist-dir` / `data-clist-file` 读——**不靠文本**，
   * 否则文件名恰好出现在别处（如 diff 正文）就会误判。
   * `hidden` 直接读容器上的属性值：越界条目被丢掉这件事必须**如实显示**，
   * 只断言「它不在列表里」是不够的（静默丢数据比不显示更可疑）。
   */
  const drillProbe = (): Promise<{
    layer: string;
    crumbs: string[];
    back: boolean;
    dirs: string[];
    files: string[];
    revisions: string[];
    hidden: number;
    diffRevisions: string[];
    nets: [string, string][];
    netRows: [string, string][];
    netRowValues: [string, string][];
    netUnknown: number;
  }> =>
    run(`(() => {
      const root = document.querySelector("[data-drill]");
      const attrAll = (selector, name) =>
        [...document.querySelectorAll(selector)].map((el) => el.getAttribute(name));
      // 「图形界面说它算出来是多少」与「算出来是多少」是两件事：净值读的是产品自己渲染出来的
      // 那个小格子（含空串＝没显示数字），用例不重算一遍——重算就等于把问题绕开了。
      const attrText = (selector, name) =>
        [...document.querySelectorAll(selector)].map((el) => [
          el.getAttribute(name),
          (el.textContent ?? "").trim(),
        ]);
      return {
        layer: root ? (root.getAttribute("data-drill") ?? "") : "",
        crumbs: attrAll("[data-drill-crumb]", "data-drill-crumb"),
        back: document.querySelector("[data-drill-back]") !== null,
        dirs: attrAll("[data-clist-dir]", "data-clist-dir"),
        files: attrAll("[data-clist-file]", "data-clist-file"),
        revisions: attrAll("[data-clist-rev]", "data-clist-rev"),
        hidden: Number(
          document.querySelector("[data-clist-hidden]")?.getAttribute("data-clist-hidden") ?? "0",
        ),
        diffRevisions: attrAll("[data-drill-rev]", "data-drill-rev"),
        nets: attrText("[data-clist-net-value]", "data-clist-net-value"),
        netRows: attrText("[data-clist-net]", "data-clist-net"),
        netRowValues: attrText("[data-clist-net-row-value]", "data-clist-net-row-value"),
        netUnknown: Number(
          document.querySelector("[data-clist-net-unknown]")?.getAttribute("data-clist-net-unknown") ??
            "0",
        ),
      };
    })()`);

  /** 展开后那一行「全部改动（累计）」→ diff 层的「累计」档 */
  const clickListNet = (path: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-clist-net="${path}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 点清单里 path 对应的文件卡 */
  const clickListFile = (path: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-clist-file="${path}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** diff 层右上「看文件」→ 内容层 */
  const clickDrillContent = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector("[data-drill-content]");
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 各层底部那一行「返回」 */
  const clickDrillBack = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector("[data-drill-back]");
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 面包屑上某一段（`follow` / `list`） */
  const clickCrumb = (marker: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-drill-crumb="${marker}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 点标题为「点击预览 <path>」的入口。工具卡路径在**消息流（④）**里而非工作区 aside 内，
   * 所以这里全文档查找；与 `clickFileRow` 的路径刻意取不同文件，避免命中歧义。
   */
  const clickPreviewByTitle = (path: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const want = "点击预览 " + ${JSON.stringify(path)};
      const el = [...document.querySelectorAll('[role="button"], button')].find(
        (node) => (node.getAttribute("title") ?? "") === want);
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 点 ② 会话头（`.conv-head`）里的按钮。必须**限定在会话头内**——
   * 「统计 / 规则」这些字样在 ⑦ 的页签上也有一份，全文档查会点错。
   */
  const clickInHead = (matcher: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const head = document.querySelector(".conv-head");
      if (!head) return false;
      const el = [...head.querySelectorAll("button")].find((b) => ${matcher});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 工作区（⑦）当前渲染的内容里是否出现某段文字（A3-5：判「面板渲染在 ⑦ 内」） */
  const dockHas = (needle: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      return aside !== null && (aside.innerText ?? "").includes(${JSON.stringify(needle)});
    })()`);

  /**
   * 读观测抽屉（B2）：三个页签、各自的计数徽标、是否收起、当前页签的行文本。
   * 计数读的是 `data-obs-count`（产品自己算的那个数），而不是在用例里重算一遍——
   * 重算就等于把「抽屉的数对不对」这个问题绕开了。
   */
  const obsProbe = (): Promise<{
    present: boolean;
    tabs: string[];
    counts: Record<string, number>;
    collapsed: boolean;
    rows: string[];
  }> =>
    run(`(() => {
      const root = document.querySelector("[data-observe]");
      if (root === null) return { present: false, tabs: [], counts: {}, collapsed: false, rows: [] };
      const tabs = [...root.querySelectorAll("[data-obs-tab]")];
      return {
        present: true,
        tabs: tabs.map((b) => b.getAttribute("data-obs-tab")),
        counts: Object.fromEntries(tabs.map((b) => [
          b.getAttribute("data-obs-tab"),
          Number(b.getAttribute("data-obs-count")),
        ])),
        collapsed: root.querySelector("[data-obs-body]") === null,
        rows: [...root.querySelectorAll("[data-obs-row]")].map((r) => r.innerText || ""),
      };
    })()`);

  /** 点观测抽屉里某个页签（已激活的那个 = 收起/展开） */
  const clickObsTab = (tab: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(`[data-obs-tab="${tab}"]`)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 点观测抽屉里某页签中文本含 needle 的那一行（整行可点 = 展开 / 收起详情，N1） */
  const clickObsRow = (tab: string, needle: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(`[data-obs-row="${tab}"]`)})];
      const el = rows.find((row) => (row.innerText || "").includes(${JSON.stringify(needle)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /**
   * 读展开的「条目详情」（N1）：字段值、**哪些字段被截断了**、详情是否真的落在抽屉可视区内。
   *
   * 「没被截断」不靠 class 名判断，而是量 `scrollWidth <= clientWidth + 1`——
   * 被 `truncate` 的元素必然超宽，这是个**可判定**的事实（同 §5 第 ⑤ 条「只验会变、不验相等」的教训）。
   * 另外把详情顶端是否在可视区内一并读出：正文只有 132px 高，展开后若不自动滚进来，
   * 用户点了会**看不出发生了什么**（`AGENTS.md` §3.6 那类「点了没反应」）。
   */
  const obsDetailProbe = (): Promise<{
    present: boolean;
    count: number;
    fields: Record<string, string>;
    truncated: string[];
    copyButton: boolean;
    visibleInBody: boolean;
    rectTop: number;
    rectBottom: number;
    bodyTop: number;
    bodyBottom: number;
    scrollTop: number;
  }> =>
    run(`(() => {
      const empty = {
        present: false, count: 0, fields: {}, truncated: [], copyButton: false,
        visibleInBody: false, rectTop: 0, rectBottom: 0, bodyTop: 0, bodyBottom: 0, scrollTop: 0,
      };
      const details = [...document.querySelectorAll("[data-obs-detail]")];
      const detail = details[0];
      if (detail === undefined) return empty;
      const fields = {};
      const truncated = [];
      for (const el of detail.querySelectorAll("[data-obs-field]")) {
        const label = el.getAttribute("data-obs-field");
        fields[label] = el.textContent || "";
        if (el.scrollWidth > el.clientWidth + 1) truncated.push(label);
      }
      const body = document.querySelector("[data-obs-body]");
      if (body === null) return empty;
      const box = body.getBoundingClientRect();
      const rect = detail.getBoundingClientRect();
      return {
        present: true,
        count: details.length,
        fields,
        truncated,
        copyButton: detail.querySelector("[data-obs-copy]") !== null,
        visibleInBody: rect.top >= box.top - 1 && rect.top < box.bottom - 2,
        rectTop: Math.round(rect.top),
        rectBottom: Math.round(rect.bottom),
        bodyTop: Math.round(box.top),
        bodyBottom: Math.round(box.bottom),
        scrollTop: Math.round(body.scrollTop),
      };
    })()`);

  /**
   * 点详情段里的「复制」：先把它滚进可视区，再做**命中测试**——
   * 「在 DOM 里」不等于「用户点得到」（§5 第 ⑥ 条那个新变种：查得到、`click()` 也"命中"，
   * 但它已经被挤出可视区了）。
   */
  const clickObsCopy = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector("[data-obs-copy]");
      if (!el) return false;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit !== el && !el.contains(hit)) return false;
      el.click();
      return true;
    })()`);

  try {
    window.reload();
    await sleep(4000);

    // 用渲染层同款查询取「当前会话」：App 也是取 session.list 的第一条（updated_at DESC），
    // 由此保证浏览器视图挂在渲染层真正显示的那个会话上，而不是自说自话的新 id。
    const list = await run<{ id: string }[]>(
      `window.colt.invoke("session.list", ${JSON.stringify({ projectId })})`,
    );
    const sessionId = list[0]?.id;
    if (sessionId === undefined) {
      log("会话列表为空，无法进行工作区冒烟");
      checks.push(["渲染层有活动会话", false]);
      return;
    }
    log(`活动会话：${sessionId}`);

    const initial = await probe();
    checks.push(["工作区已挂载（找到折叠旋钮）", initial.found]);
    if (!initial.found) return;
    checks.push(["初始为展开态", initial.collapsed === false]);
    log(`初始：工作区宽度=${initial.width}px，可用宽度=${initial.space}px`);
    // ---- A3-1：页签由「实例列表」驱动 ----
    checks.push(["页签由实例列表驱动（初始 2 个）", initial.tabCount === 2]);
    checks.push(["初始激活默认视图「正在处理」", initial.activeLabel === "正在处理"]);
    log(`初始激活页签：${initial.activeLabel}（共 ${initial.tabCount} 个）`);

    // agent 侧「打开」浏览器（不经模型）：创建 WebContentsView + 推 browser.state
    const nav = await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "navigate",
      params: { url: server.url },
    });
    log(`navigate：${nav.text}`);
    await sleep(1500);
    const afterNav = await probe();
    checks.push(["⑦-F 自动切到浏览器页签", afterNav.urlShown && afterNav.activeLabel === "浏览器"]);
    // ensureInstance 幂等：浏览器页签本就存在，自动切换不该重复建页签
    checks.push(["⑦-F 幂等：未重复建页签", afterNav.tabCount === 2]);
    checks.push(["浏览器原生视图已就绪且可见", await waitVisible(true)]);

    // ---- A2：折叠必须同步收起原生视图 ----
    log("[A2] 折叠工作区，预期原生视图同步收起");
    await clickInDock(`b.getAttribute("aria-label") === "折叠工作区"`);
    await sleep(400);
    const folded = await probe();
    checks.push(["折叠后宽度为 44px", folded.collapsed && Math.abs(folded.width - 44) <= 1]);
    checks.push(["折叠后不再渲染拖拽把手", folded.grip === false]);
    checks.push(["折叠后图标条保留浏览器入口", folded.railBrowser]);
    checks.push(["折叠后原生视图已收起（getVisible=false）", await waitVisible(false)]);
    log(`折叠：宽度=${folded.width}px，视图可见=${browserView()?.getVisible()}`);

    // ---- 展开：点图标条上的「浏览器」----
    log("[展开] 点图标条上的浏览器图标");
    await clickInDock(`b.getAttribute("aria-label") === "浏览器"`);
    await sleep(700);
    checks.push(["展开后恢复展开态", (await probe()).collapsed === false]);
    checks.push(["展开后原生视图重新可见", await waitVisible(true)]);

    // ---- A1：拖拽方向 + 上下限 ----
    log("[A1] 右拖到底，预期命中下限 220");
    await dragGrip(10000);
    const atMin = await probe();
    checks.push(["右拖到底钳制到下限 220", atMin.width === 220]);

    log("[A1] 左拖 40px，预期变宽 40（含钳制）");
    await dragGrip(-40);
    const afterLeft = await probe();
    checks.push(["左拖 40px → 宽度 +40（含钳制）", afterLeft.width === clamp(220 + 40, afterLeft.space)]);
    log(`  220 → ${afterLeft.width}（可用宽度 ${afterLeft.space}）`);

    log("[A1] 左拖到底，预期命中上限（中栏留 360）");
    await dragGrip(-10000);
    const atMax = await probe();
    const expectedMax = Math.max(MIN_DOCK, atMax.space - MIN_CENTER);
    checks.push(["左拖到底钳制到上限（中栏留 360）", atMax.width === expectedMax]);
    log(`  上限实测 ${atMax.width}（期望 ${expectedMax}）`);

    // ---- 宽度记忆：切页签不覆盖用户拖过的宽度 ----
    log("[A1] 宽度记忆：切到「正在处理」再切回，宽度不应被统一默认值覆盖");
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    const afterFollow = await probe();
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(300);
    const backToBrowser = await probe();
    checks.push([
      "切页签后宽度不被统一默认值覆盖",
      afterFollow.width === atMax.width && backToBrowser.width === atMax.width,
    ]);
    // A3-1：激活项由 id 驱动，点击即切（内容随之变化）
    checks.push([
      "按 id 切换生效（点页签即激活）",
      afterFollow.activeLabel === "正在处理" && backToBrowser.activeLabel === "浏览器",
    ]);
    checks.push(["切换页签不改变页签数量", afterFollow.tabCount === 2 && backToBrowser.tabCount === 2]);
    log(`  切页签后：正在处理=${afterFollow.width}px，浏览器=${backToBrowser.width}px（应均为 ${atMax.width}px）`);

    // ---- 双击复位 ----
    log("[A1] 双击把手 → 回到统一默认宽度");
    await run(`(() => {
      const grip = document.querySelector(".dock-grip");
      if (!grip) return false;
      grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const reset = await probe();
    checks.push(["双击复位到统一默认宽度 544（含钳制）", reset.width === clamp(DEFAULT_DOCK, reset.space)]);

    // ---- 统一宽度：未拖拽时切页签**不改变**宽度（宽度与激活页签无关） ----
    log("[A1] 统一宽度：复位后切页签，宽度不应变化");
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    const unifiedFollow = await probe();
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(300);
    const unifiedBrowser = await probe();
    checks.push([
      "切页签不改变宽度（统一 544，与页签无关）",
      unifiedFollow.width === reset.width && unifiedBrowser.width === reset.width,
    ]);
    log(
      `  切页签：正在处理=${unifiedFollow.width}px，浏览器=${unifiedBrowser.width}px（应均为 ${reset.width}px）`,
    );

    // ---- ⑦-F：折叠态下加载浏览器应自动展开 ----
    log("[⑦-F] 折叠后让 agent 重新加载浏览器，预期自动展开");
    await clickInDock(`b.getAttribute("aria-label") === "折叠工作区"`);
    await sleep(400);
    checks.push(["（前置）再次折叠成功", (await probe()).collapsed && (await waitVisible(false))]);
    // 销毁再重建：loaded false→true 会重置渲染层的「已自动切过」标记，才能复现首次加载
    hostBridge.disposeSession(sessionId);
    await sleep(500);
    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "navigate",
      params: { url: server.url },
    });
    await sleep(1500);
    const autoExpanded = await probe();
    checks.push(["折叠态下加载浏览器 → 自动展开", autoExpanded.collapsed === false]);
    checks.push(["自动展开后原生视图可见", await waitVisible(true)]);

    // ---- 受控会话视图：⑦-G 的「正在处理」与 A3-2 的「点文件路径 → 预览」都靠它驱动 ----
    // 走**真实的事件通道**推一个受控视图（不跑模型）：`fileChanges` 三条（其中一条故意越界，
    // 用来钉住「根由主进程推导」这条安全边界）、`messages` 两张工具卡（一张根内、一张根外）。
    log("[受控视图] 推 session.view：3 条改动（含一条越界）+ 两张工具卡（根内 / 根外）");
    const rootPath = getProject(projectId)?.rootPath ?? process.cwd();
    const previewRel = "package.json";
    // 子目录里的真实文件：用来验「清单按目录分组」，也是「清单里点文件 → diff → 内容」的靶子
    const treeRel = "src/main/file-read.ts";
    // 工具卡（消息流 ④）里的路径用**绝对路径**驱动：read 的 path 常是绝对路径，
    // 顺带钉住「主进程收绝对路径、但仍须落在项目根内」这条边界
    const toolAbsPath = join(rootPath, "tsconfig.json");
    const toolMarker = (
      readFileSync(toolAbsPath, "utf8").split("\n").find((line) => line.trim().length >= 8) ?? ""
    ).trim();
    // 根**外**的绝对路径（⑦-G 之后越界条目在界面上已无可点入口：段一不再列文件行、
    // 文件树按 `isProjectRelative` 排除它），故改由**工具卡**驱动——模型确实会给出这种路径，
    // 「主进程拒绝 + 视图给出可读原因」这条不能因为入口搬家而掉出冒烟。
    const outsideAbsPath = resolve(rootPath, "..", "colt-smoke-outside", "escape.txt");
    const stamp = Date.now();
    /**
     * 造一条改动记录。`net` 是**净值**（基线 → 现在，主进程在改动落库时算好）；
     * 不给就是 null = 算不出——界面据此**不下结论**，与「净 0」是两回事。
     */
    const fakeChange = (
      id: string,
      path: string,
      at: number,
      net: { added: number; removed: number } | null = null,
    ): ViewFileChange => ({
      id,
      path,
      kind: "write",
      patch: null,
      addedLines: 0,
      removedLines: 0,
      timestamp: at,
      netAddedLines: net?.added ?? null,
      netRemovedLines: net?.removed ?? null,
    });
    /**
     * 受控会话视图的构造器：基准是一份「什么都没在跑」的视图，
     * 各用例只覆盖自己关心的字段（如 `lastRun` / `running`）。
     *
     * ⚠️ 基准对象的类型**必须是 `ConversationView` 本体**，不能写成 `Record<string, unknown>`。
     * 这个视图会经 `session.view` **整份替换**渲染层手里那份真实视图，所以**少一个字段就等于
     * 把那个字段抹成 `undefined`**。v1.43 正是在这里漏了 `skills`：渲染层于是把「本会话技能清单」
     * 读成 `undefined`（＝**不知道**），`/skill` 的本地拦截整条失效——而冒烟只报「拦不住」，
     * 看不出根因在**夹具缺字段**（`AGENTS.md` §1.2：先怀疑测试接入，别先改被测对象）。
     * 钉上类型之后，契约再加字段时这里会**编译不过**，而不是静默抹空。
     */
    const viewBase: ConversationView = {
      sessionId,
      model: "smoke/model",
      imageInput: false,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      // 夹具里**一个技能都没装**：这是「知道，且为空」，正是 `/skill` 本地拦截该生效的那种情形
      // （区别于 `undefined` = 拿不到清单，那时必须放行，否则会把有效调用误判成失败）。
      skills: [],
      messages: [
        {
          id: "smoke-msg-1",
          role: "assistant",
          text: "",
          toolCalls: [
            {
              id: "smoke-call-1",
              name: "read",
              args: JSON.stringify({ path: toolAbsPath }),
              durationMs: 8,
            },
            {
              // 项目根**外**的路径：工具卡照旧可点，但主进程必须拒绝（越界）
              id: "smoke-call-2",
              name: "read",
              args: JSON.stringify({ path: outsideAbsPath }),
              durationMs: 6,
            },
          ],
        },
      ],
      toolResults: [],
      fileChanges: [
        fakeChange("smoke-a", previewRel, stamp),
        fakeChange("smoke-b", "../escape.txt", stamp - 1),
        fakeChange("smoke-c", treeRel, stamp - 2),
      ],
      streamingText: null,
      thought: null,
      runningTools: [],
      running: false,
      lastRun: null,
      queuedCount: 0,
      stats: {
        messageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        contextUsed: 0,
      },
    };
    const smokeView = (over: Partial<ConversationView>): ConversationView => ({
      ...viewBase,
      ...over,
    });
    window.webContents.send("session.view", smokeView({}));
    await sleep(400);

    // ---- ⑦-G：「正在处理」= 进行中的动作 + 底部总账 ----
    // 受控视图里 runningTools 为空、fileChanges 三条（两条项目内 + 一条越界），
    // 正好钉住两件事：段一**不再**列已完成文件（于是能显示「空」），总账是**一行**双口径。
    log("[⑦-G] 「正在处理」：段一只列进行中的动作，底部常驻一行总账");
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    checks.push([
      "段一不再列已完成文件（旧文件行已移除，⑦-G 硬约束一）",
      (await clickFileRow(previewRel)) === false,
    ]);
    const ledger0 = await ledgerProbe();
    checks.push([
      "底部总账写「N 处 · M 文件」双口径（3 条改动 / 3 个路径）",
      ledger0.present && ledger0.text.includes("3 处 · 3 文件"),
    ]);
    checks.push(["无进行中的动作时能显示「空」（空闲空态仍在）", ledger0.idle]);
    checks.push(["有改动时总账可点（进入清单的出口）", ledger0.clickable]);
    log(`  总账：${ledger0.text}`);

    // 点总账 → 下钻的**清单层**（⑦-G 第四步：不再切到「改动」页签——那个页签已经没有了，
    // 故这里的关键判据是「落到清单层」而不是「多了一个页签」，页签数应当**纹丝不动**）
    checks.push(["点总账命中", await clickLedger()]);
    await sleep(500);
    const listFromLedger = await drillProbe();
    checks.push([
      "点总账 → 进入下钻清单层（面包屑出现「正在处理」，页签数不变）",
      listFromLedger.layer === "list" &&
        listFromLedger.crumbs.includes("follow") &&
        (await probe()).tabCount === 2,
    ]);

    // ---- A3-2：点文件路径 → 预览 ----
    // ⑦-G 把两个入口收进同一处下钻：工具卡（④）的路径直接落**内容层**，
    // 与上一步的清单层是同一条面包屑上的两个位置。「文件」页签已不存在。
    log("[A3-2] 工具卡（消息流 ④）里的文件路径 → 下钻内容层");
    checks.push(["工具卡路径可点（入参是绝对路径）", await clickPreviewByTitle(toolAbsPath)]);
    await sleep(700);
    const fromTool = await fileProbe(toolMarker);
    checks.push([
      "点工具卡路径 → 落在「正在处理」的下钻内容层",
      (await probe()).activeLabel === "正在处理" && (await drillProbe()).layer === "content",
    ]);
    checks.push(["内容层记录了被预览的路径", fromTool.path === toolAbsPath]);
    checks.push(["根内绝对路径渲染出内容", fromTool.hasText && fromTool.hasNeedle]);
    log(`  工具卡预览：path=${fromTool.path}，渲染文本=${fromTool.hasText}，命中片段=${fromTool.hasNeedle}`);

    // 切走再切回：下钻状态由容器持有（不属于某个页签的重挂载），故切回来还在原处
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(500);
    checks.push(["切走后下钻内容不再渲染", (await fileProbe(toolMarker)).hasText === false]);
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(700);
    checks.push(["切回「正在处理」下钻内容仍在", (await fileProbe(toolMarker)).hasNeedle]);
    checks.push(["切页签不改变页签数量（仍 2 个）", (await probe()).tabCount === 2]);

    // 根**外**的路径：工具卡照旧可点，但主进程必须拒绝，且视图要给出可读原因。
    // （⑦-G 之后越界条目在界面上已无可点入口，故这条改由工具卡驱动，见 outsideAbsPath 的说明。）
    checks.push(["根外绝对路径的工具卡可点", await clickPreviewByTitle(outsideAbsPath)]);
    await sleep(700);
    const denied = await fileProbe("");
    checks.push([
      "越界路径被拒并给出原因（主进程拒绝 → 视图可读原因）",
      denied.errorShown && denied.path === outsideAbsPath,
    ]);
    log(`  越界预览：path=${denied.path}，给出原因=${denied.errorShown}`);

    // 退出下钻，把「正在处理」还原成后续用例依赖的基线（段一 + 总账）。
    // 该文件不在改动清单里，故 goUp 会**跳过空的清单层**直接回到「正在处理」（⑦-G 的层设计）。
    checks.push(["点「返回」退出下钻", await clickDrillBack()]);
    await sleep(300);
    checks.push(["退出后不再有下钻容器", (await drillProbe()).layer === ""]);

    // ---- C1 / C2：⑥ 的运行状态段（运行中 / 已中断 / 已失败 / 空闲）----
    // 走与上面同一条**真实事件通道**推终态。判据是渲染层真的把内核终态翻译成了那个状态，
    // 不是「字段有没有传过来」——⑥ 此前只有裸文本「空闲」，这段行为完全没有断言。
    log("[C1] ⑥ 运行状态：推不同终态，断言状态段（判定值 / 文案 / 点色）");
    window.webContents.send("session.view", smokeView({ lastRun: { status: "aborted" } }));
    await sleep(400);
    const liveAborted = await liveProbe();
    checks.push([
      "⑥ 中断后显示「已中断」",
      liveAborted.state === "aborted" && liveAborted.text.includes("已中断"),
    ]);

    window.webContents.send(
      "session.view",
      smokeView({ lastRun: { status: "failed", error: "请求超时" } }),
    );
    await sleep(400);
    const liveFailed = await liveProbe();
    checks.push(["⑥ 异常结束后显示「已失败」", liveFailed.state === "failed"]);
    checks.push([
      "⑥ 失败摘要带出 error.message（就地可读，不必翻消息流）",
      liveFailed.text.includes("请求超时"),
    ]);
    checks.push(["⑥ 失败态用红点（v3：红 = 危险 / 失败）", liveFailed.danger]);
    log(`  失败态：state=${liveFailed.state}，文案=${liveFailed.text}，红点=${liveFailed.danger}`);

    window.webContents.send("session.view", smokeView({ lastRun: { status: "completed" } }));
    await sleep(400);
    const liveDone = await liveProbe();
    checks.push([
      "⑥ 正常跑完回到「空闲」（状态条不为正常结束留痕）",
      liveDone.state === "idle" && liveDone.text.includes("空闲"),
    ]);

    window.webContents.send(
      "session.view",
      smokeView({ running: true, lastRun: { status: "failed", error: "上一轮" } }),
    );
    await sleep(400);
    const liveRunning = await liveProbe();
    checks.push([
      "⑥ 运行中优先于上一轮终态",
      liveRunning.state === "running" && liveRunning.text.includes("运行中"),
    ]);

    // 复位：后续用例都建立在「空闲」这份基准视图上
    window.webContents.send("session.view", smokeView({}));
    await sleep(300);
    checks.push(["⑥ 复位后回到空闲", (await liveProbe()).state === "idle"]);

    // ---- A3-3：页签关闭 + 「+」新增视图 ----
    // 此刻 2 个页签（正在处理 / 浏览器）——⑦-G 取消「改动」「文件」后，
    // 「正在处理」是唯一常驻视图，「浏览器」是唯一默认可关闭的页签。
    log("[A3-3] 页签关闭与「+」新增视图");
    const dock0 = await probe();
    checks.push(["展开态有「+」新增视图入口", dock0.addButton]);
    checks.push([
      "关闭按钮只出现在可关闭页签上（默认视图没有，⑦-E）",
      dock0.tabClose.length === 1 && dock0.tabClose.includes("关闭浏览器"),
    ]);

    // 「+」菜单：只列产品里真有的视图；点菜单外即收
    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    const menu = await probe();
    checks.push([
      "「+」菜单只列真的存在的视图（⑦-H 取消「工具」、⑦-G 取消「改动」「文件」后共 3 项）",
      menu.menuItems.length === 3 &&
        ["browser", "usage", "rules"].every((kind) => menu.menuItems.includes(kind)),
    ]);
    // 三个被取消的 kind 都**不是被藏起来**：只断言「菜单里少一项」不够——
    // 要确认它们连打开都打不开（否则就是一个点了没反应的死菜单项）。
    // `tools` 并入「统计」（⑦-H 第三步）；`changes` / `file` 并入下钻（⑦-G 第四步）。
    checks.push([
      "「工具」「改动」「文件」都已不是可打开的视图（kind 已移除，不是藏起来）",
      ["tools", "changes", "file"].every((kind) => !menu.menuItems.includes(kind)) &&
        (await clickMenuItem("tools")) === false &&
        (await clickMenuItem("changes")) === false &&
        (await clickMenuItem("file")) === false,
    ]);
    await run(`(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    checks.push(["点菜单外即收起「+」菜单", (await probe()).menuItems.length === 0]);

    // 关闭**当前激活**的页签：数量减 1、激活位交还默认视图、原生视图必须收起
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(500);
    checks.push(["激活「浏览器」后原生视图可见", await waitVisible(true)]);
    await clickInDock(`b.getAttribute("aria-label") === "关闭浏览器"`);
    await sleep(400);
    const afterCloseBrowser = await probe();
    checks.push([
      "关闭激活的「浏览器」→ 页签减 1 且激活位交还「正在处理」",
      afterCloseBrowser.tabCount === 1 && afterCloseBrowser.activeLabel === "正在处理",
    ]);
    checks.push(["关闭「浏览器」后原生视图已收起（getVisible=false）", await waitVisible(false)]);

    // 「+」重新打开「浏览器」：关了必须能回来（⑦-E 的出口保证），且原生视图重新可见
    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    await clickMenuItem("browser");
    await sleep(500);
    checks.push([
      "「+」重新打开「浏览器」→ 页签回到 2 且原生视图重新可见",
      (await probe()).tabCount === 2 && (await waitVisible(true)),
    ]);

    // ---- A3-4：下钻的清单层（⑦-G 取代原「本次改动」树）----
    // 受控视图里 3 条改动：package.json（根）、../escape.txt（越界）、src/main/file-read.ts。
    // 故清单应为「根 + src/main」两组、两个文件、隐藏 1 条越界——树没有了，
    // 但「目录分组」与「越界排除」这两条原判据要在新载体上继续钉住。
    log("[A3-4] 清单层：目录分组 / 越界排除 / 逐层下钻与回退");
    await clickInDock(`b.textContent.trim() === "正在处理"`);
    await sleep(300);
    checks.push(["点总账进入清单层", await clickLedger()]);
    await sleep(500);
    const list0 = await drillProbe();
    checks.push([
      "清单按目录分组（根 + src/main），文件用项目内相对路径归组",
      list0.layer === "list" &&
        list0.dirs.includes("") &&
        list0.dirs.includes("src/main") &&
        list0.files.includes(previewRel) &&
        list0.files.includes(treeRel),
    ]);
    checks.push([
      "越界条目不在清单里，且如实说明隐藏了几条（⑦-4：放进去就是死条目）",
      !list0.files.some((path) => path.includes("escape")) && list0.hidden === 1,
    ]);
    checks.push([
      "清单头部只算项目内（2 处 · 2 文件）——与总账同一套双口径，去掉越界后各自收敛",
      await dockHas("2 处 · 2 文件"),
    ]);
    log(
      `  清单：目录 ${JSON.stringify(list0.dirs)}，文件 ${JSON.stringify(list0.files)}，隐藏 ${list0.hidden}`,
    );

    // 清单 → diff：点文件卡（该文件只改过一次，故直接进 diff，不展开历史）
    checks.push(["点清单里的文件卡进入 diff 层", await clickListFile(treeRel)]);
    await sleep(500);
    const diff0 = await drillProbe();
    checks.push([
      "diff 层：面包屑含「正在处理」/ 可点的「本次改动」/ 当前文件三段",
      diff0.layer === "diff" &&
        diff0.crumbs.includes("follow") &&
        diff0.crumbs.includes("list") &&
        diff0.crumbs.includes("current"),
    ]);
    checks.push(["每层底部都有「返回」出口", diff0.back]);

    // diff → 内容：点右上「看文件」
    checks.push(["点 diff 右上「看文件」进入内容层", await clickDrillContent()]);
    await sleep(700);
    const fromList = await fileProbe("");
    checks.push([
      "内容层渲染的就是清单里点的那份文件",
      (await drillProbe()).layer === "content" && fromList.path === treeRel && fromList.hasText,
    ]);
    log(`  清单下钻预览：path=${fromList.path}，渲染文本=${fromList.hasText}`);

    // 逐层回退：ESC（内容 → diff）、底部「返回」（diff → 清单）、面包屑（清单 → 正在处理）。
    // 三条出口分别验一次，避免「只有一条路能回去」这种半吊子实现蒙混过关。
    await run(`(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      return true;
    })()`);
    await sleep(400);
    checks.push(["ESC 从内容层退回 diff 层", (await drillProbe()).layer === "diff"]);
    checks.push(["点底部「返回」命中", await clickDrillBack()]);
    await sleep(400);
    checks.push(["「返回」从 diff 层回到清单层", (await drillProbe()).layer === "list"]);
    checks.push(["点面包屑「正在处理」命中", await clickCrumb("follow")]);
    await sleep(400);
    checks.push(["面包屑退回「正在处理」（退出下钻）", (await drillProbe()).layer === ""]);

    // ---- 净值：多次改动之后，看的是「最终改成了什么」----
    // 逐次 patch 只说「这一次改了什么」。同一个文件改过多次、最后一次又退回原样时，
    // 一串增量相加看着改了很多，文件其实一点没变——故卡片给**净值**（基线 → 现在），
    // diff 层另有一档「累计」。这段用受控视图把三种情形一次钉住，净值不靠文本猜：
    // 判据读的是产品自己渲染的那一小格（`data-clist-net-value`）。
    log("[净值] 三种情形：有净变化 / 已还原 / 没有基线");
    const netRel = "package.json";
    const revertedRel = "src/main/session-manager.ts";
    const noNetRel = "tsconfig.json";
    // 累计档要**真算一次**（主进程读基线 + 读当前盘上的文件），故这里先落一份基线：
    // 故意在真内容后面多一行，净变化因此确定是「删掉 1 行」，patch 里能读到那行标记。
    const netMark = "// smoke-net-baseline";
    recordFileBaseline(sessionId, netRel, {
      existed: true,
      text: `${readFileSync(join(rootPath, netRel), "utf8")}${netMark}\n`,
    });
    window.webContents.send(
      "session.view",
      smokeView({
        fileChanges: [
          // ① 两次改动，最新那条的净值是 −1
          fakeChange("net-1", netRel, stamp + 1, { added: 0, removed: 1 }),
          fakeChange("net-2", netRel, stamp + 2, { added: 0, removed: 1 }),
          // ② 先加后删，最后退回原样 → 净值 0（是**算出来的结论**，不是「算不出」）
          fakeChange("rev-1", revertedRel, stamp + 3, { added: 6, removed: 0 }),
          fakeChange("rev-2", revertedRel, stamp + 4, { added: 0, removed: 0 }),
          // ③ 没有基线（过大 / 二进制 / 读取失败）→ 给不出净值
          fakeChange("none-1", noNetRel, stamp + 5),
        ],
      }),
    );
    await sleep(400);
    checks.push(["推净值受控视图后仍可进清单", await clickLedger()]);
    await sleep(500);
    const netList = await drillProbe();
    const netOf = (path: string): string =>
      netList.nets.find(([item]) => item === path)?.[1] ?? "<未渲染>";
    checks.push(["（前置）清单层已渲染三个文件卡", netList.layer === "list" && netList.files.length === 3]);
    checks.push([`净值：卡片给的是净值（改过两次、净 −1），实为 ${netOf(netRel)}`, netOf(netRel) === "−1"]);
    checks.push([
      `净值：改完又退回原样 → 卡片写「已还原」，实为 ${netOf(revertedRel)}`,
      netOf(revertedRel) === "已还原",
    ]);
    checks.push([`净值：算不出的文件不显示数字，实为「${netOf(noNetRel)}」`, netOf(noNetRel) === ""]);
    checks.push([
      `净值：算不出的文件在清单底部如实计数，实为 ${netList.netUnknown}`,
      netList.netUnknown === 1,
    ]);

    // 展开 → 「全部改动（累计）」→ diff 层的「累计」档。
    // 判据是**正文里出现了基线那一行**：受控改动是 write（没有 patch），
    // 若没落到「累计」档，正文只会是「内核未提供 diff」那句，不可能有这行内容。
    checks.push(["展开改过两次的文件卡", await clickListFile(netRel)]);
    await sleep(300);
    const expanded = await drillProbe();
    checks.push([
      "展开后出现「全部改动（累计）」这一行",
      expanded.netRows.some(([item]) => item === netRel),
    ]);
    // 判据读的是那一格**自己的**元素（`data-clist-net-row-value`），不是整行拼接出来的文字——
    // 拿 label+数字 的整串去等于「−1」，红的是用例而不是产品（AGENTS.md §1.2）
    checks.push([
      `该行给出净值 −1，实为 ${JSON.stringify(expanded.netRowValues)}`,
      expanded.netRowValues.some(([item, text]) => item === netRel && text === "−1"),
    ]);
    checks.push(["点「全部改动（累计）」命中", await clickListNet(netRel)]);
    await sleep(900);
    const netDiff = await drillProbe();
    checks.push([
      "累计档：落在 diff 层，且历史切换里有「累计」这一档",
      netDiff.layer === "diff" && netDiff.diffRevisions.includes("__net__"),
    ]);
    checks.push(["累计档：画的是「基线 → 当前」的真实差异", await dockHas(netMark)]);
    log(`  累计档：档位 ${JSON.stringify(netDiff.diffRevisions)}，命中了基线痕迹=${await dockHas(netMark)}`);

    // 已还原的文件：累计档不必读盘，直接给出结论（再点一次主进程也算不出差异）
    checks.push(["回清单", await clickCrumb("list")]);
    await sleep(400);
    checks.push(["展开已还原的文件卡", await clickListFile(revertedRel)]);
    await sleep(300);
    checks.push(["点它的「全部改动（累计）」", await clickListNet(revertedRel)]);
    await sleep(600);
    checks.push(["已还原的文件，累计档明说「已还原」", await dockHas("本次会话已还原")]);

    // 退出下钻并把受控视图还原成后续用例依赖的那份（3 条改动）
    checks.push(["退出净值场景的下钻", await clickCrumb("follow")]);
    await sleep(300);
    window.webContents.send("session.view", smokeView({}));
    await sleep(400);

    // ---- A3-5：中栏的观测 / 管理面板迁入 ⑦ 页签 ----
    // 迁入前它们在**中栏**另起一个 aside（同一件事两处实现、两套入口）；迁入后
    // 只有「页签」这一个载体，② 的入口与「+」菜单都只是打开同一个页签的快捷方式。
    // ⑦-H 先把 ② 的按钮从 4 个收敛到 2 个：删「改动」（总账接管）、删「工具」（聚合并入「统计」）；
    // ⑦-G 再把「改动」「文件」两个 kind 整个取消（并入下钻）——故 ② 只剩「统计 / 规则」。
    log("[A3-5 / ⑦-H / ⑦-G] 面板迁入页签；② 会话头只剩「统计 / 规则」；「改动」「文件」「工具」都不再是视图");
    const beforeA35 = await probe();
    checks.push(["（前置）此刻共 2 个页签（正在处理 / 浏览器）", beforeA35.tabCount === 2]);

    // 删掉的入口**不能只是画没了**：这里断言它们在会话头里已经点不到
    checks.push([
      "② 会话头不再有「改动」入口（下钻取代，⑦-G）",
      (await clickInHead(`b.textContent.trim().startsWith("改动")`)) === false,
    ]);
    checks.push([
      "② 会话头不再有「工具」入口（聚合并入「统计」）",
      (await clickInHead(`b.textContent.trim() === "工具"`)) === false,
    ]);

    checks.push(["② 会话头有「统计」入口且点击命中", await clickInHead(`b.textContent.trim() === "统计"`)]);
    await sleep(500);
    const usageDock = await probe();
    checks.push([
      "点「统计」→ 新增页签并激活，面板渲染在 ⑦ 内（页签名同为「统计」）",
      usageDock.tabCount === 3 && usageDock.activeLabel === "统计" && (await dockHas("会话统计")),
    ]);
    // 面板**本体**（不只是头部标题）确实画出来了。本场景不跑模型，故 usage / toolCalls 都为空，
    // 它应当是空态——聚合内容在这里喂不了数据，改由 `tests/lib.test.ts` 的纯函数单测覆盖。
    checks.push(["「统计」面板渲染出空态（本场景没有模型 / 工具调用）", await dockHas("还没有统计数据")]);

    checks.push(["② 会话头有「规则」入口且点击命中", await clickInHead(`b.textContent.trim() === "规则"`)]);
    await sleep(500);
    checks.push([
      "点「规则」→ 激活「规则」页签且渲染审批规则面板",
      (await probe()).activeLabel === "规则" && (await dockHas("审批规则")),
    ]);

    // ⑦-H / ⑦-G 起，「工具」「改动」「文件」三个页签都**不存在了**，故这一段不再有
    // 「从『+』菜单打开某个面板」这一步——它们的消失已在上面的「+」菜单断言里钉住。
    const dockA35 = await probe();
    checks.push([
      "两个迁入的页签都可关闭（关闭由页签负责，面板内不再有「收起」）",
      ["关闭统计", "关闭规则"].every((label) => dockA35.tabClose.includes(label)),
    ]);
    // 关键判据：多开面板**不再新增 aside**（中栏浮层已消失）
    checks.push([
      "中栏不再有浮层面板（多开 2 个面板后 aside 数不变）",
      dockA35.asideCount === beforeA35.asideCount,
    ]);
    log(`  迁入后：页签 ${dockA35.tabCount} 个，aside ${dockA35.asideCount} 个`);

    // 关闭「规则」：页签减 1、激活位交还默认视图、面板内容随之卸载
    await clickInDock(`b.getAttribute("aria-label") === "关闭规则"`);
    await sleep(400);
    const closedA35 = await probe();
    checks.push([
      "关闭「规则」→ 页签减 1 且激活位交还「正在处理」",
      closedA35.tabCount === 3 && closedA35.activeLabel === "正在处理",
    ]);
    checks.push(["关闭后规则面板已卸载", (await dockHas("审批规则")) === false]);

    // 「+」重开「规则」：迁入的页签都满足「关了能回来」（⑦-E 的出口保证）
    await clickInDock(`b.getAttribute("aria-label") === "新增视图"`);
    await sleep(300);
    await clickMenuItem("rules");
    await sleep(500);
    const reopenedA35 = await probe();
    checks.push([
      "「+」重开「规则」→ 页签回到 4 且面板重新渲染",
      reopenedA35.tabCount === 4 &&
        reopenedA35.activeLabel === "规则" &&
        (await dockHas("审批规则")),
    ]);

    // ---- B2：浏览器观测抽屉（控制台 / 网络 / 下载）----
    // 抽屉读的是主进程那份 CaptureBuffer（与 browser_read 同源）。这里先在**真实夹具页**上
    // 制造三类事件（控制台报错 / 请求失败 / 触发下载），再断言抽屉把它们显示出来了——
    // 不跑模型，但页面上发生的与用户实际操作时一模一样。
    log("[B2] 浏览器观测抽屉");
    await clickInDock(`b.textContent.trim() === "浏览器"`);
    await sleep(500);
    const obs0 = await obsProbe();
    checks.push([
      "浏览器页签内出现观测抽屉（控制台 / 网络 / 下载三个页签）",
      obs0.present && obs0.tabs.join(",") === "console,network,downloads",
    ]);

    const obsSnap = await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "snapshot",
      params: {},
    });
    const obsRef = (label: string): string | undefined =>
      new RegExp(`\\[(e\\d+)\\] (?:a|button|input) "${label}"`).exec(obsSnap.text)?.[1];
    const consoleRef = obsRef("触发控制台告警");
    const netRef = obsRef("触发请求失败");
    const downloadRef = obsRef("下载测试文件");
    checks.push([
      "夹具页上找到三个观测靶元素",
      consoleRef !== undefined && netRef !== undefined && downloadRef !== undefined,
    ]);
    for (const ref of [consoleRef, netRef, downloadRef]) {
      if (ref === undefined) continue;
      await hostBridge.handle({
        sessionId,
        capability: "browser",
        action: "click",
        params: { ref },
      });
    }
    // 等页面事件到达 + 抽屉的 1s 轮询取到新快照
    await sleep(2500);

    const obsConsole = await obsProbe();
    checks.push([
      "抽屉·控制台：徽标计数 >= 2（error + warning）且列出那条报错",
      obsConsole.counts.console >= 2 &&
        obsConsole.rows.some((row) => row.includes("夹具：这是一条脚本报错")),
    ]);
    log(`  控制台：count=${obsConsole.counts.console}，行数=${obsConsole.rows.length}`);

    checks.push(["切到「网络」页签", await clickObsTab("network")]);
    await sleep(400);
    const obsNetwork = await obsProbe();
    checks.push([
      "抽屉·网络：徽标计数 >= 3（404 + 500 + 网络错误）且列出 /api/missing",
      obsNetwork.counts.network >= 3 && obsNetwork.rows.some((row) => row.includes("/api/missing")),
    ]);
    log(`  网络：count=${obsNetwork.counts.network}，行数=${obsNetwork.rows.length}`);

    checks.push(["切到「下载」页签", await clickObsTab("downloads")]);
    await sleep(400);
    const obsDownloads = await obsProbe();
    checks.push([
      "抽屉·下载：列出刚触发的 payload 文件",
      obsDownloads.counts.downloads >= 1 &&
        obsDownloads.rows.some((row) => row.includes(payloadName)),
    ]);
    log(`  下载：count=${obsDownloads.counts.downloads}`);

    // 收起 / 展开：抽屉占的是「页面区域」的高度，收起后原生视图必须跟着变高——
    // 只改 DOM 不上报 bounds，页面就会被裁掉一块（这条又是截图看不见的）。
    checks.push(["切回「控制台」页签", await clickObsTab("console")]);
    await sleep(400);
    checks.push(["切页签会把抽屉展开", (await obsProbe()).collapsed === false]);

    const expandedHeight = browserView()?.getBounds().height ?? 0;
    checks.push(["点已激活的页签 → 收起抽屉正文", await clickObsTab("console")]);
    await sleep(700);
    const collapsedProbe = await obsProbe();
    checks.push([
      "收起后正文不再渲染（页签与计数仍在）",
      collapsedProbe.collapsed && collapsedProbe.tabs.length === 3,
    ]);
    const collapsedHeight = browserView()?.getBounds().height ?? 0;
    checks.push([
      "收起抽屉后页面区域变高（原生视图 bounds 同步）",
      collapsedHeight > expandedHeight,
    ]);
    log(`  抽屉收起前后：页面区域 ${expandedHeight} → ${collapsedHeight}`);

    await clickObsTab("console");
    await sleep(600);
    checks.push(["再点一次 → 正文回来", (await obsProbe()).collapsed === false]);

    // ---- N1：观测条目的「详情」----
    // 这一屏最常被问的是「刚才那个请求为什么失败」。概览行里 URL / 路径都是截断的
    // （原先只能靠原生 tooltip 兜底），所以点开一条看**完整字段**——而「完整」的判据不看 class，
    // 而是量 `scrollWidth <= clientWidth + 1`：被 truncate 的元素必然超宽，这是个可判定的事实。
    log("[N1] 观测条目详情：点行展开字段表 + 复制");
    const consoleNeedle = "夹具：这是一条脚本报错";
    checks.push(["点控制台那条报错行（整行可点）", await clickObsRow("console", consoleNeedle)]);
    await sleep(300);
    const consoleDetail = await obsDetailProbe();
    checks.push([
      "控制台详情：给出**完整来源 URL**（概览里只有文件名），且只展开这一条",
      consoleDetail.present &&
        consoleDetail.count === 1 &&
        consoleDetail.fields["消息"] === consoleNeedle &&
        (consoleDetail.fields["来源"] ?? "").startsWith("http://127.0.0.1:"),
    ]);
    checks.push([
      "控制台详情：长值没被截断，且带复制入口",
      consoleDetail.copyButton && consoleDetail.truncated.length === 0,
    ]);
    log(`  控制台详情：${JSON.stringify(consoleDetail.fields)}`);
    checks.push(["再点同一行 → 详情收起", await clickObsRow("console", consoleNeedle)]);
    await sleep(250);
    checks.push(["收起后详情已从 DOM 移除", (await obsDetailProbe()).present === false]);

    // 下载：概览里的路径是截断的（只有 tooltip），展开后要给**绝对路径**
    checks.push(["切到「下载」页签", await clickObsTab("downloads")]);
    await sleep(400);
    checks.push(["点那一条下载", await clickObsRow("downloads", payloadName)]);
    await sleep(300);
    const downloadDetail = await obsDetailProbe();
    checks.push([
      "下载详情：绝对路径完整可读（不被截断），并给出体积 / 状态",
      downloadDetail.present &&
        (downloadDetail.fields["路径"] ?? "").includes("browser-downloads") &&
        (downloadDetail.fields["路径"] ?? "").endsWith(payloadName) &&
        (downloadDetail.fields["大小"] ?? "") !== "" &&
        downloadDetail.fields["状态"] === "completed" &&
        downloadDetail.truncated.length === 0,
    ]);
    log(`  下载详情路径：${downloadDetail.fields["路径"]}`);

    // 网络：三条请求（404 / 500 / 连接被拒）。点**最后一条**——它的详情必定落在 132px 的正文之外，
    // 正好验「展开后自动滚进可视区」：否则用户点了只会看到箭头转了，内容在视野之外。
    checks.push(["切到「网络」页签", await clickObsTab("network")]);
    await sleep(400);
    checks.push(["点被拒的那条请求（列表最后一条）", await clickObsRow("network", "refused")]);
    await sleep(400);
    const refusedDetail = await obsDetailProbe();
    checks.push([
      "网络详情：完整 URL + 失败原因，且**自动滚进了可视区**",
      refusedDetail.present &&
        refusedDetail.visibleInBody &&
        (refusedDetail.fields["URL"] ?? "").includes("/refused") &&
        // 与 fixture 模式同一条纪律：只认 `net::ERR_` 前缀。
        // 具体是 REFUSED 还是 UNSAFE_PORT（9 端口在 Chromium 的受限名单里）由内核决定，
        // 写死具体码就是在断言 Chromium 的实现细节，换个端口就红。
        (refusedDetail.fields["错误"] ?? "").startsWith("net::ERR_") &&
        refusedDetail.fields["状态码"] === undefined &&
        refusedDetail.truncated.length === 0,
    ]);
    log(
      `  网络详情：错误=${refusedDetail.fields["错误"]}，` +
        `截断=${JSON.stringify(refusedDetail.truncated)}，` +
        `详情 ${refusedDetail.rectTop}~${refusedDetail.rectBottom} vs 正文 ` +
        `${refusedDetail.bodyTop}~${refusedDetail.bodyBottom}，scrollTop=${refusedDetail.scrollTop}`,
    );

    // 单开：点了另一条，前一条自动收起（正文只有 132px，展开多条只会互相挤出去）
    checks.push(["再点 404 那条", await clickObsRow("network", "/api/missing")]);
    await sleep(400);
    const missingDetail = await obsDetailProbe();
    checks.push([
      "一次只展开一条（前一条已收起），状态码 404 原样给出、不留空的「错误」行",
      missingDetail.count === 1 &&
        missingDetail.fields["状态码"] === "404" &&
        missingDetail.fields["错误"] === undefined,
    ]);

    // 复制：真的写进系统剪贴板（渲染层调 `navigator.clipboard`，这里从**主进程**读回来核对）。
    // ⚠️ 写剪贴板要求**文档处于聚焦状态**（Chromium 的硬规则）：真实用户点这个按钮时窗口必然聚焦，
    // 而冒烟跑到这里时焦点还在终端上——不先聚焦，`writeText` 的 promise 会直接 reject、静默失败。
    window.focus();
    window.webContents.focus();
    await sleep(200);
    checks.push(["点「复制」（先命中测试，确认它真的在可视区那一层）", await clickObsCopy()]);
    await sleep(300);
    const clipboardText = await clipboard.readText();
    checks.push([
      "复制写出的是完整字段文本（含 URL 与状态码），不是概览里那行的截断版",
      clipboardText.includes("URL：") &&
        clipboardText.includes("/api/missing") &&
        clipboardText.includes("状态码：404"),
    ]);
    log(`  剪贴板首行：${clipboardText.split("\n")[0] ?? ""}`);

    // 换页签即收起上一条的展开：否则切回来会突然弹出一条，像是自己冒出来的
    checks.push(["切回「控制台」页签", await clickObsTab("console")]);
    await sleep(400);
    checks.push(["换页签后没有残留的展开详情", (await obsDetailProbe()).present === false]);

    // ---- 原生视图必须**精确覆盖**「页面区域」----
    // 截图看不见这一条（原生视图浮在渲染层之上，截图里它就是页面本身），但错位的后果很显眼：
    // 高度多出来的部分会盖住下方观测抽屉、宽度多出来的部分会被窗口裁掉。
    // 此前只验过「收起/展开时高度会变」，**没验过「与区域相等」**——而它恰恰是间歇性错的：
    // 抽屉再展开时页面区域变矮，那一次上报若没送到，原生视图就停在收起时的高个子，压住抽屉。
    const readAreaRect = (): Promise<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-area]");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      })()`);
    const alignedNow = async (): Promise<boolean> => {
      const area = await readAreaRect();
      const view = browserView()?.getBounds();
      if (area === null || view === undefined) return false;
      const ok =
        Math.abs(view.x - area.x) <= 1 &&
        Math.abs(view.y - area.y) <= 1 &&
        Math.abs(view.width - area.width) <= 1 &&
        Math.abs(view.height - area.height) <= 1;
      if (!ok) log(`  未对齐：区域 ${JSON.stringify(area)} vs 视图 ${JSON.stringify(view)}`);
      return ok;
    };
    /**
     * 页面自己的 `innerWidth`——**必须从浏览器视图的 webContents 读**。
     * `run()` 打的是应用 UI 的渲染层，量到的是窗口宽度而不是页面（这里真踩过一次：
     * 一度读到「页面 1424」，其实是窗口宽度，差点把结论带偏）。
     *
     * 它是「原生视图尺寸真的落到页面」的独立证据：视图设成多大，页面就按多大重排。
     * 用户报的「页面偏大、右侧被窗口边缘切掉」正是这条被破坏的样子——页面比停靠区宽。
     */
    const pageInnerWidth = async (): Promise<number | null> => {
      const view = browserView();
      if (!(view instanceof WebContentsView)) return null;
      return view.webContents.executeJavaScript("window.innerWidth", true);
    };
    // 反复收起 / 展开五轮：单次是赶上还是错过都带偶然性，循环才逼得出「偶尔漏报」
    for (let round = 0; round < 5; round += 1) {
      await clickObsTab("console");
      await sleep(350);
      await clickObsTab("console");
      await sleep(350);
      checks.push([`第 ${round + 1} 轮收起/展开后原生视图仍与页面区域对齐`, await alignedNow()]);
    }
    checks.push(["原生视图与「页面区域」逐像素对齐（多出即遮挡 / 裁切）", await alignedNow()]);
    log(`  对齐：区域 ${JSON.stringify(await readAreaRect())} 视图 ${JSON.stringify(browserView()?.getBounds())}`);

    // ---- 视口联调覆盖必须「可见 + 可撤销」----
    // 它是持久状态（只在显式「恢复」时撤销），且会让原生视图比停靠区更大：实测 1280×800 的覆盖
    // 在 823×643 的停靠区里，右侧被窗口边缘裁掉、下方压住观测抽屉——而从界面上完全看不出这是
    // 联调尺寸，用户只会以为渲染坏了。所以标记与出口都必须真的在，且「恢复」后要回到逐像素对齐。
    const viewportBadge = (): Promise<{
      size: string | null;
      hasReset: boolean;
      resetHittable: boolean;
    } | null> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-viewport]");
        if (!el) return null;
        const reset = el.querySelector("[data-browser-viewport-reset]");
        // 「在 DOM 里」不等于「用户能点到」：标记是小目标，被挤出可视区或被原生视图压住都看不出来。
        // 用命中测试问一次真实问题：这一点上最顶层的元素是不是它？
        let resetHittable = false;
        if (reset) {
          const r = reset.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          resetHittable = hit !== null && (hit === reset || reset.contains(hit));
        }
        return {
          size: el.getAttribute("data-browser-viewport"),
          hasReset: reset !== null,
          resetHittable,
        };
      })()`);
    checks.push(["未联调时头部没有视口标记", (await viewportBadge()) === null]);

    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "viewport",
      params: { width: 1280, height: 800 },
    });
    await sleep(700);
    const badge = await viewportBadge();
    checks.push(["设了视口覆盖后头部出现标记且尺寸正确", badge?.size === "1280x800"]);
    checks.push(["标记里有「恢复」出口", badge?.hasReset === true]);
    checks.push([
      "「恢复」真的在可视区内且可点（不是只存在于 DOM）",
      badge?.resetHittable === true,
    ]);
    const overArea = await readAreaRect();
    const overView = browserView()?.getBounds();
    log(`  覆盖：区域 ${JSON.stringify(overArea)} 视图 ${JSON.stringify(overView)}`);
    checks.push([
      "覆盖确实比停靠区大（即用户看到的「超出、被窗口裁掉」）",
      overArea !== null &&
        overView !== undefined &&
        overView.width > overArea.width &&
        overView.height > overArea.height,
    ]);
    // 覆盖必须**真的落到页面上**：判据取页面自己的 innerWidth，而不是我们设的视图宽度。
    // 页面按 1280 重排，正是「页面比停靠区宽、右侧被窗口边缘切掉」的来源——用户那张截图就是它。
    // 读数写进断言文案：这一条一旦变红，红在「设了多大 / 量到多少 / 区域多宽」哪一段必须一眼可见。
    const iwOverride = await pageInnerWidth();
    checks.push([
      `覆盖尺寸真的落到页面（页面 innerWidth=${iwOverride}，期望 1280）`,
      iwOverride === 1280,
    ]);

    // 点「恢复」也走命中测试取到的那个元素：跟真人点击同一条路径，
    // 而不是直接对隐藏节点调 `el.click()`（那样即使标记被挤出可视区也会"通过"）。
    const clickedReset = await run<boolean>(`(() => {
      const el = document.querySelector("[data-browser-viewport-reset]");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit === null || !(hit === el || el.contains(hit))) return false;
      hit.click();
      return true;
    })()`);
    checks.push(["点「恢复」命中", clickedReset]);
    await sleep(700);
    checks.push(["「恢复」后标记消失", (await viewportBadge()) === null]);
    checks.push(["「恢复」后原生视图回到与页面区域逐像素对齐", await alignedNow()]);
    const afterReset = await readAreaRect();
    const iwAfterReset = await pageInnerWidth();
    checks.push([
      `「恢复」后页面重新按停靠区宽度重排（页面 innerWidth=${iwAfterReset}，区域宽=${afterReset?.width}）`,
      afterReset !== null && iwAfterReset !== null && Math.abs(iwAfterReset - afterReset.width) <= 1,
    ]);

    // ---- B1：用户自己的前进 / 后退 / 刷新 ----
    // 先在夹具站里再真实加载一页（/popup.html）造出历史，再点**界面上的按钮**——
    // 走的就是用户的链路：渲染层点击 → IPC → 主进程 navigationHistory。
    // 判据取主进程读到的**真实 URL**，而不是界面上的文字：按钮画对了却没真导航，
    // 正是这类「看着没问题」的功能最容易假通过的地方。
    log("[B1] 浏览器前进 / 后退 / 刷新（用户链路）");
    const navButtons = (): Promise<{
      present: boolean;
      back: boolean;
      forward: boolean;
      reload: boolean;
    }> =>
      run(`(() => {
        const at = (name) => document.querySelector('[data-browser-nav="' + name + '"]');
        const back = at("back");
        if (!back) return { present: false, back: true, forward: true, reload: true };
        return {
          present: true,
          back: back.disabled,
          forward: at("forward").disabled,
          reload: at("reload").disabled,
        };
      })()`);
    const clickNav = (name: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const el = document.querySelector('[data-browser-nav="' + ${JSON.stringify(name)} + '"]');
        if (!el) return false;
        el.click();
        return true;
      })()`);
    // 这一段的前提是「浏览器视图已建立」（上面真实加载过页面才走到这）。
    // 前提由用例自己建立、自己断言：不成立时明确炸出来，而不是让 null 悄悄往下流
    const mustState = () => {
      const state = hostBridge.browserState(sessionId);
      if (state === null) throw new Error("冒烟前提不成立：浏览器视图应已建立");
      return state;
    };
    const navUrl = (): string => mustState().url;

    const nav0 = await navButtons();
    checks.push(["浏览器头部有后退 / 前进 / 刷新三个按钮", nav0.present]);
    checks.push(["视图已加载时「刷新」可用", nav0.reload === false]);

    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "navigate",
      params: { url: `${server.url}popup.html` },
    });
    await sleep(900);
    const nav1 = await navButtons();
    checks.push(["导航到第二页后「后退」变可用", nav1.back === false]);
    checks.push(["还没退过时「前进」不可用", nav1.forward === true]);
    checks.push(["真实 URL 已是第二页", navUrl().endsWith("/popup.html")]);

    checks.push(["点「后退」按钮命中", await clickNav("back")]);
    await sleep(900);
    const nav2 = await navButtons();
    checks.push(["后退后真实 URL 回到第一页", !navUrl().endsWith("/popup.html")]);
    checks.push(["退到最早一页：后退不可用、前进可用", nav2.back === true && nav2.forward === false]);

    checks.push(["点「前进」按钮命中", await clickNav("forward")]);
    await sleep(900);
    const nav3 = await navButtons();
    checks.push([
      "前进后回到第二页，后退重新可用",
      navUrl().endsWith("/popup.html") && nav3.back === false && nav3.forward === true,
    ]);

    checks.push(["点「刷新」按钮命中", await clickNav("reload")]);
    await sleep(900);
    checks.push(["刷新后仍停在同一页", navUrl().endsWith("/popup.html")]);
    log(`  B1 结束时真实 URL：${navUrl()}`);

    // ---- 最窄右栏下也必须逐像素相等 ----
    // 用户实测「把右栏拖窄后载入页面，内容超出 / 被窗口边缘切掉」。此前对齐断言只在 823 这种
    // 宽栏下跑过，而窄栏是几个独立变量（上报频率、抽屉占比、原生视图尺寸都不同），必须单独验。
    await dragGrip(10000);
    await sleep(600);
    const narrowArea = await readAreaRect();
    const narrowView = browserView()?.getBounds();
    log(`  [窄栏] 区域 ${JSON.stringify(narrowArea)} 视图 ${JSON.stringify(narrowView)}`);
    checks.push(["右栏拖到最窄后原生视图仍与页面区域逐像素对齐", await alignedNow()]);

    // 窄栏里还要再验一次「恢复」标记可点：它正是最容易被地址栏挤出可视区的地方
    // （分工是「地址栏 min-w-0 flex-1 先截断、标记 shrink-0 保位」，这里验的就是这个分工真的成立）。
    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "viewport",
      params: { width: 375, height: 700 },
    });
    await sleep(700);
    const narrowBadge = await viewportBadge();
    checks.push([
      "最窄右栏下「恢复」标记仍在可视区内且可点",
      narrowBadge?.resetHittable === true,
    ]);
    await hostBridge.handle({
      sessionId,
      capability: "browser",
      action: "viewport",
      params: {},
    });
    await sleep(700);
    checks.push(["最窄右栏下「恢复」后仍逐像素对齐", await alignedNow()]);

    // ---- ③「页面装不下、够不到」必须说出来（v1.39）----
    // 最小窗口（1024）下右栏最多只有 ~423px，而固定宽度的站点会被原生视图裁掉；若页面又禁了
    // 横向滚动，被裁的部分**既没有滚动条也没有别的入口**，而界面上看不出是页面本身装不下。
    // 判据取提示条给出的数字，不看 class；数字正好能验出「量的是页面内容宽，不是视口宽」
    // （量错成视口宽时它会等于可视区宽，永远不触发）。
    const clippedBadge = (): Promise<{ size: string | null; text: string } | null> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-clipped]");
        return el ? { size: el.getAttribute("data-browser-clipped"), text: el.textContent } : null;
      })()`);
    /**
     * 页面侧的横向量——**必须从浏览器视图的 webContents 读**（`run()` 打的是应用 UI）。
     * 打印它是为了让这条一旦变红时能一眼看清「是页面真的没溢出，还是我们的口径量错了」。
     */
    const pageMetrics = async (): Promise<Record<string, number> | null> => {
      const view = browserView();
      if (!(view instanceof WebContentsView)) return null;
      return view.webContents.executeJavaScript(
        `(() => ({
          innerWidth: window.innerWidth,
          docClientWidth: document.documentElement.clientWidth,
          docScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body ? document.body.scrollWidth : -1,
        }))()`,
        true,
      );
    };
    const gotoPage = async (suffix: string): Promise<void> => {
      await hostBridge.handle({
        sessionId,
        capability: "browser",
        action: "navigate",
        params: { url: `${server.url}${suffix}` },
      });
      await sleep(900);
    };

    // 右栏显式回最窄：不依赖上一段恰好停在最窄这个偶然状态
    await dragGrip(10000);
    await sleep(600);
    await gotoPage("narrow.html");
    const clippedNarrow = await clippedBadge();
    const [needRaw, areaRaw] = (clippedNarrow?.size ?? "").split(">");
    const need = Number(needRaw);
    const area = Number(areaRaw);
    log(`  [装不下] 窄栏提示条：${JSON.stringify(clippedNarrow)}`);
    log(`  [装不下] 页面侧横向量：${JSON.stringify(await pageMetrics())}`);
    log(`  [装不下] 主进程状态：${JSON.stringify(hostBridge.browserState(session.id))}`);
    checks.push([
      `窄栏遇上固定宽度页面 → 提示条如实给出「需要 ${need}px / 可视区 ${area}px」`,
      clippedNarrow !== null && need >= 700 && need <= 720 && area > 0 && area < 500,
    ]);
    // 提示条是横在「页面区域」之上的：它一出现，区域矩形就变矮，原生视图必须跟着收。
    // 这一条正是「电平」那一类——原生视图浮在渲染层之上，错位了肉眼看不出来。
    checks.push(["提示条出现后原生视图仍与页面区域逐像素对齐", await alignedNow()]);

    // 同一个页面、把右栏拉到最宽：装得下了，提示必须**自己消失**。
    // 这一条防的是「栏一窄就挂一条常驻提示」——那种提示永远为真，比没有提示更糟（它会持续撒谎）。
    await dragGrip(-10000);
    await sleep(900);
    log(`  [装得下] 宽栏提示条：${JSON.stringify(await clippedBadge())}`);
    checks.push([
      "右栏拉宽到装得下之后提示条自行消失（不是常驻灰条）",
      (await clippedBadge()) === null,
    ]);

    // 复原成最窄，免得把「最窄」这个上下文留给后面的段落（其余段落只用到输入区）
    await dragGrip(10000);
    await sleep(400);

    // ---- 「适应宽度」：把装不下的页面等比缩小（v1.40）----
    // 上面那条横条原先只解释、不给出口（「拖宽右栏或最大化窗口即可」），而右栏上限本就受窗口
    // 宽度限制（上限 = 窗口内容宽 − 601）——用户读完那句话依然什么也做不了。现在横条上直接给
    // 「适应宽度」：整页等比缩小，右侧被裁掉的部分重新可见。
    //
    // 缩放**不动原生视图的矩形**（只改页面的 CSS 视口），所以「逐像素对齐」这条硬约束在缩放
    // 期间仍必须成立，本节每一步都跟着复核一次。
    // 判据一律取**页面自己的读数**（innerWidth），不看 class、也不看界面上那个百分比文字——
    // 「界面写了个 60% 但页面根本没缩」正是这类功能最容易假通过的地方。
    const zoomBadge = (): Promise<number | null> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-zoom]");
        return el ? Number(el.getAttribute("data-browser-zoom")) : null;
      })()`);
    /**
     * 「适应宽度」按钮的存在与可点。
     * 只说 `present` 会漏掉被挤出可视区的那种「看得见字号、点不到」的假出口（窄栏下真发生过），
     * 故可点性一律用命中测试判——与真人点击同一条路径。
     */
    const fitState = (): Promise<{ present: boolean; hittable: boolean }> =>
      run(`(() => {
        const el = document.querySelector("[data-browser-fit]");
        if (!el) return { present: false, hittable: false };
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          present: true,
          hittable: r.width > 0 && r.height > 0 && hit !== null && (hit === el || el.contains(hit)),
        };
      })()`);
    const clickHittable = (selector: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit === null || !(hit === el || el.contains(hit))) return false;
        hit.click();
        return true;
      })()`);

    await gotoPage("narrow.html");
    await sleep(700);
    const needPx = mustState().contentWidth;
    const beforeFit = await readAreaRect();
    log(
      `  [适应宽度] 最窄栏：区域 ${JSON.stringify(beforeFit)}，页面需要 ${needPx}px，主进程 ${JSON.stringify(hostBridge.browserState(session.id))}`,
    );
    checks.push([
      "装不下时横条上真的有「适应宽度」出口，且它落在可视区内可点（不是只存在于 DOM）",
      (await fitState()).hittable,
    ]);

    checks.push(["点「适应宽度」命中", await clickHittable("[data-browser-fit]")]);
    await sleep(1000);
    const clampZoom = await zoomBadge();
    const clampArea = await readAreaRect();
    const clampIw = await pageInnerWidth();
    // 最窄栏里要装下 700px 的页面得缩到约 31%，那已经认不出字了，故比例被钳在可读下限 60%：
    // 页面**确实**缩了（CSS 视口从 219 变成 ≈365），但**仍然装不下**——这时界面必须如实说，
    // 不能假装成功，也不能留一个再按也不会变化的按钮。
    const expectClampIw = clampArea === null ? null : Math.round(clampArea.width / 0.6);
    log(
      `  [适应宽度] 顶到下限：缩放 ${clampZoom}%，页面 CSS 视口 ${clampIw}（期望 ${expectClampIw}）`,
    );
    checks.push([
      `点「适应宽度」后页面真的缩了（区域宽 ${clampArea?.width} → 页面 CSS 视口 ${clampIw}）`,
      clampZoom === 60 &&
        clampIw !== null &&
        expectClampIw !== null &&
        Math.abs(clampIw - expectClampIw) <= 2,
    ]);
    const clampedClip = await clippedBadge();
    log(`  [适应宽度] 顶到下限后横条：${JSON.stringify(clampedClip)}`);
    checks.push([
      "顶到最小可读比例仍装不下时，横条改为如实说明「已经缩到 60%」",
      clampedClip !== null && clampedClip.text.includes("60%"),
    ]);
    checks.push([
      "此时不再摆一个再按也不会变化的「适应宽度」（死控件比缺失更伤信任）",
      (await fitState()).present === false,
    ]);
    checks.push(["缩放期间原生视图仍与页面区域逐像素对齐", await alignedNow()]);

    // 把右栏拉到「缩得动」的宽度：装下 needPx 需要缩到 needPx×60% 以上，又要窄于 needPx
    // 才看得到「缩了但不是 100%」这个中间态。取 500。
    const midTarget = 500;
    await dragGrip(Math.round((clampArea?.width ?? 219) - midTarget));
    await sleep(1000);
    const midArea = await readAreaRect();
    const midZoom = await zoomBadge();
    const midIw = await pageInnerWidth();
    log(
      `  [适应宽度] 拉宽到 ${midArea?.width}：缩放 ${midZoom}%，页面 CSS 视口 ${midIw}（页面需要 ${needPx}）`,
    );
    // 「比例跟着宽度重算」是这条的关键：缩放期间**不重量** contentWidth（那是页面在 100% 下的
    // 固有属性，缩放后量会得出「本来就装得下」的假象，进而把缩放退回去来回震荡），但比例必须用
    // 新宽度重算。若它停在 60% 不动，页面 CSS 视口会是区域宽÷0.6 ≈ 833 而不是 needPx。
    checks.push([
      `右栏拉宽后比例自动重算到刚好装满（区域 ${midArea?.width}，缩放 ${midZoom}%，页面 CSS 视口 ${midIw} ≈ 需要宽 ${needPx}）`,
      midArea !== null &&
        needPx > 0 &&
        midArea.width >= Math.ceil(needPx * 0.6) &&
        midArea.width < needPx &&
        midZoom !== null &&
        midZoom > 60 &&
        midZoom < 100 &&
        midIw !== null &&
        Math.abs(midIw - needPx) <= 8,
    ]);
    checks.push(["缩到刚好装满后横条自己消失（不是常驻灰条）", (await clippedBadge()) === null]);
    checks.push(["缩放状态下原生视图仍与页面区域逐像素对齐", await alignedNow()]);

    // 「还原」出口必须**常驻工具条**而不是挂在横条上：一旦缩到装下，横条就自己消失了，
    // 还原入口若跟着横条走，用户按完「适应宽度」就再也回不去（只能刷页面）。
    checks.push(["缩到装下之后，工具条上仍留着「还原」出口", await clickHittable("[data-browser-zoom-reset]")]);
    await sleep(1000);
    const backArea = await readAreaRect();
    const backIw = await pageInnerWidth();
    log(`  [适应宽度] 还原后：缩放 ${await zoomBadge()}%，页面 CSS 视口 ${backIw}，区域 ${backArea?.width}`);
    checks.push([
      `「还原」后回到 100%（工具条缩放指示消失，页面 ${backIw} 重新等于区域宽 ${backArea?.width}）`,
      (await zoomBadge()) === null &&
        backArea !== null &&
        backIw !== null &&
        Math.abs(backIw - backArea.width) <= 20,
    ]);
    checks.push([
      "「还原」后横条回来、并重新给出「适应宽度」出口",
      (await clippedBadge()) !== null && (await fitState()).present,
    ]);

    // 复原成最窄，别把「右栏较宽」这个上下文留给后面的段落
    await dragGrip(10000);
    await sleep(400);

    // ---- `/compact` 斜杠命令（手动上下文压缩）----
    // 压缩链路本身早已存在（`session.compact` → worker 的 compact 分支），本条验的是
    // **输入框能不能把它叫出来**，以及「未知 / 带参数的写法会不会被误吞」。
    //
    // 判据不用界面文字，直接在 `sessionManager` 上打桩计数：命令是否被识别、
    // 以及它是走了压缩还是被当成普通提问发出（后者会打到 `promptOrReconnect`）。
    // 打桩跑完立刻恢复，不残留到其他段落。
    //
    // ⚠️ 打桩**只记账、不转发**（v1.41 订正）。原先三个桩都转给了真实现，代价是：
    //   · 每次跑 `dock` 都会**真打一次模型**——`/compact 帮我看看` 与 `/usr/local/bin/node`
    //     两句是**真 prompt**（实测会话记录里带着 provider / modelId / usageId），而这本是个
    //     「不调用模型、不产生计费」的模式；`dock` 也因此变成**唯一会给用户账单的动作**。
    //   · 这两句测试文本会写进**用户真实项目里的真实会话历史**，混在侧栏的会话列表里。
    // 而这三条断言问的都是「渲染层选了哪条路径」，与真发无关——转发是多余的。
    const compactCalls: string[] = [];
    const promptCalls: string[] = [];
    const realCompact = sessionManager.compact.bind(sessionManager);
    const realCompactOrReconnect = sessionManager.compactOrReconnect.bind(sessionManager);
    const realPromptOrReconnect = sessionManager.promptOrReconnect.bind(sessionManager);
    sessionManager.compact = (id: string) => {
      compactCalls.push(id);
    };
    sessionManager.compactOrReconnect = async (id: string) => {
      compactCalls.push(id);
    };
    sessionManager.promptOrReconnect = async (_id: string, text: string) => {
      promptCalls.push(text);
    };

    /** 把文本敲进输入框并回车——用真实事件驱动，走的是用户那条按键通道 */
    const typeAndEnter = (text: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const ta = document.querySelector("textarea");
        if (!ta) return false;
        // React 受控组件：必须用原生 setter 写值再派发 input，否则 onChange 收不到
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true,
        }));
        return true;
      })()`);

    const inputValue = (): Promise<string> =>
      run<string>(`(document.querySelector("textarea") || {}).value ?? ""`);
    const slashButton = (): Promise<boolean> =>
      run<boolean>(
        `!!document.querySelector('[data-slash-command="compact"]')`,
      );

    /** 只把文本写进输入框、**不回车**（`/` 候选浮层要在「还没提交」的状态下观察） */
    const typeText = (text: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const ta = document.querySelector("textarea");
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);

    /** 单独敲一个键（浮层的方向键 / Enter / Esc 都要在不改文本的情况下派发） */
    const pressKey = (key: string): Promise<boolean> =>
      run<boolean>(`(() => {
        const ta = document.querySelector("textarea");
        if (!ta) return false;
        ta.focus();
        ta.dispatchEvent(new KeyboardEvent("keydown", {
          key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
        }));
        return true;
      })()`);

    // 命令的可见入口必须真能点（且它自己也走同一条 compact 路径）
    checks.push(["输入区有 /compact 的可点入口", await slashButton()]);

    // ① 裸 `/compact`：应走压缩，输入框被消费，且不发普通提问
    compactCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/compact");
    await sleep(400);
    checks.push([
      "敲 /compact 回车 → 真的派发了上下文压缩",
      compactCalls.includes(session.id),
    ]);
    checks.push(["/compact 不会被当成普通提问发出去", promptCalls.length === 0]);
    checks.push(["命令输入框被清空（已消费，不会滞留）", (await inputValue()) === ""]);

    // ② 带正文的 `/compact ...`：必须回落成普通提问。
    // 这条是**防误吞**：若只按前缀匹配，用户写「用 /compact 压缩一下」这句话就永远发不出去了。
    compactCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/compact 帮我看看");
    await sleep(400);
    checks.push([
      "带正文的 /compact … 不被当成命令（回落成普通提问）",
      compactCalls.length === 0 && promptCalls.some((t) => t.includes("/compact 帮我看看")),
    ]);

    // ③ 未知命令同样放行：贴路径（/usr/...）是很常见的输入
    compactCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/usr/local/bin/node");
    await sleep(400);
    checks.push([
      "以 / 开头的普通文本（如路径）照常发出",
      compactCalls.length === 0 && promptCalls.some((t) => t === "/usr/local/bin/node"),
    ]);
    log(`  /compact 打桩：compact=${compactCalls.length}，prompt=${promptCalls.length}`);

    // ---- `/memory-tidy` 斜杠命令（显式整理记忆，L3b）----
    // 与 /compact 同一条验证思路：命令识别在渲染层本地，路径选择要在 sessionManager
    // 上打桩才看得见。同样**只记账、不转发**——整理是一次真实模型调用，
    // 转发就破坏了「dock 不打模型、不计费」的约定（v1.41 的教训）。
    const tidyCalls: string[] = [];
    const realMemoryTidy = sessionManager.memoryTidy.bind(sessionManager);
    const realMemoryTidyOrReconnect = sessionManager.memoryTidyOrReconnect.bind(sessionManager);
    sessionManager.memoryTidy = (id: string) => {
      tidyCalls.push(id);
    };
    sessionManager.memoryTidyOrReconnect = async (id: string) => {
      tidyCalls.push(id);
    };

    tidyCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/memory-tidy");
    await sleep(400);
    checks.push(["敲 /memory-tidy 回车 → 派发了记忆整理", tidyCalls.includes(session.id)]);
    checks.push(["/memory-tidy 不会被当成普通提问发出去", promptCalls.length === 0]);
    checks.push(["/memory-tidy 输入框被清空（已消费，不会滞留）", (await inputValue()) === ""]);

    // 带正文不算命令：与 /compact 同一条防误吞规则（零参数命令必须独占整条输入）
    tidyCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/memory-tidy 顺便删掉过时的");
    await sleep(400);
    checks.push([
      "带正文的 /memory-tidy … 不被当成命令（回落成普通提问）",
      tidyCalls.length === 0 && promptCalls.some((t) => t.includes("/memory-tidy 顺便删掉过时的")),
    ]);

    // 本段自己的桩立即恢复；promptOrReconnect 的桩还要服务后面的 /skill 段
    sessionManager.memoryTidy = realMemoryTidy;
    sessionManager.memoryTidyOrReconnect = realMemoryTidyOrReconnect;
    // 与 /compact 段同款：打的是**最终态**——上一条带正文的输入应回落成了普通提问
    log(`  /memory-tidy 打桩：tidy=${tidyCalls.length}，prompt=${promptCalls.length}`);

    // ---- `/skill` 斜杠命令（显式调用技能）----
    // 「技能」在内核里是**两条互不相干的通道**：模型能不能看见清单（靠应用自己把
    // `formatSkillsForSystemPrompt` 拼进系统提示词），与 `resources.skills` 提供的
    // 「按名显式调用」完全是两码事——详见 ARCHITECTURE §四。本条验的是**输入框能不能
    // 把后者叫出来**，以及三个最容易出事的边界：
    //   · 名字打错 → **就地拦下**：不发 IPC、**输入一个字都不丢**（v1.43 修掉的那件事：
    //     原先先清空再发，worker 报错时用户已经白敲了一整句），且错误可见、点出正确写法；
    //   · 只写 `/skill`（没给名字）→ 必须回落成普通提问（防误吞，与 `/compact …` 那条对称）。
    // 「错误文案里带不带可用技能名」由 tests/skill-error.test.ts 断言——纯字符串逻辑，
    // 不必为它真拉一个 worker 进程起来（与上面 `/compact` 同理：打桩**只记账、不转发**）。
    const skillCalls: { name: string; instructions: string | undefined }[] = [];
    const realSkill = sessionManager.skill.bind(sessionManager);
    const realSkillOrReconnect = sessionManager.skillOrReconnect.bind(sessionManager);
    sessionManager.skill = (_id: string, name: string, instructions: string | undefined) => {
      skillCalls.push({ name, instructions });
    };
    sessionManager.skillOrReconnect = async (
      _id: string,
      name: string,
      instructions: string | undefined,
    ) => {
      skillCalls.push({ name, instructions });
    };

    // **前置**：本地拦截的前提是渲染层手里有本会话的技能清单，而清单只在 worker 起来后
    // 才上报。先单独断言这条，否则环境里没有可用模型服务时，下面的红是**假红**——
    // 会被误读成「拦截坏了」（`AGENTS.md` §1.2：先怀疑前置，别先改被测对象）。
    const skillsKnown = Array.isArray(sessionManager.getView(session.id)?.skills);
    checks.push(["前置：本会话视图已带技能清单（本地拦截据此才能成立）", skillsKnown]);

    // ① 名字打错：**就地拦下**——不发 IPC、也不变成普通提问、输入原样留着
    compactCalls.length = 0;
    promptCalls.length = 0;
    skillCalls.length = 0;
    await typeAndEnter("/skill no-such-skill-colt");
    await sleep(400);
    checks.push([
      "敲 /skill <未知名> → 本地拦下（既没走技能 IPC，也没变成普通提问）",
      skillCalls.length === 0 && promptCalls.length === 0,
    ]);
    checks.push([
      "拦下时输入**原样留着**（改一个字母就能重敲，不必整句重打）",
      (await inputValue()) === "/skill no-such-skill-colt",
    ]);
    const skillError = await run<string>(
      `(document.querySelector("[data-conv-error]")?.textContent ?? "")`,
    );
    checks.push([
      "错误可见且**点出正确写法**（报出打错的名字 / 或说清技能该放哪）",
      skillError.includes("技能「no-such-skill-colt」不存在"),
    ]);

    // ② 那半句额外指示也不能跟着丢——这正是用户报的现象（打错一个字母，白敲一整句话）
    await typeAndEnter("/skill no-such-skill-colt 只改这一处");
    await sleep(400);
    checks.push([
      "名字后那半句额外指示也留在输入里（整句没丢）",
      (await inputValue()) === "/skill no-such-skill-colt 只改这一处",
    ]);

    // ③ 只写 `/skill`：不给名字就不算命令 → 回落成普通提问（防误吞）
    skillCalls.length = 0;
    promptCalls.length = 0;
    await typeAndEnter("/skill");
    await sleep(400);
    checks.push([
      "裸 /skill（没给名字）回落成普通提问，不被吞掉",
      skillCalls.length === 0 && promptCalls.some((text) => text === "/skill"),
    ]);
    log(
      `  /skill：清单已知=${skillsKnown}，打桩 skill=${skillCalls.length}，prompt=${promptCalls.length}`,
    );

    // ---- `/` 候选浮层：技能**唯一的可发现入口**（v1.44）----
    // 上面验的是「打错名字会不会丢输入」，这里验的是**用户怎么知道有哪些技能**。
    // 它必须走完**整条链**：敲 / → 弹出 → 选中 → 写入输入框 → 回车真的走技能 IPC。
    // 少任何一环这个入口就是死的（`AGENTS.md` §3.6），只断言「浮层出现了」等于没验「选中能不能用」。
    //
    // 夹具里那个真实会话**一个技能都没装**（本仓没有 `.agents/skills`），所以这里推一份
    // **带技能**的受控视图——`smokeView()` 会整份替换渲染层那份视图，`skills` 必须显式给，
    // 否则浮层只会列 `/compact`（见 `AGENTS.md` ⑪）。
    const MENU_SKILLS = ["pdf", "code-review"];
    window.webContents.send("session.view", smokeView({ skills: MENU_SKILLS }));
    await sleep(400);
    const menuItems = (): Promise<string[]> =>
      run<string[]>(
        `[...document.querySelectorAll("[data-slash-menu] [data-slash-item]")]` +
          `.map((el) => el.getAttribute("data-slash-item") ?? "")`,
      );

    await typeText("/");
    await sleep(250);
    checks.push([
      "敲 / 弹出候选：/compact + /memory-tidy + 本会话每个技能各一项",
      JSON.stringify(await menuItems()) ===
        JSON.stringify(["/compact", "/memory-tidy", "/skill pdf", "/skill code-review"]),
    ]);
    // 「在 DOM 里」不等于「用户点得到」——浮层是绝对定位、祖先里还有 overflow-hidden，
    // 所以做命中测试：候选的中心点上最上面那一层必须是它自己（同小目标入口那条老坑）。
    checks.push([
      "候选真的落在可视区且点得到（不是只存在于 DOM）",
      await run<boolean>(`(() => {
        const item = document.querySelector("[data-slash-menu] [data-slash-item]");
        if (!item) return false;
        const r = item.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!at && (at === item || item.contains(at));
      })()`),
    ]);

    // ⚠️ 这条是本段的要害：**浮层开着时 Enter 是「选中」，不是「发送」**。
    // 不拦这一下，用户选中技能的那次回车会把半截命令（`/skill pd`）当正文发出去——
    // 技能没调用、输入也没了，是比「按了没反应」更糟的一种失败。
    promptCalls.length = 0;
    skillCalls.length = 0;
    await typeText("/skill pd");
    await sleep(250);
    await pressKey("Enter");
    await sleep(300);
    checks.push([
      "浮层开着时 Enter 是「选中」：既没当正文发出去，也没提前调用技能",
      promptCalls.length === 0 && skillCalls.length === 0,
    ]);
    checks.push([
      "选中后命令写回输入框，且带尾随空格（好接着写那半句额外指示）",
      (await inputValue()) === "/skill pdf ",
    ]);
    checks.push([
      "光标停在末尾（额外指示是接着打的，不会被插到中间）",
      await run<boolean>(
        `(() => { const ta = document.querySelector("textarea");
                  return !!ta && ta.value.length > 0 && ta.selectionStart === ta.value.length; })()`,
      ),
    ]);
    checks.push(["选中后浮层自己收起（不用再按一次 Esc）", (await menuItems()).length === 0]);

    // 选中之后那段输入必须真的**能用**——这才是「不是死控件」的判据
    promptCalls.length = 0;
    skillCalls.length = 0;
    await pressKey("Enter");
    await sleep(400);
    checks.push([
      "选中后直接回车 → 真的走技能 IPC（浮层已收起，Enter 回到「发送」语义）",
      skillCalls.length === 1 &&
        skillCalls[0]?.name === "pdf" &&
        promptCalls.length === 0,
    ]);

    // 路径不弹浮层：否则每次贴 `/usr/...` 都会跳一个菜单出来（v1.34 的防误吞同理）
    await typeText("/usr/local");
    await sleep(250);
    checks.push([
      "以 / 开头的路径**不弹浮层**（一个候选都匹配不上）",
      (await menuItems()).length === 0,
    ]);

    await typeText("/");
    await sleep(250);
    checks.push(["前置：Esc 用例之前浮层确实开着", (await menuItems()).length > 0]);
    await pressKey("Escape");
    await sleep(250);
    checks.push([
      "Esc 只收起浮层、**不动输入**（清空输入是另一件事，不能顺手替用户决定）",
      (await menuItems()).length === 0 && (await inputValue()) === "/",
    ]);

    // 整条命令已敲全 → 浮层让开。少了这条，用户敲对 `/compact` 之后回车会被「选中」吃掉，
    // **得先按 Esc 才发得出去**——命令没问题，却被浮层拦住，是最难自查的一种。
    compactCalls.length = 0;
    promptCalls.length = 0;
    await typeText("/compact");
    await sleep(250);
    checks.push([
      "整条命令已敲全 → 浮层让开（否则回车会被「选中」吃掉）",
      (await menuItems()).length === 0,
    ]);
    await pressKey("Enter");
    await sleep(400);
    checks.push([
      "/compact 敲全后回车照常压缩（Enter 的默认语义没被浮层改掉）",
      compactCalls.includes(session.id),
    ]);
    log(
      `  / 候选浮层：清单=${MENU_SKILLS.join("、")}，最后 skill=${skillCalls.length}，prompt=${promptCalls.length}`,
    );

    // 复原打桩，避免影响后续断言（dock 到此也接近尾声）
    sessionManager.compact = realCompact;
    sessionManager.compactOrReconnect = realCompactOrReconnect;
    sessionManager.promptOrReconnect = realPromptOrReconnect;
    sessionManager.skill = realSkill;
    sessionManager.skillOrReconnect = realSkillOrReconnect;

    // ---- ①「等待授权」必须被看见（v1.39）----
    // 「等待授权」是本产品唯一需要用户**立刻拍板**的状态，且有 5 分钟超时；
    // 只显示「运行中 · mm:ss」会让人以为它在正常干活。这里走**真实事件通道**
    // （与 session.view 那批同样），断言侧栏确实改口，而不是直接去改 DOM。
    log("[等待授权] 推 approval.pending：侧栏应改口并在清空后自己摘掉");
    const pendingRequest: ApprovalRequest = {
      toolCallId: "smoke-approval-1",
      sessionId: session.id,
      toolName: "write",
      argsJson: '{"path":"src/main/index.ts"}',
      summary: "写入 src/main/index.ts",
      risk: "moderate",
      reason: "冒烟夹具",
      signature: "smoke:approval",
      requestedAt: Date.now(),
      timeoutMs: 300_000,
    };
    window.webContents.send("approval.pending", {
      sessionId: session.id,
      requests: [pendingRequest],
    });
    await sleep(250);
    const waitingText = "等待你的授权";
    checks.push([
      "有待审时侧栏标出「等待你的授权」",
      await run<boolean>(`document.body.innerText.includes(${JSON.stringify(waitingText)})`),
    ]);
    // 清空后必须自己摘掉：一条不会消失的「等待授权」比没有信号更糟（它会一直撒谎）
    window.webContents.send("approval.pending", { sessionId: session.id, requests: [] });
    await sleep(250);
    checks.push([
      "待审清空后「等待你的授权」随之消失",
      !(await run<boolean>(`document.body.innerText.includes(${JSON.stringify(waitingText)})`)),
    ]);

    // ---- ② 附件「没进来」必须说出来（v1.39）----
    // 附件通道只承载图片，非图片过去是**静默 return**：往输入框拖一个 PDF 什么都没发生，
    // 用户只会以为程序坏了。提示还必须落在**输入卡片内**——顶部那条 error 在消息
    // 滚到底时不在视野里，等于没说。
    log("[附件] 拖入非图片 / 混合拖入：提示要落在输入卡片内");
    const dropFiles = (
      specs: { name: string; type: string }[],
    ): Promise<{ notice: string | null; inCard: boolean; alts: string[] }> =>
      run(`(async () => {
        // 按卡片**自己的标记**认（v1.44 起 textarea 外面多了一层 relative 容器，
        // 「输入框的父节点」不再是卡片——见 §5 第 3 条里那处同源的说明）
        const card = document.querySelector("[data-conv-card]");
        const data = new DataTransfer();
        ${specs
          .map(
            (item, index) =>
              `data.items.add(new File([new Uint8Array([137, 80, 78, 71, ${index}])], ${JSON.stringify(item.name)}, { type: ${JSON.stringify(item.type)} }));`,
          )
          .join("\n        ")}
        card.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const notice = card.querySelector("[data-conv-attach-notice]");
        return {
          notice: notice ? notice.textContent : null,
          inCard: notice !== null,
          alts: [...card.querySelectorAll("img[alt]")].map((node) => node.getAttribute("alt")),
        };
      })()`);

    const pdfOnly = await dropFiles([{ name: "需求说明.pdf", type: "application/pdf" }]);
    checks.push([
      "拖入非图片：输入卡片内直接点名被跳过的文件",
      pdfOnly.inCard && (pdfOnly.notice ?? "").includes("需求说明.pdf"),
    ]);
    checks.push(["非图片不会被静默塞成附件", pdfOnly.alts.length === 0]);

    const mixed = await dropFiles([
      { name: "shot.png", type: "image/png" },
      { name: "契约.pdf", type: "application/pdf" },
    ]);
    checks.push([
      "图片照常进附件，同时点名被跳过的非图片",
      mixed.alts.includes("shot.png") && (mixed.notice ?? "").includes("契约.pdf"),
    ]);

    // ---- 工具截图落盘：读回 / 不越界 / 随会话删除清理（见 @shared/tool-output）----
    // 为什么单独立一段：截图**不进** ConversationView（视图是全量快照、流式期间每 50ms 重推，
    // 见 ARCHITECTURE §二），改为 worker 落盘一次、卡片展开时按需读回。主进程这一侧
    // （读回 / 边界 / 删除会话时清目录）**纯逻辑单测碰不到**——它要真的 userData 与真的 IPC；
    // 而 host 冒烟只验了「图能显示」，没验删除后会不会留下孤儿截图。
    //
    // 前提**显式建立**：这里自己写一张假图，不指望「worker 恰好落过盘」——
    // 依赖别人留下的状态，正是这类用例最容易空转的地方（见 AGENTS §五 ⑬）。
    log("[工具截图] 按需读回 / 不越界 / 随会话删除清理");
    const spillSession = createSession(projectId, sessionsDir);
    const spillDir = toolOutputDir(spillSession.id);
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);
    mkdirSync(spillDir, { recursive: true });
    writeFileSync(join(spillDir, "call_smoke.png"), pngBytes);

    const readToolImage = (
      sessionId: string,
      toolCallId: string,
    ): Promise<{ status: string; image?: { data: string; mimeType: string } }> =>
      run(
        `window.colt.invoke("session.toolOutput", ${JSON.stringify({ sessionId, toolCallId })})`,
      );

    const readBack = await readToolImage(spillSession.id, "call_smoke");
    checks.push([
      "按需读回落盘的截图：ok + mime 正确 + 字节与写下去的一致",
      readBack.status === "ok" &&
        readBack.image?.mimeType === "image/png" &&
        readBack.image?.data === pngBytes.toString("base64"),
    ]);

    const absent = await readToolImage(spillSession.id, "call_not_there");
    checks.push(["没有这张图时如实回 missing（不当 ok、也不抛）", absent.status === "missing"]);

    // 越界：**真的放一个能被越界读到的文件**在上一级，再拿 `../名字` 去要。
    // 只断言「返回 missing」是不够的——实现里若压根不拼路径，那种断言照样会过。
    // 这里要证的是它**没有**把上一级那张图读出来（即没真的越出去），
    // 将来若有人把读取改成朴素的 `join(dir, id)`，这条会立刻变红。
    const escapePath = join(spillDir, "..", "escape_probe.png");
    writeFileSync(escapePath, pngBytes);
    const escaped = await readToolImage(spillSession.id, "../escape_probe");
    checks.push(["越界 toolCallId 读不到上一级的同名文件（没真的越出去）", escaped.status !== "ok"]);
    rmSync(escapePath, { force: true });

    await run(
      `window.colt.invoke("session.delete", ${JSON.stringify({ sessionId: spillSession.id })})`,
    );
    await sleep(300);
    checks.push(["删除会话后落盘目录被清掉（不留孤儿截图）", !existsSync(spillDir)]);
    const afterDelete = await readToolImage(spillSession.id, "call_smoke");
    checks.push(["删除后读回不抛异常，仍旧回 missing", afterDelete.status === "missing"]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    // 先出结论再清理：清理出岔子也不该吞掉已拿到的证据
    log("[dock] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
    void server.close();
  }
}

/** 多会话并行 + 分支导航 */
