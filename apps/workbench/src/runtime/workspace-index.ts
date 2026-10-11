import { invoke } from '@tauri-apps/api/core';

/**
 * 工作区索引的前端门面。
 *
 * 索引本体留在原生内存里，前端只拿三样东西：概览、搜索命中、以及一份注入上下文的
 * 紧凑项目地图。刻意**不把几万条路径搬到 WebView**——搬过来只会占内存，
 * 而且最终还是要截断，等于两头吃亏。
 *
 * 这套设计的意义：模型第一轮看到的不再是“用户手工粘贴的几个文件全文”，
 * 而是整个项目的**路径骨架**。它想读哪份内容，再自己用 workspace_read_file 去取。
 */

export interface WorkspaceIndexSnapshot {
  readonly rootLabel: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly entryCount: number;
  readonly truncated: boolean;
  readonly ignoreRulesActive: boolean;
  readonly builtAtMs: number;
  readonly reusedCache: boolean;
  readonly durationMs: number;
}

export interface WorkspaceSearchHit {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly byteSize: number;
  readonly score: number;
}

export interface WorkspaceSearchResult {
  readonly query: string;
  readonly hits: readonly WorkspaceSearchHit[];
  readonly scanned: number;
  readonly truncatedIndex: boolean;
}

export interface WorkspaceProjectMap {
  readonly text: string;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly truncated: boolean;
  readonly truncatedIndex: boolean;
  readonly ignoreRulesActive: boolean;
}

const WORKSPACE_INDEX_ERRORS: Readonly<Record<string, string>> = {
  'workspace-root-not-selected': '用户还没有选择工作区目录，因此无法建立项目索引。请直接告诉用户：需要先在“工作区与文件”页面选择工作区文件夹。',
  'workspace-root-unavailable': '工作区目录当前不可访问（可能已被移动或删除），索引无法建立。请如实告诉用户。',
  'workspace-index-unavailable': '索引状态被占用，无法建立或读取项目索引。请稍后重试。',
};

/** 与 workspaceToolErrorText 同源的解包逻辑：原生 Err 有时是字符串，有时被包成 { message }。 */
export function nativeErrorCode(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const wrapped = (error as { message?: unknown } | null | undefined)?.message;
  return typeof wrapped === 'string' ? wrapped : '';
}

export function workspaceIndexErrorText(error: unknown): string {
  const code = nativeErrorCode(error);
  return WORKSPACE_INDEX_ERRORS[code] ?? `建立或查询工作区索引失败：${code || '未知错误'}。请如实告诉用户，不要假装看到了项目内容。`;
}

/** 建立（或复用）索引。传 force=true 会无条件重新扫描磁盘。 */
export async function buildWorkspaceIndex(force = false): Promise<WorkspaceIndexSnapshot> {
  return invoke<WorkspaceIndexSnapshot>('workspace_build_index', { force });
}

/** 按名称或路径片段搜索文件；打分与 top-K 都在原生侧完成。 */
export async function searchWorkspaceFiles(query: string, limit?: number): Promise<WorkspaceSearchResult> {
  return invoke<WorkspaceSearchResult>('workspace_search_files', { query, ...(typeof limit === 'number' ? { limit } : {}) });
}

/** 取注入上下文用的项目地图。默认预算已在原生侧设好，一般不需要覆盖。 */
export async function readWorkspaceProjectMap(maxLines?: number, maxChars?: number): Promise<WorkspaceProjectMap> {
  return invoke<WorkspaceProjectMap>('workspace_project_map', {
    ...(typeof maxLines === 'number' ? { maxLines } : {}),
    ...(typeof maxChars === 'number' ? { maxChars } : {}),
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 把注入上下文的项目地图包成一段带边界的引用块，避免与用户正文混淆。 */
export function projectMapContextText(map: WorkspaceProjectMap): string {
  if (!map.text.trim()) return '';
  const truncated = map.truncated ? '（项目地图已达到展示预算，还有目录没有列出。）' : '';
  return `\n\n--- 当前工作区的项目地图（仅路径引用，不含文件内容） ---\n${map.text}${truncated ? `\n${truncated}` : ''}\n--- 项目地图结束 ---`;
}

/** 把搜索命中渲染成模型可以直接引用的清单；没有命中时给出可操作的下一步。 */
export function searchResultText(result: WorkspaceSearchResult): string {
  const query = result.query.trim();
  if (!query) return '缺少 query 参数：请给出要搜索的文件名或路径片段。';
  if (!result.hits.length) {
    return `在工作区索引（共 ${result.scanned} 条）里没有找到与“${query}”匹配的文件。请换更短或更通用的关键词，或用 workspace_list_files 列目录确认真实路径。`;
  }
  const lines = result.hits.map((hit, index) => `${index + 1}. ${hit.path}${hit.kind === 'directory' ? '/（目录）' : `（文件，${formatBytes(hit.byteSize)}）`}`);
  const head = `搜索“${query}”：命中 ${result.hits.length} 条 / 扫描 ${result.scanned} 条。`;
  const tail = result.truncatedIndex ? '注意：索引已达条数上限，未命中不代表文件不存在。' : '';
  return [head, ...lines, tail].filter(Boolean).join('\n');
}
