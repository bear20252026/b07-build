import test from 'node:test';
import assert from 'node:assert/strict';
import { projectArtifactRailEntries, projectArtifactRailTree } from '../src/components/preview/artifact-extension-projection';

const taskFile = {
  schemaVersion: 1 as const,
  taskFileId: 'file-1',
  taskId: 'task-20260825',
  runId: 'run-001',
  artifactLedgerId: 'ledger-1',
  logicalPath: 'reports/summary.md',
  displayName: 'summary.md',
  mediaType: 'text/markdown' as const,
  byteSize: 512,
  sha256: 'a'.repeat(64),
  version: 1,
  createdAt: 30,
  status: 'available' as const,
  origin: 'generated' as const,
  containsSensitiveContent: false as const,
  canExecute: false as const,
};

test('右侧投影将已保存 Markdown 与任务／运行产物拆分为稳定可展开历史分组', () => {
  const entries = projectArtifactRailEntries([taskFile], [{ artifactId: 'reply-1', logicalPath: 'assistant-replies/ai-reply-20260825.md', displayName: 'ai-reply-20260825.md', byteSize: 128, createdAt: 40, target: 'app-managed' }]);
  assert.deepEqual(entries.map((entry) => entry.id), ['assistant:reply-1', 'task:file-1']);
  const tree = projectArtifactRailTree(entries);
  assert.deepEqual(tree.map((node) => node.name), ['已保存 Markdown', '任务 / 运行记录']);
  assert.equal(tree[0]?.children[0]?.name, '回复历史');
  assert.equal(tree[1]?.children[0]?.name, '任务 task-20260825');
  assert.equal(tree[1]?.children[0]?.children[0]?.name, '运行 run-001');
});

test('产物树仅使用已给定 metadata；不把危险逻辑路径投影为目录遍历', () => {
  const entries = projectArtifactRailEntries([], [{ artifactId: 'reply-2', logicalPath: 'assistant-replies/ai-reply-20260826.md', displayName: 'ai-reply-20260826.md', byteSize: 128, createdAt: 50, target: 'app-managed' }]);
  const tree = projectArtifactRailTree(entries);
  assert.equal(tree[0]?.children[0]?.children[0]?.children[0]?.entry?.logicalPath, 'assistant-replies/ai-reply-20260826.md');
});
