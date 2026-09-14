/**
 * 故障注入用的假 worker：保持进程存活但从不发回就绪事件，
 * 模拟 init 卡死（如 JSONL 重放锁死）。用于验证主进程的就绪超时兜底。
 * 仅供诊断冒烟使用（COLT_WORKER_OVERRIDE 指向它）。
 */
setInterval(() => {}, 1 << 30);
