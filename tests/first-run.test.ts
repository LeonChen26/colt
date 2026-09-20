/**
 * 首启检测测试：验证历史数据识别与清空逻辑。
 * 使用临时目录模拟 userData，不依赖 Electron。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { applyFirstRunChoice, inspectUserData } from "../src/main/first-run.ts";

let root: string;

beforeEach(() => {
  root = makeTempDir("colt-firstrun-");
});

afterEach(() => {
  removeTempDir(root);
});

/** 造一个含项目/会话记录的历史库 */
function seedDatabase(userDataPath: string): void {
  mkdirSync(join(userDataPath, "data"), { recursive: true });
  const db = new DatabaseSync(join(userDataPath, "data", "colt.db"));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, created_at INTEGER, last_opened_at INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, title TEXT);
  `);
  db.prepare("INSERT INTO projects VALUES ('p1','demo','/tmp/demo',0,0)").run();
  db.prepare("INSERT INTO sessions VALUES ('s1','p1','hi')").run();
  db.prepare("INSERT INTO sessions VALUES ('s2','p1','yo')").run();
  db.close();
}

describe("inspectUserData", () => {
  test("全新目录：无历史数据且未完成引导", () => {
    const report = inspectUserData(join(root, "fresh"));
    assert.equal(report.hasHistoricalData, false);
    assert.equal(report.hasDatabase, false);
    assert.equal(report.projectCount, 0);
    assert.equal(report.sessionCount, 0);
    assert.equal(report.onboardingDone, false);
  });

  test("存在历史库：统计出项目与会话数量", () => {
    seedDatabase(root);
    const report = inspectUserData(root);
    assert.equal(report.hasHistoricalData, true);
    assert.equal(report.hasDatabase, true);
    assert.equal(report.projectCount, 1);
    assert.equal(report.sessionCount, 2);
  });

  test("仅有密钥文件也算历史数据", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "secrets.json"), "{}", "utf8");
    const report = inspectUserData(root);
    assert.equal(report.hasHistoricalData, true);
    assert.equal(report.hasSecret, true);
  });

  test("存在引导标志时 onboardingDone 为真", () => {
    applyFirstRunChoice(root, "import");
    assert.equal(inspectUserData(root).onboardingDone, true);
  });
});

describe("applyFirstRunChoice", () => {
  test("import：保留历史数据，仅打标志", () => {
    seedDatabase(root);
    const result = applyFirstRunChoice(root, "import");
    assert.equal(result.cleared, false);
    // 数据仍在
    assert.equal(existsSync(join(root, "data", "colt.db")), true);
    assert.equal(inspectUserData(root).projectCount, 1);
    assert.equal(inspectUserData(root).onboardingDone, true);
  });

  test("fresh：清空数据目录并保留引导标志", () => {
    seedDatabase(root);
    const result = applyFirstRunChoice(root, "fresh");
    assert.equal(result.cleared, true);
    const report = inspectUserData(root);
    assert.equal(report.hasHistoricalData, false);
    assert.equal(report.hasDatabase, false);
    assert.equal(report.projectCount, 0);
    assert.equal(report.onboardingDone, true);
  });

  test("fresh：清理根目录残留但保留标志文件", () => {
    seedDatabase(root);
    writeFileSync(join(root, "stray.txt"), "x", "utf8");
    applyFirstRunChoice(root, "fresh");
    assert.equal(existsSync(join(root, "stray.txt")), false);
    assert.equal(existsSync(join(root, ".onboarded")), true);
  });
});
