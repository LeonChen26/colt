/**
 * 电脑控制（实验能力）开关的读侧契约。
 *
 * 它是**默认关**的：没配过、坏记录、显式关闭，三种情况都必须读成 false——
 * 这条链路的失败方式是静默的（工具照常注册，模型照常能点桌面），
 * 所以「默认值」本身就是安全边界，逐条钉住。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { closeDatabase, openDatabase } from "../src/main/db/index.ts";
import { setSetting } from "../src/main/db/repo.ts";
import { getComputerEnabled, setComputerEnabled } from "../src/main/computer-config.ts";

const KEY = "computer.enabled";

let root = "";

beforeEach(() => {
  closeDatabase();
  root = makeTempDir("colt-computer-cfg-");
  openDatabase(root);
});

afterEach(() => {
  closeDatabase();
  removeTempDir(root);
});

describe("电脑控制开关", () => {
  test("从未配置 → 关（实验能力默认不注册）", () => {
    assert.equal(getComputerEnabled(), false);
  });

  test("显式开启后读回 true", () => {
    setComputerEnabled(true);
    assert.equal(getComputerEnabled(), true);
  });

  test("显式关闭后读回 false（与「没配过」结果相同，但语义是用户关的）", () => {
    setComputerEnabled(true);
    setComputerEnabled(false);
    assert.equal(getComputerEnabled(), false);
  });

  test("坏记录按关处理（不是按真值断言）", () => {
    setSetting(KEY, "yes");
    assert.equal(getComputerEnabled(), false);
  });
});
