/**
 * worker 环境白名单的钉子（工作包 B）。
 *
 * 这条链路的失败方式全是**静默**的，两头都贵：
 *   - 名单里混进密钥 → 模型一条 `env` 就能读回去，而所有测试仍然全绿；
 *   - 名单漏了宿主需要的键 → bash 找不到 Git Bash、`os.homedir()` 落到 System32、
 *     公司代理的用户模型请求全部超时——都没有任何一行代码会提到「环境变量缺了」。
 * 故这里同时钉「不给什么」与「给什么」，并且要求键是**真的**在名单里
 * （而不是「只要不是密钥就行」——那种写法挡不住上面第二类）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FORBIDDEN_WORKER_ENV,
  WORKER_ENV_CONTROL,
  WORKER_ENV_PASSTHROUGH,
  buildWorkerEnv,
  collectWorkerControl,
} from "../src/main/lib/worker-env";

/** 一份「像真的」宿主环境：白名单键 + 密钥 + 一堆无关的宿主私有变量 */
function hostEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd",
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    USERPROFILE: "C:\\Users\\tester",
    TEMP: "C:\\Users\\tester\\AppData\\Local\\Temp",
    LANG: "zh_CN.UTF-8",
    HTTPS_PROXY: "http://proxy.corp:8080",
    NODE_EXTRA_CA_CERTS: "C:\\certs\\corp.pem",
    // —— 以下都不该出现在 worker 环境里 ——
    COLT_PROVIDER_KEY: "sk-leaked",
    DEEPSEEK_API_KEY: "sk-leaked-too",
    NODE_OPTIONS: "--require /tmp/hook.cjs",
    ELECTRON_RUN_AS_NODE: "1",
    CODEBUDDY_GATEWAY_PASSWORD: "host-secret",
    WORKBUDDY_PAC_RPC_TOKEN: "host-secret",
  };
}

describe("buildWorkerEnv：按需透传 mcp.json 点名的变量", () => {
  test("extra 里的键被放行——白名单之外也能拿到（MCP 的 ${VAR} 靠这条）", () => {
    const env = buildWorkerEnv({ ...hostEnv(), GITHUB_TOKEN: "gh-token" }, {}, ["GITHUB_TOKEN"]);
    assert.equal(env.GITHUB_TOKEN, "gh-token");
  });

  test("FORBIDDEN 优先：即便配置点名，也不把模型密钥送进 worker", () => {
    const env = buildWorkerEnv({ ...hostEnv(), DEEPSEEK_API_KEY: "sk" }, {}, [
      "DEEPSEEK_API_KEY",
    ]);
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
  });

  test("点名的键在宿主机不存在时不写 undefined（写进去会被展开成字符串）", () => {
    const env = buildWorkerEnv(hostEnv(), {}, ["MISSING_VAR"]);
    assert.equal("MISSING_VAR" in env, false);
  });
});

describe("buildWorkerEnv：只放行白名单", () => {
  test("输出的键全在白名单或控制变量里（不是「删掉密钥」那种黑名单手法）", () => {
    const allowed = new Set<string>([...WORKER_ENV_PASSTHROUGH, ...WORKER_ENV_CONTROL]);
    const out = buildWorkerEnv(hostEnv(), { COLT_MCP_HOME: "/tmp/home" });
    const extra = Object.keys(out).filter((key) => !allowed.has(key));
    assert.deepEqual(extra, [], `这些键不该进 worker 环境：${extra.join(", ")}`);
  });

  test("密钥名一个都不混进来（连键名都没有）", () => {
    const out = buildWorkerEnv(hostEnv());
    for (const name of FORBIDDEN_WORKER_ENV) {
      assert.equal(name in out, false, `${name} 出现在 worker 环境里了`);
    }
  });

  test("宿主私有变量与能注入代码的开关同样不混进来", () => {
    const out = buildWorkerEnv(hostEnv());
    for (const name of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "CODEBUDDY_GATEWAY_PASSWORD"]) {
      assert.equal(name in out, false, `${name} 不该透传给 worker`);
    }
  });

  test("宿主上缺的键不产生 undefined 值（写进去会被展开成字符串 \"undefined\"）", () => {
    const out = buildWorkerEnv({ PATH: "C:\\bin" });
    assert.deepEqual(out, { PATH: "C:\\bin" });
    for (const value of Object.values(out)) {
      assert.equal(typeof value, "string");
    }
  });

  test("空串按「没有这个变量」处理（不要给下游一个空的 PATH）", () => {
    const out = buildWorkerEnv({ PATH: "", LANG: "zh_CN.UTF-8" });
    assert.deepEqual(Object.keys(out), ["LANG"]);
  });

  test("控制变量原样进入 worker 环境（数值只认控制变量那一份，不看宿主同名键）", () => {
    const out = buildWorkerEnv({ ...hostEnv(), COLT_MCP_HOME: "C:\\from-host" }, {
      COLT_MCP_HOME: "/from/control",
      COLT_BUILTIN_SKILLS_DIR: "/builtin",
    });
    assert.equal(out.COLT_MCP_HOME, "/from/control");
    assert.equal(out.COLT_BUILTIN_SKILLS_DIR, "/builtin");
  });

  test("控制变量里塞密钥名 → 直接抛错（不静默丢弃）", () => {
    for (const name of FORBIDDEN_WORKER_ENV) {
      assert.throws(
        () => buildWorkerEnv(hostEnv(), { [name]: "sk-leaked" }),
        /拒绝把密钥写进 worker 环境/,
        `${name} 走控制变量通道也必须被拦下`,
      );
    }
    // 大小写不作为逃生口：Windows 的环境名本来就不区分大小写
    assert.throws(
      () => buildWorkerEnv(hostEnv(), { colt_provider_key: "sk-leaked" }),
      /拒绝把密钥写进 worker 环境/,
    );
  });
});

describe("collectWorkerControl：Colt 自己的非密钥控制变量", () => {
  test("三个都取到，且不夹带别的东西", () => {
    const control = collectWorkerControl({
      ...hostEnv(),
      COLT_APPROVAL_DEBUG: "1",
      COLT_BUILTIN_SKILLS_DIR: "E:\\builtin",
      COLT_MCP_HOME: "E:\\home",
    });
    assert.deepEqual(Object.keys(control).sort(), [...WORKER_ENV_CONTROL].sort());
    assert.equal(control.COLT_MCP_HOME, "E:\\home");
  });

  test("缺的 / 空的都不产生键（否则会覆盖掉 worker 侧正确的默认值）", () => {
    assert.deepEqual(collectWorkerControl({ COLT_MCP_HOME: "" }), {});
    assert.deepEqual(collectWorkerControl({}), {});
  });
});
