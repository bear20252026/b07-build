// 进程级的 MCP server 连接注册表。
//
// ## 为什么是模块级单例
//
// 连接注册表代表"这台机器上现在连着哪些 MCP server"——它本来就是进程级的，
// 不属于某个组件的渲染树。设置页需要写它，发送消息时需要读它；放在组件里就得
// 一路 props 传下去。
//
// 唯一的纪律：**换配置时先关旧连接**，否则会留下孤儿进程。

import type { McpServerConfigEntry } from './mcp-server-config';
import { createMcpServerRegistry } from './mcp-server-connections';
import type { McpConnectionRegistry } from './zcode/mcp-connection-registry';

/** 供 `plugin-reference` 消费的 server 状态。 */
export interface McpServerStatus {
  readonly serverName: string;
  readonly connected: boolean;
  readonly providerVisibleToolCount: number;
}

let registry: McpConnectionRegistry = createMcpServerRegistry([]);

/** 当前注册表（设置页连接时用）。 */
export function currentMcpServerRegistry(): McpConnectionRegistry {
  return registry;
}

/** 按新配置重建注册表。旧连接会被关掉。 */
export function replaceMcpServerRegistry(configs: readonly McpServerConfigEntry[]): McpConnectionRegistry {
  const previous = registry;
  registry = createMcpServerRegistry(configs);
  void previous.closeAll();
  return registry;
}

/**
 * 全部已登记 server 的状态（含未连接/失败的）。
 *
 * 返回**全部**而不是只返回已连接的：`plugin-reference` 需要区分"没配这个 server"
 * 与"配了但没连上"，两者对用户的提示不同。
 */
export function mcpServerStatuses(): readonly McpServerStatus[] {
  return registry.list().map((snapshot) => ({
    serverName: snapshot.serverId,
    connected: snapshot.state === 'ready',
    providerVisibleToolCount: snapshot.state === 'ready' ? snapshot.toolNames.length : 0,
  }));
}
