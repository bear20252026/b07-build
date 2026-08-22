export type WorkspaceFileKind = 'text' | 'document' | 'archive' | 'media' | 'binary';
export type WorkspaceFilePreview = 'text' | 'metadata';

export interface WorkspaceFileDescriptor {
  readonly id: string;
  readonly name: string;
  readonly byteSize: number;
  readonly kind: WorkspaceFileKind;
  readonly preview: WorkspaceFilePreview;
  readonly extension: string;
}

export interface WorkspaceFilePreferencesV1 {
  readonly schemaVersion: 1;
  readonly outputTarget: 'app-managed' | 'selected-workspace';
  readonly workspaceLabel: string | undefined;
}

const STORAGE_KEY = 'awo.workspace.file-preferences.v1';
const TEXT = new Set(['txt', 'md', 'mdx', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'csv', 'tsv', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'rb', 'swift', 'scala', 'r', 'lua', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'tex', 'rst', 'log', 'gitignore', 'dockerfile']);
const DOCUMENT = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'epub', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp']);
const ARCHIVE = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso']);
const MEDIA = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'avif', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'mp4', 'webm', 'mov', 'mkv', 'avi']);

export const DEFAULT_WORKSPACE_FILE_PREFERENCES: WorkspaceFilePreferencesV1 = Object.freeze({ schemaVersion: 1, outputTarget: 'app-managed', workspaceLabel: undefined });

export function fileExtension(name: string): string {
  const normalized = name.trim().toLowerCase();
  const last = normalized.lastIndexOf('.');
  return last > 0 && last < normalized.length - 1 ? normalized.slice(last + 1) : '';
}

/** 分类只依赖文件名与大小；不会读取、上传、解析、解压或执行所选文件。 */
export function classifyWorkspaceFile(file: Pick<File, 'name' | 'size'>, index = 0): WorkspaceFileDescriptor {
  const extension = fileExtension(file.name);
  const kind: WorkspaceFileKind = TEXT.has(extension) ? 'text' : DOCUMENT.has(extension) ? 'document' : ARCHIVE.has(extension) ? 'archive' : MEDIA.has(extension) ? 'media' : 'binary';
  return Object.freeze({ id: `${index}-${file.name}-${file.size}`, name: file.name, byteSize: file.size, extension, kind, preview: kind === 'text' && file.size <= 256 * 1024 ? 'text' : 'metadata' });
}

export function parseWorkspaceFilePreferences(value: unknown): WorkspaceFilePreferencesV1 {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const workspaceLabel = typeof source.workspaceLabel === 'string' && source.workspaceLabel.length > 0 && source.workspaceLabel.length <= 80 && !/[\\/]/.test(source.workspaceLabel) ? source.workspaceLabel : undefined;
  return { schemaVersion: 1, outputTarget: source.outputTarget === 'selected-workspace' ? 'selected-workspace' : 'app-managed', workspaceLabel };
}

export function loadWorkspaceFilePreferences(storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): WorkspaceFilePreferencesV1 {
  if (!storage) return DEFAULT_WORKSPACE_FILE_PREFERENCES;
  try { const saved = storage.getItem(STORAGE_KEY); return saved ? parseWorkspaceFilePreferences(JSON.parse(saved)) : DEFAULT_WORKSPACE_FILE_PREFERENCES; } catch { return DEFAULT_WORKSPACE_FILE_PREFERENCES; }
}

export function saveWorkspaceFilePreferences(preferences: WorkspaceFilePreferencesV1, storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
