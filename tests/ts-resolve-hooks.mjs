/**
 * 测试用的模块解析补全。
 * 由 tests/ts-resolve.mjs 注册。
 *
 * 两类补全：
 *   1. 无扩展名的相对 import（源码走 bundler 风格省略扩展名）；
 *   2. tsconfig paths 里的别名（@shared/*、@/*）——类型专用 import 会被类型擦除、
 *      从不触发本钩子，所以别名过去一直是盲区；一旦被测模块出现「值」导入别名
 *      （如 policy.ts → @shared/readonly-tools），就必须在这里解析。
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/** 仓库根目录（tests/ 的上一级） */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 与 tsconfig 的 paths 对齐 */
const ALIASES = [
  ["@shared/", "src/shared/"],
  ["@/", "src/renderer/src/"],
];

/** 补全扩展名 / index 文件；找不到返回 undefined */
function resolveFile(basePath) {
  if (/\.[mc]?[jt]sx?$/.test(basePath) && existsSync(basePath)) return basePath;
  for (const suffix of CANDIDATES) {
    if (existsSync(basePath + suffix)) return basePath + suffix;
  }
  return undefined;
}

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.[mc]?[jt]sx?$/.test(specifier);

  if (isRelative && !hasExtension && context.parentURL) {
    for (const suffix of CANDIDATES) {
      const candidate = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
  }

  for (const [prefix, target] of ALIASES) {
    if (!specifier.startsWith(prefix)) continue;
    const resolved = resolveFile(resolvePath(ROOT, target + specifier.slice(prefix.length)));
    if (resolved) return nextResolve(pathToFileURL(resolved).href, context);
  }

  return nextResolve(specifier, context);
}
