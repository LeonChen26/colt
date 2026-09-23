/**
 * 本地浏览器夹具站。
 *
 * 给「上传 / 下载 / 控制台 / 网络 / 视口 / 弹窗」这类必须落在真实页面 + 真实文件系统上
 * 的能力，提供一份不依赖外部网络的端到端靶子：验证内部能力时用它，
 * 只有「能不能连真实网站」才需要公网站点。
 *
 * 两种用法，共用同一份页面（唯一数据源）：
 *   - 手动体验：npm run fixture         （默认 http://127.0.0.1:8787/）
 *   - 端到端用例：冒烟以进程内方式 createFixtureServer({ port: 0 }) 拉起，跑完即关
 *
 * 边界：只监听 127.0.0.1，只在内存里返回静态内容，不读写项目文件、不访问外网。
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

const MAIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Colt 夹具页</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; line-height: 1.6; }
  #layout { margin-top: 8px; padding: 8px; background: #e8f5e9; }
  @media (max-width: 600px) { #layout { background: #fff3e0; } }
</style>
</head>
<body>
  <h1>Colt 夹具页</h1>
  <p>用于本地验证浏览器能力，不依赖外部网络。</p>

  <h2>布局</h2>
  <div id="layout">当前：<span id="mode">脚本未运行</span></div>

  <h2>文件上传</h2>
  <input type="file" aria-label="选择要上传的文件">
  <div id="picked">尚未选择文件</div>

  <h2>文件下载</h2>
  <a href="/payload.txt" download>下载测试文件</a>

  <h2>新窗口</h2>
  <a href="/popup.html" target="_blank">打开新窗口</a>

  <h2>控制台与网络</h2>
  <button id="log" type="button">触发控制台告警</button>
  <button id="net" type="button">触发请求失败</button>
  <button id="late" type="button">延迟 1.5 秒出现文本</button>
  <div id="lateBox"></div>

  <!-- 可见性过滤靶：隐藏元素不该进 snapshot 清单；视口下方 800px 阈值内的保留、外的剔除。
       下方按钮用绝对定位钉坐标——若用撑高 spacer，按钮位置 = 内容高度 + spacer，
       会随页面上方内容多少漂移（首版就因此把「视口下方 400px」钉到了约 1000px 处）。 -->
  <h2>可见性过滤</h2>
  <button id="hiddenBtn" type="button" style="display:none">隐藏不应出现的按钮</button>
  <a href="/payload.txt" download style="visibility:hidden">隐藏不应出现的链接</a>
  <button id="nearBelow" type="button">视口下方四百像素</button>
  <button id="farBelow" type="button">视口下方一千二百像素</button>
  <div style="height:2000px"></div>

  <script>
    var mode = document.getElementById('mode');
    var apply = function () {
      mode.textContent = window.innerWidth <= 600 ? '窄屏（移动端）布局' : '宽屏布局';
    };
    apply();
    window.addEventListener('resize', apply);

    var input = document.querySelector('input[type=file]');
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      document.getElementById('picked').textContent = file
        ? '已选择：' + file.name + '（' + file.size + ' 字节）'
        : '尚未选择文件';
    });

    document.getElementById('log').addEventListener('click', function () {
      console.error('夹具：这是一条脚本报错');
      console.warn('夹具：这是一条废弃 API 告警');
    });

    document.getElementById('net').addEventListener('click', function () {
      fetch('/api/missing').catch(function () {});
      fetch('/api/boom').catch(function () {});
      fetch('http://127.0.0.1:9/refused').catch(function () {});
    });

    document.getElementById('late').addEventListener('click', function () {
      setTimeout(function () {
        document.getElementById('lateBox').textContent = '延迟内容已出现';
      }, 1500);
    });

    // 可见性过滤靶：nearBelow 钉在视口下方 400px（阈值 800 内，应保留），
    // farBelow 钉在视口下方 1200px（阈值外，应剔除）。绝对定位相对文档顶，
    // snapshot 时滚动位置为 0，rect.top 恰为 innerHeight + below，与内容高度无关。
    // 加载时求值一次即可——snapshot 断言跑在任何 viewport 覆盖之前，视口还是默认尺寸。
    var pin = function (id, below) {
      var el = document.getElementById(id);
      el.style.position = 'absolute';
      el.style.top = (window.innerHeight + below) + 'px';
      el.style.left = '24px';
    };
    pin('nearBelow', 400);
    pin('farBelow', 1200);
  </script>
</body>
</html>`;

const POPUP_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>夹具·新窗口</title></head>
<body>
  <h1>这是新窗口目标页</h1>
  <p>若你看到的仍是浏览器窗口里的同一页，说明弹窗已被拦截并在当前窗口打开。</p>
</body></html>`;

/** 动作链靶：三字段表单，GET 提交到 form-done——「一次链填完提交」与「提交即跳转」共用 */
const FORM_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>夹具·表单页</title></head>
<body>
  <h1>三字段表单</h1>
  <form action="/form-done.html" method="get">
    <input name="name" aria-label="姓名字段">
    <input name="email" aria-label="邮箱字段">
    <input name="memo" aria-label="备注字段">
    <button type="submit">提交表单</button>
  </form>
</body></html>`;

const FORM_DONE_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>夹具·表单完成</title></head>
<body>
  <h1>表单已提交</h1>
  <div id="echo"></div>
  <script>
    var params = new URLSearchParams(location.search);
    document.getElementById('echo').textContent =
      '姓名=' + params.get('name') + ' 邮箱=' + params.get('email') + ' 备注=' + params.get('memo');
  </script>
</body></html>`;

/**
 * 刻意做成「装不下」的页面：内容固定 700px 宽，且在 `<html>` 上关掉横向滚动。
 *
 * 真实世界里这样写死的站点不少（实测某搜索首页有 768px 的最小内容宽同样禁了横向滚动）。
 * 此时停靠区一旦比它窄，右边被裁掉的部分**既没有滚动条也没有别的入口**，
 * 而界面上完全看不出是页面本身装不下——本页就是给「界面必须说出来」这条用的靶子。
 *
 * 700 这个数刻意选在「最窄右栏（约 219）装不下、最宽右栏（826）装得下」之间：
 * 同一个页面在两个栏宽下呈现相反的结果，才能证明提示是**算出来的**而不是常驻的。
 */
const NARROW_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>夹具·固定宽度页</title>
<style>
  html { overflow-x: hidden; }
  body { margin: 0; }
  #wide { width: 700px; height: 120px; background: #eef; }
</style>
</head>
<body>
  <div id="wide">固定 700px 宽的内容</div>
</body>
</html>`;

const DOWNLOAD_BODY = "colt download fixture\n";

function sendHtml(response, body) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function handleRequest(request, response) {
  // 去掉查询串再路由：表单 GET 提交会带 ?name=... ，精确匹配会把合法页面打成 404
  const url = (request.url ?? "/").split("?")[0];

  // 浏览器会自动取 favicon；不显式处理就会被下面的兜底 404 命中，平白给网络面板添噪声
  if (url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url === "/payload.txt") {
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="colt-payload.txt"',
    });
    response.end(DOWNLOAD_BODY);
    return;
  }
  if (url === "/popup.html") {
    sendHtml(response, POPUP_PAGE);
    return;
  }
  if (url === "/form.html") {
    sendHtml(response, FORM_PAGE);
    return;
  }
  if (url === "/form-done.html") {
    sendHtml(response, FORM_DONE_PAGE);
    return;
  }
  if (url === "/narrow.html") {
    sendHtml(response, NARROW_PAGE);
    return;
  }
  if (url === "/api/missing") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}');
    return;
  }
  if (url === "/api/boom") {
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"boom"}');
    return;
  }
  if (url === "/" || url === "/index.html") {
    sendHtml(response, MAIN_PAGE);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}

/**
 * 起一个夹具站。
 *
 * port 传 0 表示由系统分配（实际端口在返回值里），供端到端用例避免端口冲突。
 */
export function createFixtureServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const server = createServer(handleRequest);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : requestedPort;
      resolve({
        port,
        url: `http://${host}:${port}/`,
        close: () =>
          new Promise((done) => {
            // 浏览器会保持 keep-alive 连接，只调 close() 会一直等连接排空而不回调
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// 直接以脚本方式运行时才起服务；被冒烟 import 时只拿工厂函数
const isCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const started = await createFixtureServer({
    port: Number(process.env.COLT_FIXTURE_PORT ?? DEFAULT_PORT),
  });
  console.log(`[fixture] 夹具站已启动：${started.url}`);
  console.log("[fixture] 只监听本机，Ctrl+C 结束");
}
