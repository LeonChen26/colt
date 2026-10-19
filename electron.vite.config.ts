import { cpSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 把内置技能目录原样复制到 `out/main/builtin-skills`。
 *
 * 为什么要单独复制：内置技能是**给 worker 在运行时读的数据文件**（一份真正的 `SKILL.md`，
 * 不是被 `import` 的模块），vite 不会打包它。而复制到 `out/main/` 下之后，
 * `join(import.meta.dirname, "builtin-skills")` 在 dev 与打包后（`app.asar/out/main`）
 * 指向**同一处**——不需要按环境分支。
 *
 * 为什么选 `out/main` 而不是 `extraResources`：`electron-builder.yml` 的 `files` 里已经有
 * `out/main` 下的全部文件，复制到这里就自动进包，**不用再动打包配置**（多一条打包规则就多一处会漂的东西）。
 *
 * 代价要说清楚：它不在 vite 的 watch 图里，所以 `npm run dev` 期间改 `SKILL.md` 不会热更新，
 * 要重启 dev（技能内容本就不常改）。
 */
function builtinSkills(): Plugin {
  const from = resolve("src/worker/lib/builtin-skills");
  const to = resolve("out/main/builtin-skills");
  return {
    name: "colt-builtin-skills",
    writeBundle() {
      // 先删后拷，不做「合并式」复制：`cpSync` 只覆盖同名文件，源码里**删掉 / 改名**的技能会在
      // `out/` 里留一份旧副本，照进包里继续生效——而装载、告警、计数、冒烟全都照常绿
      // （症状同 `AGENTS.md` §四 的「删了还在」那一类）。代价是每次都重拷一遍，几十 KB。
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true });
    },
  };
}

/**
 * 把模块 id 规整成磁盘上的真实大小写（Windows）。
 *
 * 事故（2026-09-30）：同一份源码，换一个启动入口 `npm run dev` 就把 db/index.ts 打包成
 * **两个模块实例**——模块图里同时出现 `E:/code/...` 与 `e:/code/...` 两种 id（盘符大小写
 * 取决于**启动进程的 cwd 写法**：用户终端大写、agent shell 小写）。rollup 按字符串区分
 * 模块，于是 `bootApp` 里 `openDatabase` 开的是 A 实例的库、`sessionManager` 读的是 B
 * 实例的句柄，启动即抛「数据库尚未初始化」、窗口永远建不出来，冒烟卡死在 ready-to-show
 * 之前——而**换台机器 / 换个终端启动就「好了」**，极难复现。所以必须在构建层把 id 规整掉，
 * 而不是指望每个启动入口的 cwd 写法都一致。
 *
 * 做法：在 resolveId 里先走完 vite/rollup 自己的解析链（`skipSelf` 防递归），再用
 * `realpathSync.native` 取磁盘真实大小写（它对大小写不敏感的输入返回规范形态），id 变了
 * 就以规范形态返回。realpath 按原 id 缓存，每个模块只付一次系统调用。
 */
function normalizeModuleIds(): Plugin {
  const cache = new Map<string, string>();
  const canon = (id: string): string => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    let out: string;
    try {
      out = realpathSync.native(id).replace(/\\/g, "/");
    } catch {
      // 文件尚不存在（虚拟 / 生成中）：退化为仅统一盘符
      out = id.replace(/\\/g, "/").replace(/^([a-z]):/, (_, d: string) => d.toUpperCase() + ":");
    }
    cache.set(id, out);
    return out;
  };
  return {
    name: "colt-normalize-module-ids",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source.startsWith("\0") || source.startsWith("virtual:")) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return null;
      const id = canon(resolved.id);
      if (id === resolved.id) return null;
      return { id, meta: resolved.meta, moduleSideEffects: resolved.moduleSideEffects };
    },
  };
}

// Colt 构建配置：main / preload / renderer 三端
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), builtinSkills(), normalizeModuleIds()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          // durable 会话 worker（utilityProcess）与主进程同目录输出。
          // 只有一个内核：旧 JSONL worker 已删除，不需要保留回退入口。
          "durable-worker": resolve("src/worker/durable/entry.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(), normalizeModuleIds()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
