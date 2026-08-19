import { startLocalGateway } from './gateway-application.js';

/** 进程入口只负责启动本地组合根并将 OS 关闭信号转发为资源释放。 */
const gateway = startLocalGateway();
let closing = false;

function shutdown(): void {
  if (closing) return;
  closing = true;
  gateway.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
