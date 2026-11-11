// 用户登记的 MCP server 配置（应用侧读写）。
//
// 配置存在 `~/.awo/mcp-servers.json`（`AWO_MCP_SERVERS_FILE` 可覆盖），由 Tauri 命令
// `mcp_server_config_*` 读写。**执行的是用户自己填的命令** —— 插件只能按 `serverId`
// 引用，不能声明要跑什么。这条边界是有意的，见 `docs/design/plugin-ledger-and-mcp-trust.md`。

import { invoke } from '@tauri-apps/api/core';

export interface McpServerConfigEntry {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  /** `[key, value]` 对，保持顺序。 */
  readonly env: readonly (readonly [string, string])[];
  readonly workingDirectory?: string;
  readonly enabled: boolean;
}

/** 新增/更新时用的输入形状（`enabled` 可省，默认开）。 */
export interface McpServerConfigDraft {
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: readonly (readonly [string, string])[];
  readonly workingDirectory?: string;
  readonly enabled?: boolean;
}

/** id 只允许 `[A-Za-z0-9._-]`：它会被用作日志与插件引用的键。 */
export const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 校验并归一化一条原生返回的记录。
 *
 * 跨进程边界的数据不受类型系统保护。形状不对就丢弃 —— 少显示一条是"看不到"，
 * 显示一条假的会让人以为某个 server 配好了。
 */
export function toMcpServerConfigEntry(value: unknown): McpServerConfigEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || !MCP_SERVER_ID_PATTERN.test(input.id)) return undefined;
  if (typeof input.command !== 'string' || !input.command.trim()) return undefined;
  const args = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === 'string') : [];
  const env: [string, string][] = [];
  if (Array.isArray(input.env)) {
    for (const pair of input.env) {
      if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string' && pair[0]) {
        env.push([pair[0], pair[1]]);
      }
    }
  }
  if (input.workingDirectory !== undefined && typeof input.workingDirectory !== 'string') return undefined;
  return {
    id: input.id,
    command: input.command,
    args,
    env,
    ...(typeof input.workingDirectory === 'string' && input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
    enabled: input.enabled !== false,
  };
}

function normalizeList(payload: unknown): readonly McpServerConfigEntry[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((item) => toMcpServerConfigEntry(item))
    .filter((item): item is McpServerConfigEntry => item !== undefined);
}

/**
 * 校验草稿。**在调用原生之前**做，这样用户能立刻看到"id 不合法"，
 * 而不是等一个 `mcp-server-config-id-invalid` 的英文码。
 */
export function validateMcpServerDraft(draft: McpServerConfigDraft): string | undefined {
  if (!draft.id.trim()) return '请填写 id';
  if (!MCP_SERVER_ID_PATTERN.test(draft.id)) return 'id 只能包含字母、数字、点、下划线和连字符';
  if (!draft.command.trim()) return '请填写要执行的命令';
  if ((draft.env ?? []).some((pair) => !pair[0]?.trim())) return '环境变量的键不能为空';
  return undefined;
}

/** 读全部配置（含停用的）。文件不存在时返回空列表，不是错误。 */
export async function loadMcpServerConfigs(): Promise<readonly McpServerConfigEntry[]> {
  return normalizeList(await invoke<unknown>('mcp_server_config_list'));
}

/** 新增或更新一条，返回保存后的全量列表。 */
export async function saveMcpServerConfig(draft: McpServerConfigDraft): Promise<readonly McpServerConfigEntry[]> {
  const problem = validateMcpServerDraft(draft);
  if (problem) throw new Error(problem);
  const payload = await invoke<unknown>('mcp_server_config_save', {
    entry: {
      id: draft.id,
      command: draft.command,
      args: [...(draft.args ?? [])],
      env: (draft.env ?? []).map((pair) => [pair[0], pair[1]]),
      ...(draft.workingDirectory ? { workingDirectory: draft.workingDirectory } : {}),
      enabled: draft.enabled !== false,
    },
  });
  return normalizeList(payload);
}

/** 删除一条，返回剩余列表。删不存在的 id 不报错。 */
export async function removeMcpServerConfig(id: string): Promise<readonly McpServerConfigEntry[]> {
  return normalizeList(await invoke<unknown>('mcp_server_config_remove', { id }));
}
