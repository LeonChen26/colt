/**
 * 故障注入用的假 worker：不做任何初始化就直接退出，
 * 用来验证主进程在「worker 就绪前退出」时能快速失败而非永久挂起。
 * 仅供诊断冒烟使用（COLT_WORKER_OVERRIDE 指向它）。
 */
process.exit(0);
