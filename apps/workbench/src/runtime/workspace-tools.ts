import { invoke } from '@tauri-apps/api/core';
import type { DirectProviderTool } from './direct-provider-client';
import { nativeErrorCode, searchResultText, searchWorkspaceFiles } from './workspace-index';

/**
 * 工作区文件工具：Agent 的第一组真实能力。
 *
 * 全部能力都限制在用户**显式选中**的工作区目录内，原生侧已有三层防护
 * （相对路径语法 / canonicalize 前缀校验 / 体积上限）。这里不再重复校验路径，
 * 只负责把原生返回的错误码翻译成模型能读懂、并且能如实转告用户的中文提示——
 * 绝不能把失败伪装成成功，否则模型会基于不存在的文件继续推理。
 */

/** 列目录结果最多占多少字符：巨型仓库的路径清单会把上下文直接吃光。 */
const MAX_LIST_RESULT_CHARS = 12_000;
/** 单条工具结果硬上限，防止一次读取就顶满模型窗口。 */
const MAX_TOOL_RESULT_CHARS = 60_000;

export const WORKSPACE_TOOLS: readonly DirectProviderTool[] = [
  {
    name: 'workspace_search_files',
    description: '按文件名或路径片段在工作区索引里搜索，返回最匹配的若干条路径及其体积。找文件请**优先用这个**，不要把 recursive 列目录当搜索引擎用——后者只适合确认某一层到底有什么。匹配不到时试试更短的关键词。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的文件名或路径片段，例如 agent-tool-loop 或 runtime/agent。' },
        limit: { type: 'number', description: '最多返回多少条，默认 20，最大 100。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_list_files',
    description: '列出工作区内某一层的文件和目录。返回相对工作区根的路径，路径可直接用于读取文件。默认只列一层；不要用 recursive 去“找文件”，那会把上下文铺满，找文件请用 workspace_search_files。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区根的子目录；留空表示工作区根。' },
        recursive: { type: 'boolean', description: '是否递归展开子目录。大仓库慎用。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_read_file',
    description: '读取工作区内一个 UTF-8 文本文件的内容。只接受纯文本；二进制文件会被明确拒绝。文件超过 2 MB 无法读取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区根的文件路径，例如 src/main.rs。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_write_file',
    description: '覆写工作区内**已经存在**的文本文件。不能凭空创建新文件；要新建文件请明确告知用户，由用户创建后再写入。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区根的文件路径，该文件必须已存在。' },
        content: { type: 'string', description: '写入的完整文件内容，会整体替换原内容。' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
];

interface ListResult { readonly rootLabel: string; readonly entries: readonly { readonly path: string; readonly name: string; readonly kind: string; readonly byteSize: number }[]; readonly truncated: boolean; }
interface FileResult { readonly path: string; readonly content: string; readonly byteSize: number; readonly truncated: boolean; }

const WORKSPACE_ERRORS: Readonly<Record<string, string>> = {
  'workspace-root-not-selected': '用户还没有选择工作区目录，因此无法访问任何文件。请直接告诉用户：需要先在“工作区与文件”页面选择工作区文件夹。',
  'workspace-root-unavailable': '工作区目录当前不可访问（可能已被移动或删除）。请如实告诉用户。',
  'workspace-path-not-found': '该路径在工作区内不存在。请换一个路径，或先列出目录确认真实路径。',
  'workspace-path-escapes-root': '该路径超出工作区范围，已被拒绝。只能在用户选中的工作区内操作。',
  'workspace-path-absolute': '请提供相对于工作区根的相对路径，不要使用绝对路径。',
  'workspace-path-empty': '路径为空。',
  'workspace-path-not-directory': '该路径不是目录。',
  'workspace-path-not-file': '该路径不是文件。',
  'workspace-file-unreadable': '文件无法读取（权限不足或已被占用）。',
  'workspace-file-not-utf8': '文件不是 UTF-8 文本（可能是二进制）。无法读取内容。',
  'workspace-file-too-large': '文件超过 2 MB 上限，无法整体读取或写入。',
  'workspace-file-not-found': '目标文件不存在：只允许覆写已存在的文件，不能凭空创建。请告诉用户先创建该文件。',
  'workspace-file-unwritable': '文件写入失败（权限不足或已被占用）。',
  'workspace-directory-unreadable': '目录无法读取。',
  'workspace-file-is-symlink': '该路径是一个符号链接。为了不读穿、不写穿工作区边界，链接本身被拒绝操作。请改用真实文件路径。',
  'workspace-write-approval-required': '写入被拒绝：没有携带原生审批票据。文件写入必须先由用户在确认弹窗中批准，由系统签发票据后才能执行；不能绕过确认直接写文件。',
  'workspace-write-approval-invalid': '写入被拒绝：审批票据无效或已过期。请重新展示改动并等待用户确认，不要重试同一张票据。',
  'workspace-write-approval-mismatch': '写入被拒绝：审批票据绑定的路径与实际写入目标不一致。请确认要写的文件后重新走确认流程。',
  'workspace-write-approval-stale': '写入被拒绝：文件在用户批准之后又被其它程序改动了，批准时看到的原文已经不在磁盘上。请重新读取最新内容、重新展示差异并等待用户再次确认。',
  'workspace-write-approval-content-mismatch': '写入被拒绝：实际要写入的内容与用户批准的内容不一致。必须原样写入被批准的内容，或重新走确认流程。',
  'workspace-approval-digest-invalid': '无法签发写入票据：内容摘要不合法。请重试。',
};

/** 原生侧抛回来的是字符串错误码；其它形态（如 Tauri 包装对象）取 message 再做一次映射。 */
export function workspaceToolErrorText(error: unknown): string {
  // 原生 Result 的 Err 变体会作为字符串 reject；但 Tauri 也可能把它包成 { message }，
  // 两种形态都要认，否则一个包装差异就会让所有错误退化成“未知错误”。
  const raw = nativeErrorCode(error);
  return WORKSPACE_ERRORS[raw] ?? `工具执行失败：${raw || '未知错误'}。请如实告诉用户，不要假装成功。`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（内容已截断，共 ${text.length} 字符）`;
}

/** 从模型给回来的 arguments 原始文本里取出参数；解析失败返回 undefined，由调用方转成可读错误。 */
export function parseToolArguments(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function stringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/** 搜索是唯一能“先定位再读取”的入口，因此它不读文件内容，只回路径清单。 */
async function searchFiles(args: Record<string, unknown>): Promise<string> {
  const query = stringArgument(args, 'query').trim();
  if (!query) return '缺少 query 参数：请给出要搜索的文件名或路径片段。';
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : undefined;
  return searchResultText(await searchWorkspaceFiles(query, limit));
}

async function listFiles(args: Record<string, unknown>): Promise<string> {
  const path = stringArgument(args, 'path').trim();
  const result = await invoke<ListResult>('workspace_list_files', { ...(path ? { path } : {}), recursive: args.recursive === true });
  const lines = result.entries.map((entry) => `${entry.kind === 'directory' ? 'dir ' : 'file'} ${entry.path}${entry.kind === 'directory' ? '' : ` (${entry.byteSize} B)`}`);
  const body = lines.length ? lines.join('\n') : '（目录为空，或所有内容都被排除在列表之外）';
  const head = `工作区：${result.rootLabel}\n共 ${result.entries.length} 项${result.truncated ? '（已达单次上限，结果被截断）' : ''}\n`;
  return truncate(head + body, MAX_LIST_RESULT_CHARS);
}

async function readFile(args: Record<string, unknown>): Promise<string> {
  const path = stringArgument(args, 'path').trim();
  if (!path) return '缺少 path 参数：请提供相对于工作区根的文件路径。';
  const result = await invoke<FileResult>('workspace_read_file', { path });
  return truncate(`文件 ${result.path}（${result.byteSize} 字符${result.truncated ? '，已截断' : ''}）：\n${result.content}`, MAX_TOOL_RESULT_CHARS);
}

/** 一次待确认的写入。`previous` 是文件当前内容，`next` 是模型想写进去的完整内容。 */
export interface WorkspaceWriteApprovalRequest { readonly path: string; readonly previous: string; readonly next: string; }
/** 向用户展示差异并等待决定。返回 false 表示拒绝。 */
export interface WorkspaceWriteApprover { (request: WorkspaceWriteApprovalRequest): Promise<boolean>; }

/** SHA-256 的十六进制摘要，用于把「用户批准的内容」绑定成原生票据。 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function writeFile(args: Record<string, unknown>, approve: WorkspaceWriteApprover | undefined): Promise<string> {
  const path = stringArgument(args, 'path').trim();
  const content = stringArgument(args, 'content');
  if (!path) return '缺少 path 参数：请提供相对于工作区根的文件路径。';
  if (!content) return '缺少 content 参数：拒绝写入空内容，这会清空目标文件。请确认你真的要清空它。';
  // 没有审批入口就绝不写入。宁可让这次调用失败，也不能让模型绕开人直接改文件。
  if (!approve) return `写入 ${path} 需要用户确认，但当前会话没有提供确认入口；未写入任何内容。请如实告诉用户：改文件必须由用户本人确认或直接自行修改。`;
  // 先把原文读出来，用户才能看到到底要被改成什么样。
  let previous: string;
  try {
    previous = (await invoke<FileResult>('workspace_read_file', { path })).content;
  } catch (error: unknown) {
    return workspaceToolErrorText(error);
  }
  if (previous === content) return `${path} 的内容与目标内容完全一致，未写入。`;
  if (!await approve({ path, previous, next: content })) return `用户拒绝对 ${path} 的写入；未修改任何内容。请如实转告用户，并且不要再换别的方式尝试写入同一个文件。`;
  // SEC-008：用户批准之后先到原生层领一张一次性写入票据。票据绑定
  // 「原文摘要 + 目标内容摘要」，真正落盘由原生侧验证并原子消耗——
  // 即使渲染层被绕过，没有票据的原生写入命令也会被拒绝。
  let token: string;
  try {
    const [previousSha256, nextSha256] = await Promise.all([sha256Hex(previous), sha256Hex(content)]);
    token = await invoke<string>('workspace_stage_write_approval', { path, previousSha256, nextSha256 });
  } catch (error: unknown) {
    return workspaceToolErrorText(error);
  }
  try {
    const result = await invoke<FileResult>('workspace_write_file', { path, content, approvalToken: token });
    return `已写入 ${result.path}（${result.byteSize} 字符）。`;
  } catch (error: unknown) {
    return workspaceToolErrorText(error);
  }
}

/**
 * 执行一次工具调用，返回要作为 role="tool" 内容回填的字符串。
 * 任何失败都以“失败描述”的形式返回而不是抛出：工具结果必须是模型能读到的一句话，
 * 抛异常会让整个 Agent 回合中断，模型也就失去了自我修正的机会。
 */
export async function executeWorkspaceTool(name: string, rawArguments: string, approveWrite?: WorkspaceWriteApprover): Promise<string> {
  if (!['workspace_search_files', 'workspace_list_files', 'workspace_read_file', 'workspace_write_file'].includes(name)) {
    return `未知工具 ${name}。可用工具：workspace_search_files、workspace_list_files、workspace_read_file、workspace_write_file。`;
  }
  const args = parseToolArguments(rawArguments);
  if (!args) return `工具 ${name} 的参数不是合法 JSON：${truncate(rawArguments, 200)}。请重新发起调用并给出合法 JSON。`;
  try {
    if (name === 'workspace_search_files') return await searchFiles(args);
    if (name === 'workspace_list_files') return await listFiles(args);
    if (name === 'workspace_read_file') return await readFile(args);
    return await writeFile(args, approveWrite);
  } catch (error: unknown) {
    return workspaceToolErrorText(error);
  }
}
