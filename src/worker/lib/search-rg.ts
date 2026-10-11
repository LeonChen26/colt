// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * ripgrep 后端：`grep` 的**快路径**（`glob` 不走它，见下）。
 *
 * ## 为什么要有它、又为什么仍然留着纯 JS 实现
 *
 * 走 rg 的收益**不是**「Rust 比 JS 快」，而是它的扫描集合本来就小（守 ignore 规则），
 * 加上多线程。实测本仓过滤前后的差距（1.3s → 0.1s）里，绝大部分来自「不再扫那 9126 个
 * 本该忽略的文件」——那一半**过滤**已经做了，rg 只是在剩下的集合上更快一点。
 *
 * 所以引擎是可替换的：**有 rg 就用，没有就用纯 JS**。两条路的**结果必须一致**，
 * 这是本文件最要紧的约束（见下节）。两者都在同一套上限与同一份「如实标注」口径下收口，
 * 差异只允许出现在耗时上。
 *
 * ## 结果一致性（engine parity）——本文件最容易出错的地方
 *
 * 「同一个工具、装没装二进制会返回不同东西」是**最糟的一类不确定性**，比慢一点贵得多。
 * 下面每一条都是**实测踩出来的**（不是推演），改动任何一条前先想清楚它为什么在：
 *   ① **ignore 文件集合与优先级对齐**：两边都认 `.gitignore` < `.ignore` < `.rgignore`
 *      （rg 的原生顺序）。`search-ignore.ts` 的 `IGNORE_FILE_NAMES` 与这里一致——
 *      原先是 `.fdignore`（与内核技能装载一致），改成 `.rgignore` 是为了**引擎一致**：
 *      与「快路径」的结果对齐比与「另一个特性」的行为对齐更重要。
 *   ② **`--no-require-git`**：rg 默认只在 git 仓库里应用 `.gitignore`。Colt 会打开
 *      **没有版本控制的项目目录**，那时 rg 会去搜构建产物而 JS 不会。实测：一个只有
 *      `.gitignore`、没有 `.git` 的目录，不加它 `ignored-dir/x.ts` 会被搜出来。
 *   ③ **`SKIP_DIRS` 要翻译成 `-g '!<名字>'`**：那张硬跳过名单是 JS 独有的概念，
 *      rg 不认识它。不翻译，rg 就会去搜 `node_modules`。
 *   ④ **`-g '!.*'`**：**一旦传了任何 `-g`，rg 对白名单命中的隐藏文件就不再跳过**——
 *      实测 `-g '*.ts'` 会把 `.hidden-file.ts` 搜出来，而 JS 一律跳过点文件。
 *   ⑤ **`includeIgnored` 一律走 JS**：rg 要多传 `--no-ignore --hidden` 并显式排掉
 *      SKIP_DIRS 那一串，而那是少见的逃生口（模型主动要求连构建产物一起搜）。
 *      用一条路径换掉一整类不一致风险，划算。
 *   ⑥ **单文件检索也走 JS**：`path` 指到具体文件时不需要遍历，JS 本来就快，
 *      而且「点名要看的文件」不该被任何过滤规则挡住。
 *   ⑦ **`cwd` 必须是项目根**：rg 的 `-g` 是相对**进程 cwd** 匹配的，而 JS 那侧一律用
 *      「相对项目根的路径」去匹配（`window.rel`）。两边能对上**只因为** `spawn` 的 `cwd`
 *      传的是 `root`——这不是巧合而是前提。改动 `runRipgrep(..., cwd)` 的入参（例如「顺手」
 *      换成搜索子目录看起来更自然）会让**所有含 `/` 的 glob** 悄悄给出不同结果：
 *      实测 `{path:"src", glob:"src/*.tsx"}` 在 `cwd=root` 下两边都命中 `src/b.tsx`，
 *      若 cwd 改成 `<root>/src` 则 rg 一条都不返回。已由 `tests/search-rg.test.ts` 的
 *      「含目录前缀的 glob」用例钉住。
 *   ⑧ **以 `!` 开头的 glob 不走这条路**（见 `runGrep` 的闸门）：我们的 glob 是「只看匹配的
 *      文件」、`!` 是字面量，而 rg 的 `-g '!x'` 是**排除**。同一个入参两种语义实测会分叉。
 *
 * ## 与 rg 的已知残余差异（写在明处，别当没有）
 *
 * - **命中数超过 `MAX_GREP_KEPT_HITS`（5000）时，截断展示的那 200 条可能不同**：两边都做了
 *   **先排序、再截断**（`capHits` 是共用实现），但 JS 那侧为了排序得先握住命中，于是它
 *   只能保留前 5000 条——超过这个量时，两边排序所用的集合就不是同一批了。
 *   **报告的总数仍然一致**（实测本仓：582/582、759/759、1121/1121），而总数才是模型
 *   据此判断「该不该缩小范围」的依据。
 *   ⚠️ 别把「排序后输出」当成两边全等——我一开始就是这么写注释的，是错的。
 * - **被忽略的条目数**：rg 不告诉调用方它忽略了多少，JS 能。故「过滤说明」两边都有，
 *   但 JS 那侧多一个数目（见 `search-tools.ts` 的 `FILTER_NOTE`）。
 * - **以 `!` 开头的 glob 根本不走这条路**（见 `runGrep` 的闸门）：我们的 glob 是「只看
 *   匹配的文件」、`!` 是字面量，而 rg 的 `-g '!x'` 是**排除**。同一个入参两种语义，
 *   实测会分叉（`glob: "!*.md"` 在 rg 上返回除 .md 外的全部命中、在内置实现上返回「没有匹配」），
 *   所以这一路宁可走慢的那条。
 * - **全局 gitignore**（`~/.config/git/ignore`、`core.excludesFile`）与 `.git/info/exclude`：
 *   rg 认，JS 那侧不认 → JS 可能**多搜**几个文件。方向是「多搜」而不是「漏搜」。
 *
 * ## 失败要**分性质**，否则一个坏正则就能让整个会话降级
 *
 * `runRipgrep` reject 的 Error 带 `kind`（`spawn` / `exit` / `timeout`），调用方据此决定
 * 要不要 latch。原先三种失败一律被当成「ripgrep 不可用」：
 *   - `spawn`（起不来）才是环境事实，该 latch；
 *   - `exit` 是**这次查询**的错——模型写 `(?=x)`（JS 正则合法、Rust 正则不支持）就触发，
 *     实测后果是**之后连搜普通词都退化到纯 JS**，而日志写着「ripgrep 不可用」——那句话是假的；
 *   - `timeout` 说明范围太大，同理只该影响这一次。
 * 别图省事把三者合并：它们的**恢复方式完全不同**（换机器 / 换正则 / 缩小范围）。
 *
 * ⚠️ 不 latch 超时是**有代价**的，写在这里免得被当成疏漏：真遇到「这台机器上 rg 就是跑不出来」
 * 的情况（比如项目放在很慢的网络盘），那每次检索都要先等满 30 秒再回落内置实现——
 * 因为从一次超时里区分不出「这次范围太大」和「这台机器一直慢」。
 * 取舍方向是**宁可有代价，也不要错误的永久降级**（永久降级正是这一轮修掉的缺陷）。
 * 若日后确认这成了常态，正解是按规模择引擎（见上一节末），而不是把 timeout 也 latch 掉。
 *
 * ## 速度：不是「装了 rg 就一定更快」（实测）
 *
 * spawn 一个进程有约 150ms 的固定成本，所以小仓库上 rg **更慢**：
 *
 * | 规模 | rg | 纯 JS |
 * |---|---|---|
 * | 本仓（过滤后 322 文件） | 197ms | **110ms** |
 * | 合成 3000 文件 | **810ms** | 1431ms |
 *
 * 交叉点在 1000～1500 个文件之间；再大就是 rg 的天下了（它是并行 + 原生代码）。
 * 也就是说：**为了大仓库才带它，小仓库是被它拖慢的**。要不要按规模择引擎是个明确的
 * 取舍（需要记住上一次遍历的规模，或者开局数一次文件），当前**不做**——先把这个
 * 事实记在这里，别让下一个人以为「装了 rg 因此一切都更快」。
 */
import { spawn } from "node:child_process";
import { SKIP_DIRS } from "./search-ignore";

/** rg 输出里我们只关心 `match` 这一类事件 */
interface RgMatchLine {
  type?: unknown;
  data?: {
    path?: { text?: unknown };
    lines?: { text?: unknown };
    line_number?: unknown;
  };
}

/** 解析后的一条命中（`path` 仍是 rg 给的原样路径，调用方负责相对化） */
export interface RgMatch {
  path: string;
  lineNumber: number;
  text: string;
}

/**
 * 拼 rg 的参数。
 *
 * ⚠️ 四条不能省的：
 *   - `-e <pattern>`：不加它，**以 `-` 开头的模式会被当成选项**（模型写 `-foo` 就废了）；
 *   - `--json`：要结构化输出，别去解析人类可读格式；
 *   - `--no-messages`：文件权限之类的噪声走 stderr，不该混进结果；
 *   - `--no-require-git`：**没有它，rg 在非 git 目录里根本不认 `.gitignore`**
 *     （rg 默认 `--require-git`：要看到 `.git/` 才应用 VCS 忽略规则）。而 Colt 会打开
 *     **没有版本控制的项目目录**，那时两边引擎会分叉——rg 去搜构建产物、JS 不去。
 *     实测（14.1.1，一个只有 `.gitignore` 没有 `.git` 的目录）：不加它，
 *     `ignored-dir/x.ts` 会被搜出来；加上就干净了。
 * 末尾的 `--` 把后面的路径与选项隔开（路径是绝对路径，理论上不会以 `-` 开头，但这是廉价的保险）。
 */
export function buildRgArgs(input: {
  pattern: string;
  absolutePath: string;
  glob?: string | undefined;
  ignoreCase?: boolean | undefined;
}): string[] {
  const args = [
    "--json",
    "--no-messages",
    "--line-number",
    "--no-require-git",
    "-e",
    input.pattern,
  ];
  if (input.ignoreCase === true) args.push("-i");
  if (input.glob !== undefined && input.glob.trim() !== "") {
    // rg 的 -g 语义与我们的 glob 一致 **有个前提**：它是相对进程 cwd 匹配的，而我们的 glob
    // 相对**项目根**匹配。所以 `runRipgrep` 的 cwd 必须传项目根——见文件头 ⑦。
    args.push("-g", input.glob.trim());
  }
  // SKIP_DIRS 是 JS 那侧的**硬跳过**名单，rg 不认识它，必须显式翻译成排除 glob——
  // 少了这一步，rg 会去搜 node_modules（JS 会跳过）→ 两个引擎给出不同结果。
  for (const name of SKIP_DIRS) args.push("-g", `!${name}`);
  // ⚠️ `-g '!.*'` 也不是可选的：**传了任何 `-g` 之后，rg 的「跳过隐藏文件」就不再对
  // 白名单里的文件生效**——实测 `-g '*.ts'` 会把 `.hidden-file.ts` 搜出来，
  // 而 JS 那侧一律跳过点文件。所以要把「跳过点文件」显式写成一条排除规则。
  args.push("-g", "!.*");
  args.push("--", input.absolutePath);
  return args;
}

/** rg 的单行 JSON → 命中；不是 match 事件 / 形状不对时返回 undefined（跳过，不报错） */
export function parseRgJsonLine(line: string): RgMatch | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: RgMatchLine;
  try {
    parsed = JSON.parse(trimmed) as RgMatchLine;
  } catch {
    // rg 的 stdout 只该是 JSON 行；混进别的就跳过这一行，不打断整次检索
    return undefined;
  }
  if (parsed.type !== "match") return undefined;
  const path = parsed.data?.path?.text;
  const rawText = parsed.data?.lines?.text;
  const lineNumber = parsed.data?.line_number;
  if (typeof path !== "string" || typeof rawText !== "string" || typeof lineNumber !== "number") {
    return undefined;
  }
  // rg 把整行**带换行**给我（行尾可能是 \n 或 \r\n），去掉它们才是「那一行的内容」——
  // 留下来会让输出多出空行，并且与 JS 那侧（按 /\r?\n/ 切行）不一致。
  const text = rawText.replace(/\r?\n$/, "");
  return { path, lineNumber, text };
}

/** 整体解析（便于单测：一次给多行文本） */
export function parseRgJson(stdout: string): RgMatch[] {
  const out: RgMatch[] = [];
  for (const line of stdout.split("\n")) {
    const match = parseRgJsonLine(line);
    if (match !== undefined) out.push(match);
  }
  return out;
}

/**
 * rg 的 stdout 上限。超了就**提前收工**并把总数降级成下限。
 *
 * 为什么需要：为了在截断时说清「共 N 条」，得把 rg 的输出读完；而一次 `.*` 之类
 * 的宽泛搜索能吐出几十万条匹配（实测 Codex 那侧有过 254k token 的原始返回）。
 * 那是**没有上界**的读入，与「整个目录树都扫完」是同一类错误，故同样封顶。
 * 8MB 足够装下 200 条展示结果 + 相当多的计数，代价可控。
 */
export const MAX_RG_STDOUT_BYTES = 8 * 1024 * 1024;

/** 留多少 stderr 作诊断（够装下 rg 的一行报错，例如「look-around is not supported」） */
const STDERR_KEEP_BYTES = 4 * 1024;

/**
 * 跑 rg 的墙钟上限。
 *
 * 为什么必须有：纯 JS 那侧有 `MAX_SCANNED_FILES` 兜底，**rg 这侧原本一点上界都没有**——
 * 卡在慢盘 / 网络盘上的一次检索能挂到天荒地老，而工具**没有取消信号**，lane 只能干等
 * （那是本仓的已知缺口，不该再由一个外部进程放大一次）。
 * 超时后杀掉并**回落 JS**：那条路有扫描上限，一定能终止，并给出「结果不完整」的诚实答案。
 * 30 秒对正常仓库极度宽松（本仓 0.2 秒），真撞上只说明范围太大。
 */
export const DEFAULT_RG_TIMEOUT_MS = 30_000;

/**
 * rg 调用**失败的原因**。
 *
 * 三种的处理方式完全不同，**混成一种会让一个坏正则永久关掉整个会话的快路径**（实测踩到）：
 *   - `spawn`：二进制起不来（缺失 / 没执行权限 / 平台不对）→ 这台机器上就是没有它，
 *     该 **latch** 住不再重试；
 *   - `exit`：rg 起来了但拒绝了这个查询（退出码 2，典型是模型写了 lookahead / 反向引用
 *     ——JS 正则合法、Rust 正则不支持）→ 只该影响**这一次**；
 *   - `timeout`：跑太久被我们杀掉（范围太大）→ 同样只影响这一次，且**不 latch**。
 */
export type RgFailureKind = "spawn" | "exit" | "timeout";

/** 失败原因作为**普通属性**挂在 Error 上，而不是靠 `instanceof` 认类型——理由见 `rgFailureKind` */
export interface RgFailure {
  kind: RgFailureKind;
}

/**
 * 从错误里读出失败原因；不是我们抛的就返回 `undefined`。
 *
 * ⚠️ 刻意**不用 `instanceof`**：本仓出过「同一个模块被卷进两次模块图」的事故
 * （见 `AGENTS.md` §五的盘符大小写一节）。那种情况下 `instanceof` 会静默失效——
 * 错误对象来自另一个实例，判断为假，于是 `exit` 被当成 `spawn` 处理，
 * 又回到「一个坏正则关掉整个会话」。结构判别不受影响。
 */
export function rgFailureKind(error: unknown): RgFailureKind | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return kind === "spawn" || kind === "exit" || kind === "timeout" ? kind : undefined;
}

function failRg(kind: RgFailureKind, message: string): Error & RgFailure {
  const error = new Error(message) as Error & RgFailure;
  error.kind = kind;
  return error;
}

/** 把 stderr 压成一行附到消息里（rg 的报错就在那儿，且常跨行——别只取第一行丢掉原因） */
function stderrDetail(stderr: string): string {
  const collapsed = stderr.replace(/\s+/g, " ").trim();
  return collapsed === "" ? "" : `：${collapsed.slice(0, 200)}`;
}

export interface RgRunResult {
  matches: RgMatch[];
  /** stdout 撞到上限：命中总数**只是下限**，调用方必须据此改变措辞 */
  truncatedByBytes: boolean;
  /** 进程退出码；null 表示被我们提前杀掉 */
  code: number | null;
}

/**
 * 跑一次 rg，读 stdout 到上限为止。
 *
 * 失败时 reject 的是**带 `kind` 的 Error**（见 `RgFailureKind`）：调用方要据此决定
 * 「这台机器上没有它（latch 掉）」还是「这次查询它不干（只回落这一次）」。
 *
 * ⚠️ `stdio` 的 stdin **必须是 `"ignore"`**。踩过三次的坑：给子进程一个管道 stdin 时，
 * rg / tar 这类程序会「检测到 stdin 可读 → 去读它 → 等一个永远不来的输入」，
 * 表现为挂死或 `spawnSync ... EBUSY`。这与「沙箱禁止 spawn」毫无关系，纯粹是 stdio 配错。
 *
 * ⚠️ `cwd` 必须是**项目根**（见文件头 ⑦：`-g` 相对 cwd 匹配）。
 *
 * 超时是真的**杀掉**子进程（`tests/search-rg.test.ts` 用「子进程在超时之后再写一个文件」验证了
 * 它没活下来），不是「我们不再听它」——否则每次超时都会漏一个孤儿进程。
 */
export function runRipgrep(
  rgPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_RG_TIMEOUT_MS,
): Promise<RgRunResult> {
  return new Promise<RgRunResult>((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncatedByBytes = false;
    let settled = false;
    let stderrText = "";

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(chunks).toString("utf8");
      resolve({ matches: parseRgJson(stdout), truncatedByBytes, code });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 杀掉它再 reject：不杀的话进程继续跑，我们这边已经放弃了，等于漏了一个子进程
      child.kill();
      reject(
        failRg("timeout", `ripgrep 超过 ${Math.round(timeoutMs / 1000)} 秒未返回，已终止`),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncatedByBytes) return;
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (bytes >= MAX_RG_STDOUT_BYTES) {
        truncatedByBytes = true;
        // 到了上限就**不再读**（并杀掉进程）：继续读下去正是要避免的无界行为
        child.stdout.removeAllListeners("data");
        child.kill();
      }
    });

    // stderr **必须读**（哪怕只是收着）：不读它，管道写满后子进程会阻塞在写 stderr 上，
    // 而我们等它的 close —— 双向死等到超时。顺带把内容留作诊断，rg 的正则报错就在这里。
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrText.length < STDERR_KEEP_BYTES) {
        stderrText += chunk.toString("utf8").slice(0, STDERR_KEEP_BYTES - stderrText.length);
      }
    });

    // 起不来（缺失 / 没权限）是**环境事实**，与「这次查询不被接受」是两回事，故分 kind
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(failRg("spawn", `ripgrep 启动失败：${error.message}`));
    });
    // rg 没有匹配时退出码是 1，那是**正常结果**不是错误；2 才是真出错（如正则不被接受）
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      // ⚠️ 这里**不能**先置 settled 再调 finish——finish 开头就是 `if (settled) return`，
      // 那样 Promise 永远不会 settle，整条检索静默挂死（我第一版就是这么写的）。
      if (code !== null && code > 1) {
        settled = true;
        reject(failRg("exit", `ripgrep 退出码 ${code}${stderrDetail(stderrText)}`));
        return;
      }
      finish(code);
    });
  });
}
