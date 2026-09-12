/**
 * 测试用模块解析 hook。
 *
 * 源码采用 bundler 风格（相对 import 省略扩展名），而 Node 的 ESM 解析要求
 * 显式扩展名。这里为无扩展名的相对路径补 .ts / .tsx，使测试能直接 import 源码，
 * 无需改动 src 的 import 风格。
 *
 * 用法：node --import ./tests/ts-resolve.mjs --test
 * 作者：陕耀云栈WorkMate
 */
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
