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
  </script>
</body>
</html>`;

const POPUP_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>夹具·新窗口</title></head>
<body>
  <h1>这是新窗口目标页</h1>
  <p>若你看到的仍是浏览器窗口里的同一页，说明弹窗已被拦截并在当前窗口打开。</p>
</body></html>`;

const DOWNLOAD_BODY = "colt download fixture\n";

function sendHtml(response, body) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function handleRequest(request, response) {
  const url = request.url ?? "/";

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
