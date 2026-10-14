// 一个文件=一种作用：MCP 工具描述符归一化（tools/list 原始项 → b07 契约形态）。
//
// 借鉴 ZCode `adapters/src/mcp/descriptor.ts`：_meta 只在入口读一次并归一化，
// 下游不再碰原始 _meta；工具名统一为 `mcp__<server>__<tool>`（与 protocol 的
// mcpToolName 约定一致）；工具级 `_meta.timeoutMs` 覆盖服务器级超时，钳在
// [1s, 30min]（对齐 ZCode 的 MCP_TOOL_META_TIMEOUT 上下限）。

export const MCP_TOOL_TIMEOUT_MIN_MS = 1_000;
export const MCP_TOOL_TIMEOUT_MAX_MS = 30 * 60_000;

export interface McpToolDescriptor {
  readonly serverId: string;
  /** 服务端原始工具名。 */
  readonly toolName: string;
  /** b07/caller 视角的 canonical 名：mcp__<server>__<tool>。 */
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  /** 已归一化的执行超时（工具级 _meta 覆盖服务器级缺省）。 */
  readonly timeoutMs?: number;
}

/** 名称清洗：非 [A-Za-z0-9_-] 折叠为单下划线；空串或全下划线兜底 unknown。 */
export function sanitizeMcpName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  return /^_+$/.test(sanitized) ? 'unknown' : sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readToolMetaTimeoutMs(meta: unknown): number | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta.timeoutMs;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < MCP_TOOL_TIMEOUT_MIN_MS) return undefined;
  return Math.min(Math.floor(value), MCP_TOOL_TIMEOUT_MAX_MS);
}

function normalizeAnnotations(value: unknown): McpToolDescriptor['annotations'] | undefined {
  if (!isRecord(value)) return undefined;
  const source: Record<string, unknown> = value;
  const collected: Record<string, boolean> = {};
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    if (typeof source[key] === 'boolean') collected[key] = source[key] as boolean;
  }
  return Object.keys(collected).length > 0 ? (collected as McpToolDescriptor['annotations']) : undefined;
}

/** 服务端原始工具项 → 归一化描述符；畸形项不抛，缺字段按缺省收敛。 */
export function normalizeMcpToolDescriptor(serverId: string, tool: unknown, defaultTimeoutMs?: number): McpToolDescriptor {
  const record = isRecord(tool) ? tool : {};
  const toolName = typeof record.name === 'string' && record.name.length > 0 ? record.name : 'unknown';
  return {
    serverId,
    toolName,
    name: `mcp__${sanitizeMcpName(serverId)}__${sanitizeMcpName(toolName)}`,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(isRecord(record.inputSchema) ? { inputSchema: { ...record.inputSchema } } : {}),
    ...(isRecord(record.outputSchema) ? { outputSchema: { ...record.outputSchema } } : {}),
    ...(annotationsOf(normalizeAnnotations(record.annotations))),
    ...(timeoutOf(readToolMetaTimeoutMs(record._meta) ?? defaultTimeoutMs)),
  };
}

function annotationsOf(annotations: McpToolDescriptor['annotations']): { annotations?: McpToolDescriptor['annotations'] } {
  return annotations === undefined ? {} : { annotations };
}

function timeoutOf(timeoutMs: number | undefined): { timeoutMs?: number } {
  return timeoutMs === undefined ? {} : { timeoutMs };
}

/** tools/list 的原始数组 → 归一化描述符列表。 */
export function normalizeMcpToolDescriptors(
  serverId: string,
  tools: readonly unknown[],
  defaultTimeoutMs?: number,
): readonly McpToolDescriptor[] {
  return tools.map((tool) => normalizeMcpToolDescriptor(serverId, tool, defaultTimeoutMs));
}
