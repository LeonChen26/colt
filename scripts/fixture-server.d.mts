/**
 * scripts/fixture-server.mjs 的类型声明。
 *
 * 该脚本是开发/测试用的夹具站（手动体验与端到端用例共用），本身用 .mjs 写以便 `npm run fixture`
 * 直接跑；冒烟需要以进程内方式复用它，故在此补一份声明供 TS 解析。
 */
export interface FixtureServer {
  /** 实际监听端口（port 传 0 时由系统分配） */
  port: number;
  /** 形如 http://127.0.0.1:8787/ */
  url: string;
  /** 关停服务（会先断开 keep-alive 连接，避免回调不触发） */
  close(): Promise<void>;
}

export function createFixtureServer(options?: {
  port?: number;
  host?: string;
}): Promise<FixtureServer>;
