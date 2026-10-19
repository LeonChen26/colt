// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 遍历用的 **gitignore 感知过滤器**。
 *
 * ## 为什么要它
 *
 * 原先的遍历只按一张**写死的目录名**（`.git` / `node_modules` / `out` / `dist` / `.next`）跳过。
 * 后果实测（本仓）：`release/`（1670MB）与 `release-v171/`（698MB）**都在 `.gitignore` 里**，
 * 却不在那张写死名单里 → 全仓检索要扫 9126 个文件、1.3 秒，而 git 真正跟踪的只有 **322 个**。
 * 更要紧的是**正确性**：模型会搜到构建产物、日志、本地密钥文件（`.env` 之类），
 * 拿它们当「项目里的代码」来推理——这不是慢的问题，是答错的问题。
 *
 * ## 为什么用 `ignore` 而不是自己解析
 *
 * gitignore 的语法比看上去复杂（`!` 反选、`**`、前导 `/` 锚定、目录专用尾斜杠、转义），
 * 手写解析出来的「差不多」版本会在边角上静默给出相反的结论。`ignore` 是专门做这件事的库、
 * 零传递依赖（120KB），而且——**技能装载器自己就在用它**（`worker/lib/skills-loader.ts`
 * 遍历技能目录时读 `.gitignore`/`.ignore`/`.fdignore`）。用同一个库、同一套语义，
 * 才不会有「技能装载看不见某个文件、检索却看得见」这种自相矛盾。
 *
 * ## 实现照抄内核的装配方式
 *
 * 内核（旧 `pi-agent-core` 的 `harness/skills.js`）的做法是：**一个** `ignore()` 实例，逐层把该目录的 ignore 规则**加上该目录的路径前缀**
 * 再 `add()` 进去，最后拿「相对项目根的路径」去问。`prefixIgnorePattern` 就是它的
 * 逐行处理（注释/空行丢弃、`!` 与 `\!` 区分、前导 `/` 去掉、再加前缀）。
 *
 * ⚠️ 已知局限（与内核同款）：单实例 + 前缀意味着**子目录里的反选规则会影响全树**
 * （ripgrep 用每层独立 matcher 避免这一点）。这个差异只在「父目录忽略、子目录反选」的
 * 交叉场景下可见，罕见且方向是「多搜了而不是少搜了」——比漏搜安全，故接受。
 *
 * ⚠️ **点文件不在这里管**：rg 默认跳过名字以 `.` 开头的文件与目录，而 JS 那侧要在遍历里
 * 同样跳过（见 `search-tools.ts` 的 `walkFiles`）。两处必须一起改，否则引擎之间会分叉。
 */
import ignore from "ignore";

/**
 * 认哪几个 ignore 文件名，**顺序即优先级**（后 `add()` 的覆盖先 `add()` 的）。
 *
 * ⚠️ 与内核 `harness/skills.js` 的 `IGNORE_FILE_NAMES`（`.gitignore`/`.ignore`/`.fdignore`）
 * **有意不同**：这里是 `.rgignore` 而不是 `.fdignore`，为的是与 **ripgrep 的原生集合和优先级
 * 逐字一致**（rg 是 `.rgignore` > `.ignore` > `.gitignore`）。
 *
 * 为什么这个一致性比「和内核一样」更重要：`grep` 有**两个引擎**（rg 快路径 / 纯 JS 回落），
 * 引擎不同而结果不同是**最糟的一类不确定性**（同一台机器装了 rg 就搜得到、没装就搜不到）。
 * 内核的技能装载读不读 `.fdignore` 与检索结果无关；引擎之间必须一致。
 * `.fdignore` 是 fd 的配置，实际项目里极少见；真要用也可以在 `.ignore` 里写同样的规则。
 */
export const IGNORE_FILE_NAMES: readonly string[] = [".gitignore", ".ignore", ".rgignore"];

/**
 * **永远**跳过的目录名——与 ignore 文件**两回事**，两条都生效。
 *
 * 留这一张名单的理由不是省时间（`.gitignore` 已经覆盖了 `node_modules/`、`out/` 这类），
 * 而是两类它管不到的情况：
 *   ① `.git` —— 它**几乎不会**出现在 `.gitignore` 里（那是在自己忽略自己），但没有它
 *      遍历会进对象库，既慢又全是不该给模型看的二进制；
 *   ② `includeIgnored: true`（模型明确要求连被忽略的也搜）时，ignore 这层被关掉了，
 *      而 `.git` 与依赖目录仍然不该被翻——那是一次「搜到几十万个文件」的必然后果。
 *
 * ⚠️ 放在这里而不是 `search-tools.ts`：**两个引擎都要用**它——JS 那侧在遍历里判，
 *   rg 那侧要把它翻译成 `-g '!<名字>'`（rg 不认识这张表，不传就会去搜 `node_modules`，
 *   而 JS 会跳过 → 引擎分叉。实测踩到过）。放在共用的模块里，加一个名字两边一起生效。
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", "out", "dist", ".next"]);

/** 一条规则的行处理：与内核 `prefixIgnorePattern` 同语义（见文件头） */
function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  // 注释：整行 `#` 开头丢掉；`\#` 是「字面量 #」的转义，要留着
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix === "" ? pattern : `${prefix}${pattern}`;
  return negated ? `!${prefixed}` : prefixed;
}

/** 过滤器现状：装进来的规则数与读过的 ignore 文件数（如实报给模型用） */
export interface IgnoreStats {
  files: number;
  patterns: number;
}

/**
 * 逐层累积的 ignore 过滤器。
 *
 * 它不是「一次性扫完所有 ignore 文件」——那要求先把整棵树走一遍，等于把省下的 I/O 又花回去。
 * 正确形态是**边走边装**：每进一个目录，读它自己的 ignore 文件并 `add()` 进同一个实例，
 * 于是任何文件被判定时，其祖先链上的规则都已经在里面了。
 */
export class IgnoreFilter {
  readonly #matcher = ignore();
  #files = 0;
  #patterns = 0;

  /** 该目录下的 ignore 文件内容装进来（不存在就是常态，不算错） */
  async loadDirectory(absDir: string, relDir: string, readFile: (path: string) => Promise<string>): Promise<void> {
    const prefix = relDir === "" ? "" : `${relDir}/`;
    for (const filename of IGNORE_FILE_NAMES) {
      let content: string;
      try {
        content = await readFile(`${absDir}/${filename}`);
      } catch {
        continue;
      }
      const patterns = content
        .split(/\r?\n/)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => line !== null);
      if (patterns.length > 0) {
        this.#matcher.add(patterns);
        this.#files += 1;
        this.#patterns += patterns.length;
      }
    }
  }

  /**
   * 这个**文件**是否被忽略。
   *
   * 反选（`!`）的语义让「问一次」就够：`ignore` 库内部按规则顺序取最后一条匹配，
   * 所以不需要我们自己先判目录再判文件。
   */
  ignoresFile(rel: string): boolean {
    return rel !== "" && this.#matcher.ignores(rel);
  }

  /**
   * 这个**目录**是否被忽略——要带上尾斜杠问。
   *
   * gitignore 里 `build/` 这种**尾斜杠规则只匹配目录**；不带尾斜杠去问 `build`，
   * 它会去按「文件 build」匹配，结果是不匹配 → 目录被照常下沉
   * （整个过滤等于没生效，而且静默）。
   */
  ignoresDir(rel: string): boolean {
    return rel !== "" && this.#matcher.ignores(`${rel}/`);
  }

  stats(): IgnoreStats {
    return { files: this.#files, patterns: this.#patterns };
  }
}
