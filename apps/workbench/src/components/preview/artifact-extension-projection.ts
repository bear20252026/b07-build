import type { WorkbenchTaskFile } from '../../runtime/task-client';
import type { AssistantArtifactEntry } from '../../runtime/assistant-artifact-ledger';

export type ArtifactRailEntry = Readonly<{
  id: string;
  kind: 'task' | 'assistant';
  logicalPath: string;
  displayName: string;
  summary: string;
  createdAt: number;
  taskId?: string;
  runId?: string;
}>;

export type ArtifactRailTreeNode = Readonly<{
  id: string;
  name: string;
  folder: boolean;
  entry?: ArtifactRailEntry;
  children: readonly ArtifactRailTreeNode[];
}>;

type MutableTreeNode = {
  id: string;
  name: string;
  folder: boolean;
  sortOrder: number;
  entry?: ArtifactRailEntry;
  children: Map<string, MutableTreeNode>;
};

type TreeSegment = Readonly<{ key: string; name: string; sortOrder: number }>;

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function formatCreatedAt(value: number): string {
  return Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未知';
}

function compactIdentifier(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function safePathSegments(entry: ArtifactRailEntry): readonly string[] {
  const segments = entry.logicalPath.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
  return segments.length ? segments : [entry.displayName];
}

function historySegments(entry: ArtifactRailEntry): readonly TreeSegment[] {
  const fileSegments = safePathSegments(entry);
  const leading = entry.kind === 'assistant'
    ? [
      { key: 'saved-markdown', name: '已保存 Markdown', sortOrder: 0 },
      { key: 'reply-history', name: '回复历史', sortOrder: 0 },
    ]
    : [
      { key: 'task-runs', name: '任务 / 运行记录', sortOrder: 1 },
      { key: `task-${entry.taskId ?? 'unknown'}`, name: `任务 ${compactIdentifier(entry.taskId ?? '未知')}`, sortOrder: 0 },
      { key: `run-${entry.runId ?? 'unknown'}`, name: `运行 ${compactIdentifier(entry.runId ?? '未知')}`, sortOrder: 0 },
    ];
  return [...leading, ...fileSegments.map((segment, index) => ({ key: segment, name: index === fileSegments.length - 1 ? entry.displayName : segment, sortOrder: index === fileSegments.length - 1 ? -entry.createdAt : 0 }))];
}

/** 只投影已经存在的受控 metadata；不枚举本机目录，也不将聊天文本自动视为文件。 */
export function projectArtifactRailEntries(taskFiles: readonly WorkbenchTaskFile[], assistantArtifacts: readonly AssistantArtifactEntry[]): readonly ArtifactRailEntry[] {
  const taskEntries: ArtifactRailEntry[] = taskFiles.map((file) => ({
    id: `task:${file.taskFileId}`,
    kind: 'task',
    logicalPath: file.logicalPath,
    displayName: file.displayName,
    summary: `${file.origin === 'generated' ? '生成产物' : '用户附件'} · v${file.version} · ${formatBytes(file.byteSize)}`,
    createdAt: file.createdAt,
    taskId: file.taskId,
    runId: file.runId,
  }));
  const assistantEntries: ArtifactRailEntry[] = assistantArtifacts.map((file) => ({
    id: `assistant:${file.artifactId}`,
    kind: 'assistant',
    logicalPath: file.logicalPath,
    displayName: file.displayName,
    summary: `Markdown 回复 · ${formatCreatedAt(file.createdAt)} · ${formatBytes(file.byteSize)}`,
    createdAt: file.createdAt,
  }));
  return [...assistantEntries, ...taskEntries].sort((left, right) => right.createdAt - left.createdAt || left.displayName.localeCompare(right.displayName, 'zh-Hans-CN'));
}

/** 将受控 metadata 分组为已保存回复历史和任务运行历史；绝不读取或扫描 logicalPath 所指向的文件系统。 */
export function projectArtifactRailTree(entries: readonly ArtifactRailEntry[]): readonly ArtifactRailTreeNode[] {
  const root = new Map<string, MutableTreeNode>();
  for (const entry of entries) {
    let level = root;
    let path = '';
    const segments = historySegments(entry);
    for (const [index, segment] of segments.entries()) {
      path = path ? `${path}/${segment.key}` : segment.key;
      const isLeaf = index === segments.length - 1;
      const key = isLeaf ? `${path}#${entry.id}` : path;
      let node = level.get(key);
      if (!node) {
        node = { id: key, name: segment.name, folder: !isLeaf, sortOrder: segment.sortOrder, ...(isLeaf ? { entry } : {}), children: new Map() };
        level.set(key, node);
      }
      level = node.children;
    }
  }
  const freeze = (nodes: Map<string, MutableTreeNode>): readonly ArtifactRailTreeNode[] => [...nodes.values()]
    .sort((left, right) => Number(right.folder) - Number(left.folder) || left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-Hans-CN'))
    .map((node) => ({ id: node.id, name: node.name, folder: node.folder, ...(node.entry ? { entry: node.entry } : {}), children: freeze(node.children) }));
  return freeze(root);
}
