// Colt PTY 探针：确认 node-pty 原生模块在 Electron ABI 下能加载并真的能跑通一个终端。
// 三条判据（全过才算通，见 .trae/documents/右栏文件浏览器与终端页签.md 第 0 步）：
//   1) require 成功（报 NODE_MODULE_VERSION = ABI 不对；报「应用程序控制策略已阻止」= SAC 拦 .node）；
//   2) spawn 的 echo 输出真的回到 onData；
//   3) 进程正常退出（无残留 shell）。
// 跑法：npx electron scripts/probe-pty.cjs（注意先清掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，置空不算清）。
const { app } = require("electron");

const PKG = "@homebridge/node-pty-prebuilt-multiarch";
const MARKER = "COLT_PTY_OK";

function tryRequire(id) {
  try {
    return { ok: true, mod: require(id) };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

app.whenReady().then(() => {
  const report = {
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    modules: process.versions.modules,
  };

  const pty = tryRequire(PKG);
  report.ptyLoad = pty.ok;
  if (!pty.ok) {
    report.ptyLoadError = pty.error;
    console.log("COLT_PTY_PROBE_BEGIN");
    console.log(JSON.stringify(report, null, 2));
    console.log("COLT_PTY_PROBE_END");
    app.exit(1);
    return;
  }

  // 真 spawn 一个 shell 跑一句无副作用命令，验证 PTY 双向链路。
  const shell = process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "sh";
  const command = process.platform === "win32" ? `echo ${MARKER}` : `echo ${MARKER}`;
  try {
    const proc = pty.mod.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" },
    });
    let output = "";
    let exited = false;
    let exitCode = null;
    const timer = setTimeout(() => {
      report.timeouts = true;
      try { proc.kill(); } catch { /* 已死 */ }
    }, 15000);
    proc.onData((data) => {
      output += data;
      if (output.includes(MARKER)) {
        report.roundTrip = true;
        try { proc.kill(); } catch { /* 已死 */ }
      }
    });
    proc.onExit(({ exitCode: code }) => {
      exited = true;
      exitCode = code;
      clearTimeout(timer);
      report.exited = exited;
      report.exitCode = exitCode;
      report.outputTail = output.slice(-200);
      console.log("COLT_PTY_PROBE_BEGIN");
      console.log(JSON.stringify(report, null, 2));
      console.log("COLT_PTY_PROBE_END");
      app.exit(report.roundTrip === true ? 0 : 1);
    });
    proc.write(`${command}\r`);
  } catch (error) {
    report.spawnError = error && error.message ? error.message : String(error);
    console.log("COLT_PTY_PROBE_BEGIN");
    console.log(JSON.stringify(report, null, 2));
    console.log("COLT_PTY_PROBE_END");
    app.exit(1);
  }
});
