/**
 * 「测试连接」的探测逻辑钉子。
 *
 * 这里验的不是「设置页有没有这个按钮」，而是探测本身的三个承诺：
 * ① 成功时真的带上了密钥（只看「连通了」不够——不传 header 也照样连通）；
 * ② 失败时把**能定位问题的原文**带回去（HTTP 状态 + 服务端 detail、底层 ECONNREFUSED），
 *    渲染层才有东西可翻译——只回一句「连接失败」等于没有信息；
 * ③ 超时是自己收尾的，不会把请求挂在那里。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { modelsUrl, probeProvider } from "../src/shared/provider-probe";

/** 起一个本地服务，跑完一定关掉（含残留连接，否则 close 会等它） */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "应拿到监听端口");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("modelsUrl：把地址拼成 /models", () => {
  test("带 /v1 的地址保留路径", () => {
    assert.equal(modelsUrl("https://api.example.com/v1"), "https://api.example.com/v1/models");
  });

  test("结尾多余的斜杠只留一个", () => {
    assert.equal(modelsUrl("https://api.deepseek.com/"), "https://api.deepseek.com/models");
    assert.equal(modelsUrl("  https://api.example.com/v1//  "), "https://api.example.com/v1/models");
  });
});

describe("probeProvider：成功与失败都要说得出原因", () => {
  test("2xx：数出模型数，并把密钥放进 Authorization", async () => {
    let seenAuth: string | undefined;
    await withServer(
      (req, res) => {
        seenAuth = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }));
      },
      async (baseUrl) => {
        const result = await probeProvider({ baseUrl, apiKey: "sk-test" });
        assert.equal(result.ok, true);
        assert.equal(result.modelCount, 2);
        assert.ok(result.latencyMs >= 0);
      },
    );
    // 判据取服务端**实际收到**的头：只看本地传参是「自以为带上了」
    assert.equal(seenAuth, "Bearer sk-test");
  });

  test("401：状态行与服务端 detail 原样带回（翻译是渲染层的事）", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      },
      async (baseUrl) => {
        const result = await probeProvider({ baseUrl, apiKey: "sk-bad" });
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /HTTP 401/);
        assert.match(result.error ?? "", /invalid api key/);
      },
    );
  });

  test("连不上：把底层原因带回来，而不是只留一句 fetch failed", async () => {
    // 先占一个端口再放掉，保证这个端口确实没人监听
    let closedBaseUrl = "";
    await withServer(
      (_req, res) => res.end("{}"),
      async (baseUrl) => {
        closedBaseUrl = baseUrl;
      },
    );
    const result = await probeProvider({ baseUrl: closedBaseUrl, timeoutMs: 3000 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /ECONNREFUSED|ECONNRESET|EACCES|ENOTFOUND/);
  });

  test("超时：按自己的上限收尾并说明超时", async () => {
    await withServer(
      () => {
        // 故意不响应：探测必须自己收尾
      },
      async (baseUrl) => {
        const result = await probeProvider({ baseUrl, timeoutMs: 150 });
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /超时/);
      },
    );
  });
});
