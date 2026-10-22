/**
 * 默认空间 manifest（PRD-session-workspace v0.9 FR-02）。
 *
 * 这里只测纯文件层：创建 / 标题跟随 / 删除时冻结 / 列文件的口径。IPC 那一层
 * （容器根、越界校验）由冒烟覆盖。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import {
  createManifest,
  freezeManifest,
  listArtifactFiles,
  MANIFEST_FILE,
  readManifest,
  syncManifestTitle,
  updateManifestTitle,
} from "../src/main/lib/artifact-manifest.ts";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("colt-artifacts-");
});

afterEach(() => {
  removeTempDir(dir);
});

describe("manifest 生命周期", () => {
  test("落库时创建：标题与创建时间可读回，未冻结（files 为 null）", () => {
    assert.ok(createManifest(dir, "s1", "排查登录超时", 1000));
    const manifest = readManifest(dir);
    assert.equal(manifest?.sessionId, "s1");
    assert.equal(manifest?.title, "排查登录超时");
    assert.equal(manifest?.createdAt, 1000);
    assert.equal(manifest?.deletedAt, null);
    assert.equal(manifest?.files, null, "未冻结时清单以目录内容为准，不写文件列表");
  });

  test("标题随会话更新", () => {
    createManifest(dir, "s1", "新会话", 1000);
    assert.ok(updateManifestTitle(dir, "修复侧栏排序", "s1"));
    assert.equal(readManifest(dir)?.title, "修复侧栏排序");
  });

  test("冻结后标题不再跟着变（已删除会话停在删除那一刻）", () => {
    createManifest(dir, "s1", "排查登录超时", 1000);
    assert.ok(freezeManifest(dir));
    updateManifestTitle(dir, "后来改的标题", "s1");
    assert.equal(readManifest(dir)?.title, "排查登录超时");
  });

  test("删除时冻结：补写当时的文件列表与删除时刻", () => {
    createManifest(dir, "s1", "排查登录超时", 1000);
    writeFileSync(join(dir, "a.log"), "hello");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.txt"), "world");

    assert.ok(freezeManifest(dir));
    const manifest = readManifest(dir);
    assert.deepEqual(manifest?.files?.sort(), ["a.log", "sub/b.txt"]);
    assert.notEqual(manifest?.deletedAt, null);
  });

  test("没有 manifest 的旧目录：读回 null；冻结不创建新 manifest", () => {
    assert.equal(readManifest(dir), null);
    assert.equal(freezeManifest(dir), false);
    assert.equal(readManifest(dir), null, "冻结只作用于已有 manifest，不替旧目录补一份假标题");
  });

  test("syncManifestTitle 带缓存：标题没变不重复写盘，但变了会落到盘上", () => {
    createManifest(dir, "s1", "新会话", 1000);
    syncManifestTitle(dir, "第一条消息标题", "s1");
    assert.equal(readManifest(dir)?.title, "第一条消息标题");
    // 同一标题再同步一次：内容不变（这里只验结果，缓存本身是性能手段）
    syncManifestTitle(dir, "第一条消息标题", "s1");
    assert.equal(readManifest(dir)?.title, "第一条消息标题");
    syncManifestTitle(dir, "换了个标题", "s1");
    assert.equal(readManifest(dir)?.title, "换了个标题");
  });

  test("标题跟随认归属：目录里是别的会话的 manifest 时不覆写", () => {
    // 场景：用户把默认空间的产物目录开成工作目录，新会话在这里跑——
    // 目录里的 manifest 属于原来那条会话，闯入者的标题不能覆写它
    createManifest(dir, "s-owner", "原会话标题", 1000);
    assert.equal(updateManifestTitle(dir, "闯入者的新标题", "s-intruder"), false);
    assert.equal(readManifest(dir)?.title, "原会话标题");
    // 属主自己仍然能更新
    assert.equal(updateManifestTitle(dir, "属主的新标题", "s-owner"), true);
    assert.equal(readManifest(dir)?.title, "属主的新标题");
  });

  test("闯入者的缓存不毒化属主：两条会话先后同步同一标题，属主那次必须落盘", () => {
    createManifest(dir, "s-owner", "旧标题", 1000);
    // 闯入者先推「新标题」——写不进去（归属闸），但缓存里已记下这条（会话, 目录）对
    syncManifestTitle(dir, "新标题", "s-intruder");
    assert.equal(readManifest(dir)?.title, "旧标题");
    // 属主推同一个「新标题」——必须真的写盘，不能被谁挡住
    syncManifestTitle(dir, "新标题", "s-owner");
    assert.equal(readManifest(dir)?.title, "新标题");
  });
});

describe("listArtifactFiles", () => {
  test("列目录里实际存在的文件，递归子目录，跳过 manifest 自己", () => {
    createManifest(dir, "s1", "t", 1);
    writeFileSync(join(dir, "a.ts"), "x");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.ts"), "yy");

    const files = listArtifactFiles(dir).map((file) => file.path).sort();
    assert.deepEqual(files, ["a.ts", "src/b.ts"]);
    assert.ok(
      !files.includes(MANIFEST_FILE),
      "manifest 是内部记账文件，不能出现在产物清单里",
    );
  });

  test("点开头的内部文件不进清单（.DS_Store / .vscode 与 manifest 同待遇）", () => {
    createManifest(dir, "s1", "t", 1);
    writeFileSync(join(dir, "a.ts"), "x");
    writeFileSync(join(dir, ".DS_Store"), "junk");
    mkdirSync(join(dir, ".vscode"));
    writeFileSync(join(dir, ".vscode", "settings.json"), "{}");

    const files = listArtifactFiles(dir).map((file) => file.path);
    assert.deepEqual(files, ["a.ts"], "系统噪声与内部文件不该出现在给人看的清单里");
  });

  test("目录不存在 / 不可读时返回空数组，不抛", () => {
    assert.deepEqual(listArtifactFiles(join(dir, "nope")), []);
  });

  test("到达上限就停（清单是给人看的，不做分页）", () => {
    for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.txt`), "x");
    assert.equal(listArtifactFiles(dir, 3).length, 3);
  });
});
