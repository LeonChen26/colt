// Banyan 运行时探针：确认 Electron 内置 Node 版本与 node:sqlite 可用性
// 作者：陕耀云栈WorkMate
const { app } = require("electron");

function tryRequire(id) {
  try {
    const mod = require(id);
    return { ok: true, mod };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

app.whenReady().then(() => {
  const report = {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
  };

  const sqlite = tryRequire("node:sqlite");
  report.nodeSqliteAvailable = sqlite.ok;
  if (!sqlite.ok) {
    report.nodeSqliteError = sqlite.error;
  } else {
    try {
      const { DatabaseSync } = sqlite.mod;
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, name TEXT)");
      db.exec("INSERT INTO probe (name) VALUES ('banyan')");
      const row = db.prepare("SELECT name FROM probe WHERE id = 1").get();
      report.nodeSqliteRoundTrip = row && row.name === "banyan";
      db.close();
    } catch (error) {
      report.nodeSqliteRoundTrip = false;
      report.nodeSqliteRuntimeError = error && error.message ? error.message : String(error);
    }
  }

  // utilityProcess 是 session worker 的载体，确认存在
  const { utilityProcess } = require("electron");
  report.utilityProcessAvailable = typeof utilityProcess?.fork === "function";

  console.log("BANYAN_PROBE_BEGIN");
  console.log(JSON.stringify(report, null, 2));
  console.log("BANYAN_PROBE_END");
  app.quit();
});
