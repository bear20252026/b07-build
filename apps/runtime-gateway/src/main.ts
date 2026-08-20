import { startLocalGateway } from './gateway-application.js';

/**
 * 进程入口只负责启动本地组合根并转发 OS 关闭信号。
 * 桌面 sidecar 仅允许无参数或固定 `serve`；不接受端口、路径、脚本或任意子命令。
 */
const FIXED_DESKTOP_GATEWAY_PORT = 4318;
const argumentsAfterExecutable = process.argv.slice(2);
if (argumentsAfterExecutable.length > 1 || (argumentsAfterExecutable.length === 1 && argumentsAfterExecutable[0] !== 'serve')) {
  console.error('AI Work OS Gateway only accepts the fixed serve mode.');
  process.exitCode = 64;
} else {
  // 固定端口与 loopback host 由 composition root 强制；环境变量不得改写 desktop sidecar 行为。
  const gateway = startLocalGateway(FIXED_DESKTOP_GATEWAY_PORT);
  let closing = false;

  function shutdown(): void {
    if (closing) return;
    closing = true;
    gateway.close();
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
