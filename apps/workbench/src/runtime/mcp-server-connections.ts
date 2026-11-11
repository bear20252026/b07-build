// 把"用户登记的 server 配置"接到 MCP 连接注册表上。
//
// ## 一个刻意的语义
//
// **未配置 = 未连接**，而不是"可执行但没连"。插件声明了 `serverId` 却没有对应配置时，
// 注册表拿到的工厂返回 `undefined`，条目落成 `failed: no-session-spec` —— 界面因此能说
// "这个插件声明的 server 你没配"，而不是含糊地显示"连接中"。
//
// ## 为什么传输是注入的
//
// 生产用 `McpStdioTransport`（spawn 走原生 `mcp_start_process`）；测试注入 loopback。
// 这样这条链路的行为（谁被连、谁没被连、工具数怎么算）可以在不起进程的前提下验证。

import type { McpServerConfigEntry } from './mcp-server-config';
import type { McpWireTransport } from './zcode/mcp-client-transport';
import { McpConnectionRegistry } from './zcode/mcp-connection-registry';
import { SdkMcpSession } from './zcode/mcp-sdk-session';
import { McpStdioTransport } from './zcode/mcp-stdio-transport';

export interface McpServerConnectionDeps {
  /** 传输工厂。省略时用真实的 stdio 传输（Tauri 起进程）。 */
  createTransport?(config: McpServerConfigEntry): McpWireTransport;
  readonly requestTimeoutMs?: number;
}

/** 由配置造一个注册表。停用的配置不参与连接。 */
export function createMcpServerRegistry(
  configs: readonly McpServerConfigEntry[],
  deps: McpServerConnectionDeps = {},
): McpConnectionRegistry {
  const byId = new Map(configs.filter((config) => config.enabled).map((config) => [config.id, config]));
  return new McpConnectionRegistry({
    createSession: (serverId) => {
      const config = byId.get(serverId);
      // 未配置或已停用：明确"没有会话规格"，而不是编一个默认命令去跑。
      if (!config) return undefined;
      const transport = deps.createTransport?.(config) ?? new McpStdioTransport({
        runId: `mcp-server-${config.id}`,
        executable: config.command,
        args: config.args,
        env: config.env,
        ...(config.workingDirectory ? { workingDirectory: config.workingDirectory } : {}),
      });
      return new SdkMcpSession({
        serverId,
        transport,
        ...(deps.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: deps.requestTimeoutMs }),
      });
    },
  });
}
