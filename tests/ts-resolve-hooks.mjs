/**
 * 无扩展名相对 import 的解析补全。
 * 由 tests/ts-resolve.mjs 注册。
 * 作者：陕耀云栈WorkMate
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  // 只处理相对/绝对路径；裸模块（node:、@earendil-* 等）走默认解析
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

  return nextResolve(specifier, context);
}
