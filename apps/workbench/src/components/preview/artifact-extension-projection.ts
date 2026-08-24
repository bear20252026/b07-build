import type { WorkbenchTaskFile } from '../../runtime/task-client';
import type { AssistantArtifactEntry } from '../../runtime/assistant-artifact-ledger';

export type ArtifactRailEntry = Readonly<{
  id: string;
  kind: 'task' | 'assistant';
  logicalPath: string;
  displayName: string;
  summary: string;
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
  entry?: ArtifactRailEntry;
  children: Map<string, MutableTreeNode>;
};

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

/** 只投影已经存在的受控 metadata；不枚举本机目录，也不将聊天文本自动视为文件。 */
export function projectArtifactRailEntries(taskFiles: readonly WorkbenchTaskFile[], assistantArtifacts: readonly AssistantArtifactEntry[]): readonly ArtifactRailEntry[] {
  const taskEntries: ArtifactRailEntry[] = taskFiles.map((file) => ({
    id: `task:${file.taskFileId}`,
    kind: 'task',
    logicalPath: file.logicalPath,
    displayName: file.displayName,
    summary: `${file.origin === 'generated' ? '生成产物' : '用户附件'} · v${file.version} · ${formatBytes(file.byteSize)}`,
  }));
  const assistantEntries: ArtifactRailEntry[] = assistantArtifacts.map((file) => ({
    id: `assistant:${file.artifactId}`,
    kind: 'assistant',
    logicalPath: file.logicalPath,
    displayName: file.displayName,
    summary: `Markdown 回复 · ${formatBytes(file.byteSize)}`,
  }));
  return [...assistantEntries, ...taskEntries];
}

/** 仅将既有 logicalPath 投影为 UI 树，不读取或扫描路径所指向的文件系统。 */
export function projectArtifactRailTree(entries: readonly ArtifactRailEntry[]): readonly ArtifactRailTreeNode[] {
  const root = new Map<string, MutableTreeNode>();
  for (const entry of entries) {
    const segments = entry.logicalPath.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
    const safeSegments = segments.length ? segments : [entry.displayName];
    let level = root;
    let path = '';
    for (const [index, segment] of safeSegments.entries()) {
      path = path ? `${path}/${segment}` : segment;
      const isLeaf = index === safeSegments.length - 1;
      const key = isLeaf ? `${path}#${entry.id}` : path;
      let node = level.get(key);
      if (!node) {
        node = { id: key, name: isLeaf ? entry.displayName : segment, folder: !isLeaf, ...(isLeaf ? { entry } : {}), children: new Map() };
        level.set(key, node);
      }
      level = node.children;
    }
  }
  const freeze = (nodes: Map<string, MutableTreeNode>): readonly ArtifactRailTreeNode[] => [...nodes.values()]
    .sort((left, right) => Number(right.folder) - Number(left.folder) || left.name.localeCompare(right.name, 'zh-Hans-CN'))
    .map((node) => ({ id: node.id, name: node.name, folder: node.folder, ...(node.entry ? { entry: node.entry } : {}), children: freeze(node.children) }));
  return freeze(root);
}
