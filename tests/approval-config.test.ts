/**
 * 审批命令白名单的**读侧**契约。
 *
 * 这一层最容易出的错是把两件语义相反的事混成一件——它们在库里都表现为
 * 「读出来的东西不是一份正常列表」：
 *   - **显式清空**：用户就是要关掉自动放行 → 必须返回空表；
 *   - **存量脏数据**：一条坏记录不该悄悄改掉用户的能力 → 退回内置默认。
 * 做成同一种处理，要么用户的关闭动作被无声撤销（自动放行又开了），
 * 要么一条坏记录让「用户以为开着」的功能其实关着。故逐条钉住。
 *
 * 脏数据的那几条尤其值得钉：`getSetting` 读的是 settings 表里的**裸字符串**，
 * 手改库、旧版本残留都可能塞进任何东西，而这条链路的失败方式是**静默**的。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { closeDatabase, openDatabase } from "../src/main/db/index.ts";
import { setSetting } from "../src/main/db/repo.ts";
import {
  getAnalyzeCommandAllowlist,
  setAnalyzeCommandAllowlist,
} from "../src/main/approval/config.ts";
import { DEFAULT_ANALYZE_COMMAND_ALLOWLIST } from "../src/main/approval/policy.ts";

const KEY = "approval.analyzeCommandAllowlist";
const DEFAULT = [...DEFAULT_ANALYZE_COMMAND_ALLOWLIST];

let root = "";

beforeEach(() => {
  closeDatabase();
  root = makeTempDir("colt-approval-cfg-");
  openDatabase(root);
});

afterEach(() => {
  closeDatabase();
  removeTempDir(root);
});

describe("getAnalyzeCommandAllowlist", () => {
  test("从未配置 → 用内置默认", () => {
    assert.deepEqual(getAnalyzeCommandAllowlist(), DEFAULT);
  });

  test("显式存过空数组 → 返回空表（这是「关掉自动放行」，不是「没配过」）", () => {
    setAnalyzeCommandAllowlist([]);
    assert.deepEqual(getAnalyzeCommandAllowlist(), []);
  });

  test("存的是非空列表 → 原样读回", () => {
    setAnalyzeCommandAllowlist(["npm", "git"]);
    assert.deepEqual(getAnalyzeCommandAllowlist(), ["npm", "git"]);
  });

  test("脏数据：根本不是 JSON → 退回内置默认", () => {
    setSetting(KEY, "{这不是 JSON");
    assert.deepEqual(getAnalyzeCommandAllowlist(), DEFAULT);
  });

  test("脏数据：是 JSON 但不是数组 → 也要退回内置默认", () => {
    // 这一条是重点。只 catch 语法错的话，这些值会一路走到归一化 → 空表，
    // 于是「一条坏记录」被解释成「用户关掉了自动放行」——静默、且与默认背道而驰。
    for (const dirty of [JSON.stringify({ npm: true }), "null", JSON.stringify("npm"), "42"]) {
      setSetting(KEY, dirty);
      assert.deepEqual(getAnalyzeCommandAllowlist(), DEFAULT, `脏值 ${dirty} 未被当成坏记录`);
    }
  });

  test("读取结果与内置默认不是同一个数组实例（调用方改它不该污染默认值）", () => {
    const first = getAnalyzeCommandAllowlist();
    first.push("被污染的项");
    assert.deepEqual(getAnalyzeCommandAllowlist(), DEFAULT);
  });
});

describe("setAnalyzeCommandAllowlist", () => {
  test("返回归一化后的结果，且写进去的就是归一化后的那一份", () => {
    const saved = setAnalyzeCommandAllowlist(["  NPM ", "/usr/bin/git", "npm", 7, ""]);
    assert.deepEqual(saved, ["npm", "git"]);
    assert.deepEqual(getAnalyzeCommandAllowlist(), ["npm", "git"]);
  });

  test("非数组入参归一化成空表，且读回来是空表（没有被当成脏数据退回默认）", () => {
    assert.deepEqual(setAnalyzeCommandAllowlist({ nope: 1 }), []);
    assert.deepEqual(getAnalyzeCommandAllowlist(), []);
  });
});
