/**
 * 展示层的格式化辅助函数。
 * 作者：陕耀云栈WorkMate
 */

/** 把 JSON 字符串美化缩进；解析失败时原样返回 */
export function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
