import { cpSync, rmSync } from "node:fs";
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

// Colt 构建配置：main / preload / renderer 三端
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), builtinSkills()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          // session worker（utilityProcess）与主进程同目录输出
          worker: resolve("src/worker/entry.ts"),
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
    plugins: [externalizeDepsPlugin()],
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
