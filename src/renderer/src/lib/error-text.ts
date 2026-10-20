// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 把失败翻成用户能懂的一句话（`docs/ERRORS.md` §四）。
 *
 * 为什么只能是「按文案匹配」：渲染层拿到的错误**只有字符串**——主进程的异常经
 * `ipcRenderer.invoke` 反序列化后只剩 `message`（`_tag` / `code` / `status` 都没了），
 * worker 推来的 `session.error` 同样是字符串。所以分类只能基于消息里的 Node/Chromium
 * 错误码与已知的上层文案；这也是为什么这里只做**保守匹配**：认不出就原样返回，
 * 绝不臆造一个看起来更漂亮的原因。
 *
 * 匹配顺序即优先级：越具体越先判（例如「未配置 API Key」先于泛化的 401）。
 */

export interface ErrorDescription {
  /** 一句话原因（展示主行） */
  summary: string;
  /** 建议动作（可选，展示在下一行） */
  hint?: string;
  /** 去掉 IPC 包装后的原始信息（详情折叠里给） */
  raw: string;
}

interface Rule {
  test: RegExp;
  summary: string;
  hint?: string;
}

/** 按「先具体后笼统」排列；命中即停。 */
const RULES: readonly Rule[] = [
  {
    test: /数据库尚未初始化|openDatabase\(\)/,
    summary: "应用数据尚未就绪",
    hint: "请重启应用；若反复出现，检查数据目录是否被其它进程占用。",
  },
  {
    test: /未找到 bash|bash 不可用|未找到 \S*shell/i,
    summary: "没有找到可用的命令行环境",
    hint: "安装 Git for Windows（自带 bash）后重启应用。",
  },
  {
    test: /尚未配置 .*API Key|未配置 .*API Key|Provider 不存在|模型服务.*不存在/,
    summary: "这个模型服务不可用",
    hint: "到「设置 → 模型服务」检查密钥，或在输入区换一个模型。",
  },
  {
    test: /\b401\b|Unauthorized|invalid[_ ]?api[_ ]?key|incorrect api key/i,
    summary: "模型服务拒绝了鉴权",
    hint: "到「设置 → 模型服务」检查 API Key 是否有效。",
  },
  {
    test: /\b403\b|Forbidden/i,
    summary: "模型服务拒绝访问",
    hint: "检查密钥权限（可能是服务商侧的白名单或套餐限制）。",
  },
  {
    test: /\b429\b|rate[_ ]?limit|too many requests/i,
    summary: "请求太频繁，被服务商限流",
    hint: "稍等片刻再试。",
  },
  {
    test: /\b402\b|insufficient[_ ]?(quota|balance)|余额不足|额度不足/i,
    summary: "账户额度不足",
    hint: "检查服务商的余额或配额。",
  },
  {
    test: /context[_ ]length|too many tokens|上下文.*(超|上限)|maximum context/i,
    summary: "上下文超出模型上限",
    hint: "压缩上下文，或换一个上下文更大的模型。",
  },
  {
    test: /ECONNREFUSED|ERR_CONNECTION_REFUSED/i,
    summary: "连接被拒绝",
    hint: "目标服务可能没有启动，或地址 / 端口不对。",
  },
  {
    test: /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i,
    summary: "找不到这个地址",
    hint: "检查网络连接或代理设置。",
  },
  {
    test: /ECONNRESET|ETIMEDOUT|ERR_TIMED_OUT|socket hang up|timed out/i,
    summary: "连接中断或超时",
    hint: "检查网络后重试。",
  },
  {
    test: /ENOSPC/,
    summary: "磁盘空间不足",
    hint: "清理磁盘后重试。",
  },
  {
    test: /EACCES|EPERM/,
    summary: "没有访问权限",
    hint: "检查文件或目录的权限，必要时换一个位置。",
  },
  {
    test: /ENOTDIR/,
    summary: "路径里有一段不是目录",
    hint: "检查路径是否写错。",
  },
  {
    test: /EISDIR/,
    summary: "目标是一个目录，不是文件",
    hint: "换一个文件路径。",
  },
  {
    test: /ENOENT|no such file or directory/i,
    summary: "文件或目录不存在",
    hint: "它可能已被移动或删除。",
  },
  {
    test: /node-pty|Cannot find module|NODE_MODULE_VERSION|ABI/i,
    summary: "终端组件加载失败",
    hint: "组件与当前版本不匹配，重新安装应用通常可以恢复。",
  },
];

/**
 * Electron 的 `invoke` 会给所有主进程异常套一层前缀，去掉它再匹配：
 * `Error invoking remote method 'session.open': Error: ENOENT ...`
 */
function unwrap(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^Error:\s*/, "")
    .trim();
}

export function describeError(input: unknown): ErrorDescription {
  const raw = unwrap(input instanceof Error ? input.message : String(input ?? ""));
  for (const rule of RULES) {
    if (rule.test.test(raw)) return { summary: rule.summary, hint: rule.hint, raw };
  }
  return { summary: raw === "" ? "操作失败（没有更多信息）" : raw, raw };
}

/** 只想要一句话时用这个（列表行、卡片里的紧凑位置）。 */
export function errorSummary(input: unknown): string {
  return describeError(input).summary;
}
