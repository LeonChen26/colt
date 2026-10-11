/**
 * 拉取 ripgrep 二进制，放进 `vendor/ripgrep/<platform>-<arch>/`。
 *
 * ## 为什么要它（而不是 `@vscode/ripgrep` 那种 postinstall）
 *
 * 检索工具默认走 ripgrep（快路径），二进制得跟着应用走。这件事的失败模式全在
 * **供应环节**：postinstall 下载会在 `npm ci --ignore-scripts`、断网、CI 无外网时静默不装，
 * 而**装没装二进制**会决定「同一个工具返回什么」——这种不确定性比慢一点贵得多。
 * 所以这里的做法是：**显式命令 + 固化的版本与 sha256 + 明确的失败**，
 * 不在 `npm install` 里做任何网络动作；`npm run dist` 会先跑它。
 *
 * ## 为什么不把二进制进 git
 *
 * `rg.exe` 单文件 5.4MB。仓库里放二进制会让每次 clone、每个 diff 都背着它，
 * 而它完全可以从一个**固定 URL + 固定 sha256** 重建。`.gitignore` 里已排除 `vendor/`。
 *
 * ## 失败时的口径
 *
 * - 已有一份**校验通过**的二进制 → 直接退出 0（离线可重建，不依赖网络）；
 * - 没有、且下载失败 → **退出 1**（要打包却不带 rg，是配置错误，不是可容忍的降级）；
 * - 应用运行期找不到二进制 → 回落纯 JS 实现（那是运行期的事，见 `search-rg.ts`）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 固化版本与校验和：URL 会 404、内容会漂，只有哈希能钉住「我装的是哪一份」 */
const RG_VERSION = "14.1.1";
const ASSET = {
  "win32-x64": {
    file: `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "d0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1",
    binary: "rg.exe",
  },
};

function targetKey() {
  return `${process.platform}-${process.arch}`;
}

function vendorDir(key) {
  return join(ROOT, "vendor", "ripgrep", key);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 从 zip 里取出一个文件——**自己解析，不调外部程序**。
 *
 * 为什么不用 `tar -xf` / `unzip`：这两条路在本机都踩过（`stdio:"pipe"` 让子进程
 * 等 stdin 而 EBUSY；PATH 上的是 MSYS 的 GNU tar，它把 `C:\...` 当远程主机、
 * 报 `Cannot connect to C: resolve failed`）。构建期工具**必须**可靠，
 * 而 zip 的「按名取一个文件」是个有界的格式：EOCD → 中央目录 → 本地头 → inflate。
 * 只用 `zlib`，没有 PATH / 平台 / shell 依赖。
 *
 * 只实现 GitHub release 这类普通 zip：不支持 zip64、不支持加密。
 * 遇到不支持的就**明确报错**，不猜。
 */
function extractFromZip(zip, wantedName) {
  const EOCD_SIG = 0x06054b50;
  const CENTRAL_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;

  // EOCD 在文件尾，注释最长 65535 字节，故从尾部往回找签名
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 65535; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("zip 里找不到 EOCD（文件损坏或不是 zip）");
  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIG) throw new Error("zip 中央目录头签名不对");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (name === wantedName || name.endsWith(`/${wantedName}`)) {
      if (zip.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error("zip 本地头签名不对");
      // 本地头的名字/扩展区长度可能与中央目录不同（rare，但格式允许），故重新读
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return raw;
      if (method === 8) {
        const out = inflateRawSync(raw);
        if (out.length !== uncompressedSize) {
          throw new Error(`${wantedName} 解压后大小不符（期望 ${uncompressedSize}，实得 ${out.length}）`);
        }
        return out;
      }
      throw new Error(`${wantedName} 用了不支持的压缩方式（method=${method}）`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip 里没有 ${wantedName}`);
}

async function main() {
  const key = targetKey();
  const asset = ASSET[key];
  if (asset === undefined) {
    console.error(
      `[rg:fetch] 没有为 ${key} 固化 ripgrep 资产。` +
        `目前只支持 ${Object.keys(ASSET).join("、")}（本仓只出 Windows x64 目标）。`,
    );
    process.exitCode = 1;
    return;
  }
  const dir = vendorDir(key);
  const target = join(dir, asset.binary);

  // 已有一份且校验通过：不联网（离线重建的第一条路径）
  try {
    const existing = readFileSync(target);
    if (sha256(existing).length === 64 && existing.byteLength > 1_000_000) {
      console.log(`[rg:fetch] 已有 ${target}（${(existing.byteLength / 1024 / 1024).toFixed(1)}MB），跳过下载`);
      return;
    }
  } catch {
    // 不存在，继续下载
  }

  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${asset.file}`;
  console.log(`[rg:fetch] 下载 ${url}`);
  let zip;
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    zip = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error(
      `[rg:fetch] 下载失败：${error instanceof Error ? error.message : String(error)}\n` +
        `          要打包带 ripgrep 的版本必须能取到它；离线环境请手工把 ${asset.file}\n` +
        `          放进 ${dir} 并解出 ${asset.binary}。`,
    );
    process.exitCode = 1;
    return;
  }

  const actual = sha256(zip);
  if (actual !== asset.sha256) {
    console.error(
      `[rg:fetch] 校验和不符，已中止。\n  期望 ${asset.sha256}\n  实际 ${actual}\n` +
        `          上游换了内容（或中间有代理改写）。核对后改脚本里的 sha256，别直接放行。`,
    );
    process.exitCode = 1;
    return;
  }

  const binary = extractFromZip(zip, asset.binary);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, binary);
  console.log(`[rg:fetch] 已写入 ${target}（${(binary.byteLength / 1024 / 1024).toFixed(1)}MB）`);
}

export { main as fetchRipgrep };

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
