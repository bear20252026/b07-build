// 一个文件=一种作用：把池化的 MCP 客户端适配成 MCP 应用的执行器（McpAppToolExecutor 的缺省实现）。
//
// 这是 P0-1c 的「通电」点：挂载控制器此前只会注入 fail-closed 缺省执行器；
// 提供 pool（池内工厂已接连接提供器）后，本工厂让应用的工具调用直达真实
// MCP 服务器。语义纪律：
//   1. canonical 名必须可反向解析（parseMcpToolName），否则拒绝执行——
//      不猜分段、不fallback到本地；
//   2. 业务失败（tools/call 的 isError）原样带回：宿主的
//      mapToolResultToCallToolResult 会保留 isError，调用方不篡改；
//   3. 协议失败（会话/传输/超时）抛错：宿主把它包成 isError 的 CallToolResult；
//   4. 租约必然归还（finally）：握手失败或调用异常都不许泄漏池引用。

import { parseMcpToolName, type ToolRegistry } from '@awo/protocol';
import type { McpAppToolExecutor } from './mcp-app-mount-controller';
import type { McpClientPool, McpIsolation } from './mcp-client-pool';

export interface McpPoolToolExecutorOptions {
  readonly pool: McpClientPool;
  /** 工具契约注册表：用于按 canonical 名取工具级超时（_meta.timeoutMs 已在描述符归一化）。 */
  readonly descriptors?: ToolRegistry;
  readonly isolation?: McpIsolation;
  /** session 隔离时的会话标识。 */
  readonly scopeId?: string;
}

export function createMcpPoolToolExecutor(options: McpPoolToolExecutorOptions): McpAppToolExecutor {
  return {
    async execute(toolName: string, args: unknown): Promise<unknown> {
      const parsed = parseMcpToolName(toolName);
      if (parsed === undefined) {
        throw new Error(`mcpapp-tool-name-unparseable:${toolName}`);
      }
      const lease = await options.pool.acquire({
        serverId: parsed.serverId,
        isolation: options.isolation ?? 'session',
        ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
      });
      try {
        const timeoutMs = options.descriptors?.resolve(toolName)?.timeoutMs;
        const outcome = await lease.session.callTool(parsed.toolName, args, { timeoutMs });
        if (!outcome.ok) {
          throw new Error(`${outcome.reason}:${outcome.message ?? ''}`);
        }
        // isError 等业务字段随 CallToolResult 原样返回，由宿主信封层保留语义。
        return outcome.result ?? {};
      } finally {
        lease.release();
      }
    },
  };
}
