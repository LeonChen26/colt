/**
 * 测试用的临时目录。
 *
 * 只管两件事，但都要坐实：
 *   1. **建**：统一落在系统临时目录下，前缀由调用方给，残留时能认出是谁的；
 *   2. **删**：只删本模块建过的目录。
 *
 * 第 2 条不是洁癖。`rmSync(dir, { recursive: true, force: true })` 里的 `force`
 * 会把「路径写错」也吞成静默成功——而递归删目录一旦指错地方，删掉的就是工作区或
 * 用户目录。测试的清理代码恰好最容易在「建目录那步抛了 → 变量还是空串，或还是上一个
 * 用例的旧值」时删错，而这种错误平时完全不可见（清理失败本来就不响）。所以这里不靠
 * 调用方自觉：只认登记过的路径，其余一律抛错。
 *
 * 由此带来的使用约束：**建目录必须走本模块**。自己 `mkdtempSync` 再交给
 * `removeTempDir` 会被守卫拦下——这是有意的，不是缺陷。
 */
import { mkdtempSync, rmSync } from "node:fs";
// 异步版必须是 `node:fs/promises`：`node:fs` 里同名的是回调式函数，
// 漏了路径会在调用时才报「The "cb" argument must be of type function」。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 本模块创建过的目录。**只增不删**：「这个路径是本模块建的」是历史事实，
 * 不因为后来把它删了就不再成立——删除动作本身也不该让守卫失去判断依据。
 */
const created = new Set<string>();

/** 建出后登记。存规范化路径，免得 `x/` 这类写法在查找时落空。 */
function register(dir: string): string {
  created.add(resolve(dir));
  return dir;
}

/** 校验路径确由本模块创建；否则抛错（拒绝删，而不是删了再报错）。 */
function assertOwned(dir: string, caller: string): string {
  const key = resolve(dir);
  if (!created.has(key)) {
    throw new Error(`${caller} 拒绝删除不是本模块创建的路径：${JSON.stringify(dir)}`);
  }
  return key;
}

/** 建一个临时目录（同步）。`prefix` 拼在随机后缀之前。 */
export function makeTempDir(prefix = "colt-"): string {
  return register(mkdtempSync(join(tmpdir(), prefix)));
}

/** 建一个临时目录（异步），供 `before(async () => …)` 使用。 */
export async function makeTempDirAsync(prefix = "colt-"): Promise<string> {
  return register(await mkdtemp(join(tmpdir(), prefix)));
}

/**
 * 删掉临时目录，可一次传多个。
 *
 * - 未登记的路径：抛错，**不删**（见文件头）。
 * - 已登记的路径：递归删掉；已经不存在时静默跳过。
 * - 同一条路径删两次：第二次仍是空操作，不抛——`after()` 与 `finally` 都清理
 *   是常见写法，重复清理无害，不该让用例失败。
 */
export function removeTempDir(...dirs: readonly string[]): void {
  for (const dir of dirs) {
    rmSync(assertOwned(dir, "removeTempDir"), { recursive: true, force: true });
  }
}

/** 异步版删除，供 `after(async () => …)` 使用。 */
export async function removeTempDirAsync(...dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    await rm(assertOwned(dir, "removeTempDirAsync"), { recursive: true, force: true });
  }
}

/** 该路径是否由本模块创建过（只给本助手的用例做断言用）。 */
export function isTempDirTracked(dir: string): boolean {
  return created.has(resolve(dir));
}
