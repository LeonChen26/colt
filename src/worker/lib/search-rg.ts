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
 *
 * ## 与 rg 的已知残余差异（写在明处，别当没有）
 *
 * - **截断时展示的是哪 200 条**：两边都会截到 `MAX_GREP_MATCHES`，且**报告的总数相同**
 *   （实测本仓：578/578、752/752、6597/6597），但选中哪 200 条可能不同——rg 多线程遍历
 *   的顺序与 JS 那侧「按目录名排序的深度优先」不是同一个顺序。模型看到的总数与建议
 *   （「缩小范围」）两边一致，故这个差异可以接受；**但别把「排序后输出」当成两边全等**
 *   （我一开始就是这么写注释的，是错的）。
 * - **被忽略的条目数**：rg 不告诉调用方它忽略了多少，JS 能。故「过滤说明」两边都有，
 *   但 JS 那侧多一个数目（见 `search-tools.ts` 的 `FILTER_NOTE`）。
 * - **全局 gitignore**（`~/.config/git/ignore`、`core.excludesFile`）与 `.git/info/exclude`：
 *   rg 认，JS 那侧不认 → JS 可能**多搜**几个文件。方向是「多搜」而不是「漏搜」。
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
    // rg 的 -g 语义与我们的 glob 一致（`*` 不跨目录、`**` 跨目录），直接透传
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
 * ⚠️ `stdio` 的 stdin **必须是 `"ignore"`**。踩过三次的坑：给子进程一个管道 stdin 时，
 * rg / tar 这类程序会「检测到 stdin 可读 → 去读它 → 等一个永远不来的输入」，
 * 表现为挂死或 `spawnSync ... EBUSY`。这与「沙箱禁止 spawn」毫无关系，纯粹是 stdio 配错。
 */
export function runRipgrep(
  rgPath: string,
  args: string[],
  cwd: string,
): Promise<RgRunResult> {
  return new Promise<RgRunResult>((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncatedByBytes = false;
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(chunks).toString("utf8");
      resolve({ matches: parseRgJson(stdout), truncatedByBytes, code });
    };

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

    // rg 没有匹配时退出码是 1，那是**正常结果**不是错误；2 才是真出错
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== null && code > 1) {
        if (settled) return;
        settled = true;
        reject(new Error(`ripgrep 退出码 ${code}`));
        return;
      }
      finish(code);
    });
  });
}
