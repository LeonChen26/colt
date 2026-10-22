// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 默认空间产物目录的 manifest（PRD-session-workspace v0.9，FR-02）。
 *
 * 一条默认空间会话 = 一个产物目录 + 目录里的一份 manifest。manifest 只回答三件事：
 * 「这个目录是谁的」「它原本叫什么、什么时候建的」「会话删了之后它碰过哪些文件」。
 *
 * **清单口径以目录内容为准**：manifest 的文件列表只在目录不可读时兜底，平时清单直接读盘。
 * 所以 `files` 只在冻结（会话被删除）时写一次，之后不再跟着目录变——它是「删除那一刻的
 * 快照」，不是索引。
 *
 * manifest 本身写在产物目录里的固定文件名下。它不参与清单，也不该被 agent 的改动记录
 * 当作用户产物。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 产物目录里的 manifest 文件名（用户可见，但不在清单里列出） */
export const MANIFEST_FILE = ".colt-manifest.json";

export interface ArtifactManifest {
  version: 1;
  /** 属主会话 id。删除会话后它仍留着——这是「这个目录属于谁」的唯一凭据 */
  sessionId: string;
  /** 展示标题。随会话标题更新；删除后冻结 */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 会话被删除的时刻；null = 仍在册。冻结后不再更新（除手动重建） */
  deletedAt: number | null;
  /** 冻结时的文件列表（相对路径）；null = 未冻结，清单以目录内容为准 */
  files: string[] | null;
}

/** 目录里的一个产物文件（清单用） */
export interface ArtifactFile {
  /** 相对产物目录的路径（子目录文件带 `a/b.ts` 这样的相对路径） */
  path: string;
  size: number;
  mtime: number;
}

/** 单个目录最多列多少个文件：清单是给人看的，到上限就停，不做分页（PRD 不承诺全量） */
const MAX_FILES = 200;

export function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILE);
}

/**
 * 读 manifest。读不到 / 解析失败 / 版本不认识都返回 null——调用方据此显示「未关联目录」，
 * 而不是把整个清单搞崩（旧版本目录本来就没有 manifest）。
 */
export function readManifest(dir: string): ArtifactManifest | null {
  try {
    const raw = readFileSync(manifestPath(dir), "utf8");
    const parsed = JSON.parse(raw) as Partial<ArtifactManifest>;
    if (parsed.version !== 1 || typeof parsed.sessionId !== "string") return null;
    return {
      version: 1,
      sessionId: parsed.sessionId,
      title: typeof parsed.title === "string" ? parsed.title : "",
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      deletedAt: typeof parsed.deletedAt === "number" ? parsed.deletedAt : null,
      files: Array.isArray(parsed.files) ? parsed.files.filter((item) => typeof item === "string") : null,
    };
  } catch {
    return null;
  }
}

/** 写 manifest。失败返回 false（FR-02：删除时写失败不阻断删除，清单退回按目录内容显示） */
export function writeManifest(dir: string, manifest: ArtifactManifest): boolean {
  try {
    writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 标题跟随会话更新（带缓存）。
 *
 * 调用点在会话视图的推送路径上，而视图每轮都会来——无条件读盘会把磁盘刷穿。这里按
 * 「目录 → 上次同步的标题」缓存一次判定：标题没变就一个 syscall 都不做。没有 manifest 的
 * 目录（工作目录里的会话）也记进缓存，免得每次都去读一个不存在的文件。
 */
const titleCache = new Map<string, string>();

export function syncManifestTitle(dir: string, title: string, sessionId: string): void {
  // 缓存按（会话, 目录）记：一个目录的 manifest 只属于一个会话，别的会话（用户把
  // 产物目录开成工作目录）推来的标题写不进去。若缓存只按目录记，闯入者那次失败
  // 的同步会把属主的缓存毒化——属主推相同标题时被缓存挡住，manifest 停在旧标题
  const key = `${sessionId}\n${dir}`;
  if (titleCache.get(key) === title) return;
  titleCache.set(key, title);
  updateManifestTitle(dir, title, sessionId);
}

/**
 * 落库时创建：写入标题与创建时间（目录已由调用方建好）
 */
export function createManifest(
  dir: string,
  sessionId: string,
  title: string,
  createdAt: number,
): boolean {
  return writeManifest(dir, {
    version: 1,
    sessionId,
    title,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    files: null,
  });
}

/**
 * 标题跟随会话更新。只改标题与 updatedAt；冻结（deletedAt 非空）后不再动——
 * 已删除会话的标题就该停在删除那一刻。`sessionId` 是归属闸：目录里那份 manifest
 * 属于别的会话（用户把产物目录开成工作目录）时，标题不是我们的，不覆写。
 */
export function updateManifestTitle(dir: string, title: string, sessionId: string): boolean {
  const current = readManifest(dir);
  if (!current || current.deletedAt !== null || current.title === title) return false;
  if (current.sessionId !== sessionId) return false;
  return writeManifest(dir, { ...current, title, updatedAt: Date.now() });
}

/**
 * 删除会话时冻结：补写当时的文件列表，并记下删除时刻。
 * 目录不可读也不抛——`files` 留空数组，清单那一侧会按「目录缺失」呈现。
 */
export function freezeManifest(dir: string): boolean {
  const current = readManifest(dir);
  if (!current) return false;
  const files = listArtifactFiles(dir).map((file) => file.path);
  return writeManifest(dir, {
    ...current,
    files,
    updatedAt: Date.now(),
    deletedAt: Date.now(),
  });
}

/**
 * 列目录里实际存在的文件（清单的唯一真源）。
 *
 * 递归一层进入子目录：agent 常用 `src/`、`docs/` 这类结构，只列顶层会让「文件明明在、
 * 清单里没有」重现。`.` 开头的内部文件（含 manifest 自己）不列。读失败返回空数组，
 * 由调用方按「目录缺失 / 不可读」呈现。
 */
export function listArtifactFiles(dir: string, max = MAX_FILES): ArtifactFile[] {
  const out: ArtifactFile[] = [];
  const walk = (base: string, prefix: string): void => {
    if (out.length >= max) return;
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= max) return;
      // `.` 开头的内部文件（含 manifest 自己）不列：manifest 是记账文件，
      // .DS_Store / Thumbs.db 这类系统噪声同理——清单给用户看的是「产出了什么」
      if (name.startsWith(".")) continue;
      const full = join(base, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full, relative);
        else out.push({ path: relative, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        // 单个文件读不到（被占用 / 权限）不该让整份清单失败：跳过它，其余照列
      }
    }
  };
  walk(dir, "");
  return out;
}
