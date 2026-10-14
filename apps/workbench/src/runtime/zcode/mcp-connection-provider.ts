// 一个文件=一种作用：MCP 连接提供器——把注册表声明的连接规格变成 McpWireTransport。
//
// 与 agent-runtime mcp-registry 的 McpConnection 形状对齐（stdio: executable+args /
// streamable_http: endpoint），但本模块不读库：manifest 由调用方注入加载
//（注册表的 UI/HTTP 接线是后续批次），这里只做「规格 → 传输」的纯映射。
//
// 边界：stdio 已通电（P0-1b 的 Tauri 命令面）；streamable_HTTP 传输尚未实现，
// 此刻对 HTTP 服务器返回 undefined——调用方按「连接不可用」失败，绝不假装能连。

import { McpStdioTransport, type McpStdioTransportDeps } from './mcp-stdio-transport';
import type { McpWireTransport } from './mcp-client-transport';

/** 注册表连接声明的最小形状（与 mcp-registry 的 McpConnection 对齐）。 */
export type McpServerConnection =
  | { readonly transport: 'stdio'; readonly executable: string; readonly args: readonly string[] }
  | { readonly transport: 'streamable_http'; readonly endpoint: string };

export interface McpConnectionProvider {
  /** 为服务器取一个已启动的传输；不可用（未注册/传输未实现/启动失败）返回 undefined。 */
  transportFor(serverId: string): Promise<McpWireTransport | undefined>;
}

export interface McpStdioConnectionProviderOptions {
  /** manifest 加载器：注册表存储/HTTP 客户端在使用方注入。 */
  loadConnection(serverId: string): Promise<McpServerConnection | undefined> | McpServerConnection | undefined;
  /** 显式注入的环境变量（代理/CA 等）；原样传给原生侧（原生侧清洗）。 */
  env?: readonly (readonly [string, string])[];
  /** runId 生成器；缺省按 mcp-<serverId>-<序号> 保证每次连接唯一（SEC-005 预留语义）。 */
  runIdFor?: (serverId: string) => string;
  /** 传输依赖注入（测试/非原生环境）；缺省走 Tauri 真实命令面。 */
  deps?: McpStdioTransportDeps;
}

export function createMcpStdioConnectionProvider(options: McpStdioConnectionProviderOptions): McpConnectionProvider {
  let sequence = 0;
  return {
    async transportFor(serverId: string): Promise<McpWireTransport | undefined> {
      let connection: McpServerConnection | undefined;
      try {
        connection = await options.loadConnection(serverId);
      } catch {
        return undefined;
      }
      if (connection === undefined) return undefined;
      if (connection.transport === 'streamable_http') {
        // HTTP 传输未实现：明确缺口，调用方 fail-closed。
        return undefined;
      }
      sequence += 1;
      const transport = new McpStdioTransport({
        runId: options.runIdFor?.(serverId) ?? `mcp-${serverId}-${sequence}`,
        executable: connection.executable,
        args: connection.args,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.deps === undefined ? {} : { deps: options.deps }),
      });
      try {
        await transport.start();
      } catch {
        return undefined;
      }
      return transport;
    },
  };
}
