/**
 * 密钥存储：safeStorage 加密后落盘，明文只在内存与 worker 进程环境变量中存在
 * 绝不写入日志、不入数据库、不跨 IPC 明文传给渲染层
 */
import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
  } catch {
    return {};
  }
}

function writeStore(store: SecretStoreFile): void {
  writeFileSync(secretsPath(), JSON.stringify(store, null, 2), "utf8");
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
  } catch {
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

/** 掩码展示，如 sk-8d***f2a */
export function maskSecret(key: SecretKey): string | undefined {
  const value = getSecret(key);
  if (!value) return undefined;
  if (value.length <= 10) return "*".repeat(value.length);
  return `${value.slice(0, 5)}***${value.slice(-3)}`;
}
