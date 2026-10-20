// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 会话分叉的存储层：把源会话的 durable 库**快照复制**成新会话自己的库。
 *
 * 为什么必须复制，而不是把 fork 出来的对话挂到新会话行上：
 * pi-durable 的 fork 是**库内**操作（`conversation.fork(at)`），而 Colt 的存储粒度是
 * 「一个会话一个库」，且内核要求一个 storage 同一时间只归一个进程（没有跨进程锁）。
 * 新会话要拥有自己的 worker，就必须有自己的库——直接在源库里 fork，新 worker 打不开它；
 * 让两个 worker 共用源库又违反独占前提。于是改成「先复制、再在副本里 fork」：
 * 源库一个字节都不动，新会话从副本开始。
 */
import { DatabaseSync } from "node:sqlite";

/**
 * 用 SQLite 的 `VACUUM INTO` 生成一份紧凑副本。
 *
 * 选它而不是 `copyFileSync`：源库是 WAL 模式，最近的提交可能还在 `-wal` 里；
 * `VACUUM INTO` 走一次读事务，读到的就是**已提交的全部数据**，目标文件天然自洽，
 * 不必再单独处理 `-wal` / `-shm`。调用方必须保证源库此刻没有写入者（worker 已退出）。
 */
export function copySessionDatabase(sourcePath: string, destinationPath: string): void {
  const db = new DatabaseSync(sourcePath);
  try {
    // VACUUM INTO 的目标是 SQL 字面量，不支持参数绑定；路径里的单引号按 SQL 规则转义。
    db.exec(`VACUUM INTO '${destinationPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}
