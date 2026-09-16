# Colt 浏览器能力验证用例

> 作者：Colt
> 定位：内置浏览器（观测 / 上传 / 下载 / 弹窗）的手动与自动化验证指南
> 特点：**全程不依赖外部网络**——靶子由本地夹具站提供，任何时候都能复现

---

## 1. 为什么要单独做这份用例

浏览器这几项能力都无法靠单测覆盖，必须落在「真实页面 + 真实文件系统」上：

| 能力 | 为什么单测覆盖不到 |
|---|---|
| 上传 | `input[type=file].value` 出于安全不允许 JS 赋值，唯一路径是 CDP 的 `DOM.setFileInputFiles`，得先有一个真实的 file input |
| 下载 | 需要服务端给出 `Content-Disposition: attachment` 才会触发 `will-download`，普通链接只会原地跳转 |
| 控制台 / 网络 | 观测的是 webContents 与 session 的运行时事件，没有真实页面就没有事件 |
| 视口 | 响应式重排要页面真的收到 resize 并重绘 |
| 弹窗拦截 | 要一个真的 `target=_blank` 链接 |

而 `browser_act navigate` 只放行 http/https，`file://` 与 `data:` 都用不了——**起一个本地 HTTP 服务是最小可行做法**，这就是夹具站。

> 验证内部能力用夹具站；只有「能不能连真实网站」才需要公网站点。

---

## 2. 夹具站

### 2.1 起停

```powershell
npm run fixture                       # 默认 http://127.0.0.1:8787/
# 端口被占用时换一个：
$env:COLT_FIXTURE_PORT="9000"; npm run fixture
```

- 唯一数据源：[scripts/fixture-server.mjs](../scripts/fixture-server.mjs)
- 手动体验由它常驻；自动化用例以 `port 0` 进程内拉起，跑完即关，二者共用同一份页面，不会出现两套说法
- 边界：只监听 `127.0.0.1`，只在内存里返回静态内容，**不读写项目文件、不访问外网**；`Ctrl+C` 即消失

### 2.2 路由表

| 路由 | 响应 | 用途 |
|---|---|---|
| `/` | 主页面 | 靶元素都在这里 |
| `/index.html` | 主页面 | 同 `/`（别名，`scripts/fixture-server.mjs:135-138`） |
| `/favicon.ico` | `204` | 避免浏览器自动取 favicon 时产生噪声 |
| `/payload.txt` | `200` + `Content-Disposition: attachment` | 触发真实下载 |
| `/popup.html` | `200` | 弹窗目标页 |
| `/api/missing` | `404` | 4xx 观测 |
| `/api/boom` | `500` | 5xx 观测 |
| 其它 | `404` | 兜底 |

### 2.3 页面靶元素

snapshot 会给出 6 个可交互元素（`e1`~`e6`，序号取决于当时页面，**不要写死**）：

| 元素 | 文案 | 验证点 |
|---|---|---|
| `<input type=file>` | 选择要上传的文件 | 上传 |
| `<a download>` | 下载测试文件 | 下载 |
| `<a target=_blank>` | 打开新窗口 | 弹窗拦截 |
| `<button>` | 触发控制台告警 | console（error + warning 各一条） |
| `<button>` | 触发请求失败 | network（404 / 500 / 连接失败） |
| `<button>` | 延迟 1.5 秒出现文本 | wait(mode=text) |

页面还会在 `resize` 时把 `#layout` 文案在 `窄屏（移动端）布局` / `宽屏布局` 之间切换，供视口验证读取。

---

## 3. 手动验证用例

前置：`npm run fixture` 已起；待上传文件用 `e:\code\opensource\colt\package.json`。

> **观察位置**：浏览器已**内嵌**在右栏工作区（规则 ⑦-C「视野跳跃为零」），
> agent 首次操作页面时会**自动切到「浏览器」页签**（规则 ⑦-F）。
> 所以下面各条「预期结果」里的页面变化，直接在右栏看即可，不需要切窗口；
> 若想同时看清会话叙事与页面，右栏宽度会按视图给出建议值（浏览器 544px）。

### 3.1 观测能力

| # | 操作 | 预期结果 |
|---|---|---|
| A1 | `用浏览器打开 http://127.0.0.1:8787/ ，然后读页面可交互元素` | `已打开 http://127.0.0.1:8787/`；snapshot 列出 6 个带 ref 的元素 |
| A2 | `等页面 DOM 稳定后再读正文` | `等待完成：DOM 停止变化（耗时 0.5s）` |
| A3 | `点「延迟 1.5 秒出现文本」，然后等正文出现「延迟内容已出现」` | `等待完成：正文出现「延迟内容已出现」（耗时 1.5s）` |
| A4 | `点「触发控制台告警」，然后读控制台` | 同时含 `[error] 夹具：这是一条脚本报错` 与 `[warning] 夹具：这是一条废弃 API 告警`（error 不被 info 淹没） |
| A5 | `点「触发请求失败」，等一会儿后看网络` | `网络：共 4 个请求，问题 3 个（4xx 1 / 5xx 1 / 网络错误 1）`，逐条列出 `/api/missing`、`/api/boom` 与连接失败 |
| A6 | `把视口设成 375x700，读正文；再恢复默认，再读正文` | 依次出现 `窄屏（移动端）布局` → `宽屏布局`（证明响应式重排真的发生） |
| A7 | `点「打开新窗口」` | **不新开窗口**，当前窗口转到 `/popup.html`；控制台出现 `拦截新窗口请求，已在当前窗口打开：…` |
| A8 | 看右栏浏览器页签**底部**的观测抽屉，依次点「控制台 / 网络 / 下载」；再点一次激活的页签 | 三个页签各带**问题计数**徽标（控制台 = error+warning、网络 = 4xx/5xx/网络错误、下载 = 条数）；抽屉列出与 A4/A5/B2 一致的内容；再点激活页签则收起正文，页面区域随之变高 |
| A9 | 看右栏浏览器页签**顶部**的后退 / 前进 / 刷新三个按钮：先点页面里的「打开新窗口」跳到 `/popup.html`，再依次点后退 → 前进 → 刷新 | 后退回到 `/`、前进回到 `/popup.html`、刷新后仍停在同一页；按钮可用性跟着真实历史走——刚打开时后退灰、跳到第二页后可用、退到最早一页又变灰而前进变可用。**这一条由用户操作，不走审批**（审批裁决的是模型给出的工具入参） |
| A10 | 让 agent 调一次视口联调（`browser_act viewport` 给 width/height，例如 1280×800），**故意不恢复**；看浏览器页签顶部 | 顶部出现 `联调视口 1280×800 · [恢复]` 标记（warning 边框 + 实心按钮，窄栏下文案会截断成「图标 + 恢复」但按钮一定在）；页面按该尺寸重排，**比停靠区大的部分看不到**（右侧被窗口边缘裁掉、下方压住观测抽屉）——这是刻意保留的联调状态，标记就是用来解释它的。点「恢复」→ 标记消失、页面回到按停靠区尺寸自适应 |

### 3.2 传输能力

| # | 操作 | 预期结果 |
|---|---|---|
| B1 | `看看这个会话下载过什么` | `下载：本会话尚未触发任何下载。` |
| B2 | `点「下载测试文件」` | 不报错；再查下载列表得到 `下载：共 1 个` + `1-colt-payload.txt [24 B] → <绝对路径>` |
| B3 | `读一下刚下载的文件内容` | 内容为 `colt download fixture` |
| B4 | `把 e:\code\opensource\colt\package.json 传到页面那个 file input 里` | `已向 e1 选择 1 个文件：…`；页面同步显示 `已选择：package.json（1613 字节）`（**字节数以实测为准**，随 `package.json` 大小变化） |
| B5 | 观察 B4 的审批分级 | 项目内文件 → 风险**中等**（可「本会话始终允许」） |
| B6 | `把 C:\Windows\System32\drivers\etc\hosts 传上去` | 风险**危险**，每次单独确认（签名带文件路径，无法被「不再询问」批量放行） |
| B7 | `对页面上「下载测试文件」这个链接执行 upload` | 明确拒绝：`e2 不是 file 类型的 input（实际为 A），无法选择文件`，而不是抛晦涩的 CDP 协议错误 |

下载落盘位置：

```
%APPDATA%\Colt\browser-downloads\<会话ID>\<序号>-<文件名>
```

### 3.3 会话与内核

| # | 操作 | 预期结果 |
|---|---|---|
| C1 | 发一个耗时任务，**趁它还在跑**立刻再发一句 | 第二条消息立即进入当前回合（不报错、不另起一轮），会话不被误判空闲回收 |
| C2 | 发一句话 + 附一张纯色图片，问颜色 | 正确答出（证明图片真的送达模型） |
| C3 | 观察运行期间的状态 | 显示**运行中**（修复前恒为空闲） |
| C4 | 先用浏览器打开一个页面，然后**关闭该会话** | 窗口正常关闭，**不弹** "A JavaScript error occurred in the main process" |

### 3.4 一键综合

贴给 Agent 即可扫完观测段：

```
用浏览器打开 http://127.0.0.1:8787/ ，然后依次做：
1) wait(mode=idle)
2) 读 snapshot
3) 点「触发控制台告警」后读 console
4) 点「触发请求失败」，等 2 秒后读 network
5) 点「延迟 1.5 秒出现文本」，然后 wait(mode=text, text=延迟内容已出现)
6) viewport 设为 375x700，读正文；再 viewport 恢复默认，读正文
7) 点「下载测试文件」，等 2 秒后读 downloads
8) 点「打开新窗口」，然后读 url 与 console
```

---

## 4. 自动化用例（`fixture` 模式）

不开模型、直接驱动宿主，把模型随机性排除在结论之外。先停掉正在运行的开发实例（占用 5173），然后：

```powershell
$env:COLT_SMOKE=".smoke-fixture.png"   # 只给文件名，产物固定落在 out/ 下
$env:COLT_SMOKE_MODE="fixture"
npm run dev
```

结论以 `out/.smoke-fixture.png.log` 为准（该模式**刻意不截图**：全程没让主窗口重绘，此时 `capturePage` 会把主进程拖住不返回）。

### 4.1 断言清单（25 条）

| # | 断言 | 对应手动用例 |
|---|---|---|
| 1 | snapshot 找到全部靶元素 | A1 |
| 2 | console 初始无 error | — |
| 3 | network 初始无失败请求 | — |
| 4 | downloads 初始为空态 | B1 |
| 5 | wait(idle) 收敛 | A2 |
| 6 | console 捕获 error | A4 |
| 7 | console 捕获 warning | A4 |
| 8 | network 捕获 404 | A5 |
| 9 | network 捕获 500 | A5 |
| 10 | network 捕获网络错误 | A5 |
| 11 | wait(text) 等到目标文本 | A3 |
| 12 | viewport 窄屏生效 | A6 |
| 13 | viewport 恢复宽屏 | A6 |
| 14 | upload 回报成功 | B4 |
| 15 | 页面收到文件名 | B4 |
| 16 | downloads 记录到下载 | B2 |
| 17 | console 回报下载完成 | B2 |
| 18 | `browser.observe` 结构化控制台含 error 与 warning | A4 / A8 |
| 19 | `browser.observe` 结构化网络含 404 / 500 / 网络错误 | A5 / A8 |
| 20 | `browser.observe` 结构化下载含已落盘那条 | B2 / A8 |
| 21 | 下载文件已落盘 | B3 |
| 22 | 弹窗在当前窗口接管 | A7 |
| 23 | 弹窗拦截有提示 | A7 |
| 24 | 未新开窗口 | A7 |
| 25 | 关闭会话未抛未捕获异常 | C4 |

> 18–20 三条是 B2 加的。它们不重复验观测**内容**（那是 6–10 / 16–17 的活），
> 只钉一件事：**抽屉的数据源与 `browser_read` 是同一份**。故断言直接比对结构化字段
> （`level` / `statusCode` / `error` / `filename`）与上面那些文本判据是否一一对上——
> 哪天 `observe` 换了数据源或漏了一类，这三条先红，而不是等到界面上「看着不太对」。
> 它们必须排在弹窗那步**之前**：接管新窗口会 `capture.reset()`，清掉控制台与网络。

### 4.2 已实测结果

```
✓ 25 项全部通过，末行输出 DONE
夹具站：http://127.0.0.1:<随机端口>/
refs：input=e1 下载=e2 弹窗=e3 控制台=e4 网络=e5 延迟=e6
初始 console：控制台：共 1 条（error 0 / warning 1 / 其它 0）
  [warning] Electron Security Warning (Insecure Content-Security-Policy) … (sandbox_bundle:2)
初始 network：网络：共 1 个请求，未发现失败（无 4xx/5xx 或网络错误）。
observe：console 4 / network 5 / downloads 1
```

**浏览器内嵌化后已复跑通过（2026-09）**：全部通过（当时 22 条，B2 后为 25 条）。其中三条最容易被这次重构打破的断言确认仍成立：

| 断言 | 为什么会被打破 | 结论 |
|---|---|---|
| 12 / 13 viewport 窄屏 / 恢复宽屏 | 视口不再改窗口尺寸 | ✓ 改为给视图覆盖尺寸后，页面 resize 照常触发 |
| 24 未新开窗口 | 载体从窗口换成视图 | ✓ 窗口数始终为 1 |
| 25 关闭会话未抛未捕获异常 | 销毁路径从 `window.destroy()` 换成摘视图 + 关 webContents | ✓ 判活后销毁，无未捕获异常 |

用例**不写死 ref 序号**：`refs` 一行只是本次实测，实际按元素文案认领。

> **B1（用户前进 / 后退 / 刷新）的自动化断言不在这里**，而在**工作区端到端**（`dock` 模式）：
> 它必须点界面上的按钮、走「渲染层 → IPC → `navigationHistory`」这条用户链路，判据取主进程读到的
> **真实 URL**（见 `NEXT-PHASE.md` §5 第 3 条，`dock` 193/193）。`fixture` 模式直接驱动宿主、没有渲染层参与，
> 验不了界面按钮的可用性。同批还覆盖了两条**只在界面上才看得见**的：原生视图与「页面区域」**逐像素**对齐
> （含反复收起/展开 5 轮、**最窄 219 宽也各验一次**）、视口联调标记与「恢复」（**含「恢复」是否真的落在
> 可视区内**——`document.elementFromPoint` 命中测试，只查 DOM 存在会把「被挤出窗口的假出口」判成通过）。
>
> ⚠️ **「超出 / 显示不全」有两种来源，先分清再动手**（用户复测「bing 页面还是超出了」时踩过）：
> ① **原生视图比「页面区域」大**（`viewport` 覆盖）→ 被窗口边缘裁掉 / 压住抽屉；② **页面自己比视口宽**
> → 页面内容被自身裁掉。判据：主进程读 `view.getBounds()` vs 渲染层读 `[data-browser-area]` 的
> `getBoundingClientRect()`，两者相等即视图侧无责；再把**页面自己的 `innerWidth`** 与区域宽度对一下
> （必须用**浏览器视图的 webContents** 读，用应用 UI 只会读到窗口宽度），相等就说明页面确实按停靠区重排了。
>
> ⚠️ **量 ② 时别用 `documentElement.scrollWidth`**：页面自带的 `overflow-x: hidden` 会把它钳到
> `clientWidth`，于是永远「相等」——**一个必然为真的假阴性**。曾据此错判「bing 首页不会横向溢出」。
> 要用 `document.body.scrollWidth`，或遍历全元素取 `getBoundingClientRect().right` 的最大值。
> 实测（真实 bing 首页，`div.hp_body` 最小内容宽 768）：区域 819 / 799 装得下（`body.scrollWidth`
> 804 / 784）；779 起溢出 4px，并随宽度收窄递增到 699 时的 84px。而 `<html>` 是 `overflow-x: hidden`，
> **没有横向滚动条，被裁的部分用户够不到**——所以窄右栏下 ② 是真实存在的来源，不是「只能是 ①」。
> （另有一层：右栏宽度上限 = 窗口内容宽 − 601（左栏 241 + 中栏下限 360），
> 窗口窄于约 1384 时右栏永远到不了 783，这类桌面站点在窄窗口里天生装不下，与实现无关。）

### 4.3 断言 25 的来历：为什么必须单独盯未捕获异常

窗口 `closed` 回调是**异步**触发的，比用例记结论更晚。曾有一版 `closeSession` 在其中访问了已随窗口销毁的 `webContents`，于是：

- 主进程抛 `TypeError: Object has been destroyed`，Electron 弹错误对话框
- 而用例早已打印完「21/21 通过」——**结论是假绿**

所以用例做了两件事：接管 `uncaughtException`（Electron 默认会弹框，自动化跑时没人能点它、日志里也留不下证据），并在关闭会话后 `await` 一拍再断言其为空。这条断言已验证过**能复现该崩溃并变红**。

---

## 5. 已知现象与判读

这些是**预期行为**，不要当缺陷报：

| 现象 | 原因 |
|---|---|
| 初始 console 有 1 条 `warning` | Electron 在 dev 期注入的 `Electron Security Warning (Insecure-Content-Security-Policy)`（来源 `sandbox_bundle`），非页面问题；因此断言只要求「无 error」，不要求「完全为空」。打包后不出现 |
| 初始 network 有 1 个请求 | 就是导航本身的文档请求，不是残留 |
| 视口动作回报的尺寸 = 请求值 | 内嵌化后 `viewport` 直接 `setBounds` 到 WebContentsView，不再经过窗口管理器，故 `375x700` 就是 `375x700`（**旧实现**经独立窗口会微调成 376，已不适用） |
| 「恢复默认视口」回报的不是固定尺寸 | 内嵌后没有「窗口默认尺寸」可言：恢复默认 = 撤销视口覆盖，交还给右栏面板的实测矩形，故尺寸随窗口/面板变化 |
| 截图尺寸大于视口 | 截图是**设备像素**：125% 缩放下约按 1.25 倍换算（例如 375×700 的视口约得 470×875） |
| 浏览器不再弹出独立窗口 | 已内嵌为右栏「浏览器」页签里的 `WebContentsView`；页面仍照常加载、观测与操作，只是画在窗口内 |
| 下载文件名带 `1-` 前缀 | 统一加序号，避免页面反复用同名文件互相覆盖 |
| 下载数达到 5 个后新的被取消 | 单会话条数上限；单文件另有 100MB 体积上限 |
| 观测抽屉最多滞后约 1 秒 | 抽屉按 1s **轮询** `browser.observe`，不是逐条推送——console / network 事件可以很密集，逐条推会变成 IPC 洪泛；详见 `ObserveDrawer.tsx` 顶部注释 |
| 控制台 / 网络条目会跨导航累积 | `CaptureBuffer.reset()` 只在「接管新窗口」时调用，普通导航不清空。给模型看的文本写的「自上次导航以来」是历史措辞，以实际缓冲为准 |
| **视口联调设过之后，页面会一直按那个尺寸摆放** | `viewport` 覆盖**只在显式「恢复」时撤销**（导航、切页签都不清）。若覆盖比停靠区大，右侧被窗口边缘裁掉、下方压住观测抽屉——**这是刻意的联调状态，不是渲染坏了**：浏览器页签顶部会显示 `联调视口 ×` 标记与「恢复」按钮，点它即回到自适应。标记在窄栏下会把文案截断成「图标 + 恢复」，**按钮本身一定留在可视区内**（`dock` 用命中测试盯着这条） |
| **原生视图偶尔与页面区域错位一小段** | 视图矩形是「电平」状态，而 ResizeObserver / window resize 是「边沿」触发；现已加每 400ms 重申兜底，错位最多存在 400ms。若仍看到持续错位，那就是新问题，先看 `dock` 的「逐像素对齐」断言 |
| 用户点了后退 / 前进 / 刷新后，agent **不是立刻**知道 | 提示走内核的 `transform_context`，在**下一次模型请求前**注入——它只该让 agent「下次看页面前先知道手里那份过期了」，不该凭空开一轮去回应 |
| agent 空闲时用户操作浏览器，什么都不发生 | 提示**只在 agent 正在跑时**转发（`sessionManager.notifyUserBrowserNavigation`）。空闲时没有任何操作会被过期页面误导，留一条提示会在很久以后的一轮里凭空出现、变成噪声 |
| 用户操作浏览器**不弹审批** | 审批裁决的是**模型给出的工具入参**；这条链路每跳都由用户点击发起、没有模型参与。且内嵌页是真实 `WebContentsView`，用户本来就能直接点它 |

---

## 6. 维护须知

- **唯一数据源**：页面只在 [scripts/fixture-server.mjs](../scripts/fixture-server.mjs) 里。改页面文案时，需同步检查 [smoke.ts](../src/main/smoke.ts) 里 `runFixture` 按文案认领 ref 的正则，以及本文档的预期结果
- 用例**不写死 ref 序号**：页面加元素不会让断言错位
- 相关文件：
  - 夹具站：[fixture-server.mjs](../scripts/fixture-server.mjs) / [fixture-server.d.mts](../scripts/fixture-server.d.mts)
  - 用例实现：[smoke.ts](../src/main/smoke.ts) 的 `runFixture`
  - 被验证的实现：[browser-host.ts](../src/main/host/browser-host.ts) / [browser-observe.ts](../src/main/host/browser-observe.ts) / [browser-tool.ts](../src/worker/lib/browser-tool.ts)
  - 内嵌形态的渲染层：[WorkspaceDock.tsx](../src/renderer/src/features/Conversation/WorkspaceDock.tsx)（页签 + 页面区域上报）/ [Conversation/index.tsx](../src/renderer/src/features/Conversation/index.tsx)（⑦-F 自动切页签）
  - 观测抽屉（B2）：[ObserveDrawer.tsx](../src/renderer/src/features/Conversation/ObserveDrawer.tsx)（UI）→ `browser.observe` → `HostBridge.browserObservation` → `BrowserHost.observe`
  - 用户前进 / 后退 / 刷新（B1）：[WorkspaceDock.tsx](../src/renderer/src/features/Conversation/WorkspaceDock.tsx) 的 `data-browser-nav` 按钮 → `browser.navigate` → `HostBridge.browserNavigate` → `BrowserHost.navigate`（`navigationHistory`）；告知 agent 走 `browserNotice` → `sessionManager.notifyUserBrowserNavigation` → worker 的 `transform_context`
  - 视口联调标记与恢复（B1 后续修复）：[WorkspaceDock.tsx](../src/renderer/src/features/Conversation/WorkspaceDock.tsx) 的 `data-browser-viewport` / `data-browser-viewport-reset` → `browser.viewport.reset` → `BrowserHost.resetViewport`；原生视图的矩形由 `browser.bounds`（含 400ms 重申）驱动 → `BrowserHost.setBounds` / `#applyBounds`
  - 纯逻辑单测：[tests/browser-observe.test.ts](../tests/browser-observe.test.ts) / [tests/approval.test.ts](../tests/approval.test.ts)
