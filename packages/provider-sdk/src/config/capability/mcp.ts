// 一个文件=一种作用：provider「MCP server 配置」能力面契约（纯类型，零 IO）。

/** MCP server 的作用域：用户级 / 工作区级。 */
export type McpScope = 'user' | 'workspace';

/** 归一化后的一条 MCP server 记录。 */
export interface ProviderMcpServer {
  readonly name: string;
  readonly scope: McpScope;
  /** 启动命令（stdio 型）；远端型 server 可缺席。 */
  readonly command?: string;
  readonly enabled?: boolean;
}

export interface ProviderMcpServerInput {
  readonly name: string;
  readonly scope?: McpScope;
  /** 工作区作用域下的工作目录；用户作用域忽略。 */
  readonly workspacePath?: string;
  /** provider 原生的 server 配置体，按原样透传。 */
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * MCP server 配置能力面。
 * 只声明「provider 能列出 / 写入 / 删除自己的 MCP 配置」，不声明存储格式。
 */
export interface ProviderMcpFacet {
  listServers(options?: { readonly workspacePath?: string }): Promise<readonly ProviderMcpServer[]>;
  upsertServer(input: ProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(input: { readonly name: string; readonly scope?: McpScope; readonly workspacePath?: string }): Promise<boolean>;
}
