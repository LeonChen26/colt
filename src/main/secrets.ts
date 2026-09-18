// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 密钥存储：safeStorage 加密后落盘，明文只在内存与 worker 进程环境变量中存在
 * 绝不写入日志、不入数据库、不跨 IPC 明文传给渲染层
 */
import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 密钥键：内置 provider 用固定名，自定义 provider 用其 id */
type SecretKey = string;

interface SecretStoreFile {
  /** base64(encrypted) */
  [key: string]: string;
}

function secretsPath(): string {
  const dir = join(app.getPath("userData"), "data");
  mkdirSync(dir, { recursive: true });
  return join(dir, "secrets.json");
}

function readStore(): SecretStoreFile {
  const file = secretsPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SecretStoreFile;
  } catch (error) {
    // 读不出来等于「所有密钥都没配」，用户只会看到「未配置」而看不到原因。
    // 按项目最高原则（失败必须可见），这里必须留痕，不能静默返回空。
    console.error("[secrets] 密钥文件解析失败，已按「未配置」处理", file, error);
    return {};
  }
}

/**
 * 原子写：先写临时文件再改名覆盖。
 * 密钥文件是单点存储，一次写盘崩溃（断电 / 磁盘满 / 被杀进程）会毁掉**全部**密钥；
 * 直接 writeFileSync 到目标路径时，崩溃会留下半截 JSON，进而被 readStore 静默吞成空对象。
 */
function writeStore(store: SecretStoreFile): void {
  const file = secretsPath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** 写入密钥（加密） */
export function setSecret(key: SecretKey, value: string): void {
  const store = readStore();
  if (!value) {
    delete store[key];
  } else if (safeStorage.isEncryptionAvailable()) {
    store[key] = safeStorage.encryptString(value).toString("base64");
  } else {
    // 系统未提供加密能力时拒绝明文落盘，避免给出虚假的安全承诺
    throw new Error("系统加密不可用，拒绝以明文保存密钥。");
  }
  writeStore(store);
}

/** 读取密钥明文，仅供主进程内部与 worker 启动时使用 */
export function getSecret(key: SecretKey): string | undefined {
  const store = readStore();
  const encoded = store[key];
  if (!encoded) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch (error) {
    // 解密失败通常是凭据环境变了（换账户 / 迁移 userData），不是文件坏。
    // 返回值只能是 undefined（不能抛，UI 要用它判断「是否已配置」），但必须留痕，
    // 否则用户看到「未配置」时无从区分「没配过」和「配过但解不开」。
    console.error("[secrets] 密钥解密失败，已按「未配置」处理", key, error);
    return undefined;
  }
}

/** 是否已配置，供 UI 展示（不返回明文） */
export function hasSecret(key: SecretKey): boolean {
  // 以「真的能解密出明文」为准，而不是「密文存在」：系统凭据环境变更后
  // （重装 / 换账户 / 迁移 userData）密文还在但解密必失败，若仍显示「已配置」，
  // 用户打开会话时才会撞上「尚未配置 API Key」，前一步的提示就成了谎言。
  return Boolean(getSecret(key));
}

/** 删除密钥 */
export function deleteSecret(key: SecretKey): void {
  const store = readStore();
  delete store[key];
  writeStore(store);
}
