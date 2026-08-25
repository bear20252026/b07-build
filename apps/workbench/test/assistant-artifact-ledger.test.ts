import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantArtifactFileName, loadAssistantArtifacts, persistAssistantArtifacts } from '../src/runtime/assistant-artifact-ledger';
import { projectArtifactRailEntries, projectArtifactRailTree } from '../src/components/preview/artifact-extension-projection';

test('本地 AI 回复产物账本只接受受限 Markdown 元数据并按新到旧排序', () => {
  const storage = new Map<string, string>();
  const fakeStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) };
  const entries = persistAssistantArtifacts([
    { artifactId: 'older', logicalPath: 'assistant-replies/ai-reply-older.md', displayName: 'ai-reply-older.md', byteSize: 12, createdAt: 1, target: 'app-managed' },
    { artifactId: 'newer', logicalPath: 'assistant-replies/ai-reply-newer.md', displayName: 'ai-reply-newer.md', byteSize: 24, createdAt: 2, target: 'selected-workspace' },
    { artifactId: 'bad', logicalPath: '../outside.md', displayName: 'outside.md', byteSize: 12, createdAt: 3, target: 'app-managed' },
  ], fakeStorage);
  assert.deepEqual(entries.map((entry) => entry.artifactId), ['newer', 'older']);
  assert.deepEqual(loadAssistantArtifacts(fakeStorage).map((entry) => entry.artifactId), ['newer', 'older']);
  assert.match(assistantArtifactFileName(Date.UTC(2026, 7, 24, 12, 30, 0, 123)), /^ai-reply-20260824T123000\.123Z\.md$/);
});

test('右侧产物树仅合并既有任务回执与显式保存的本地回复', () => {
  const entries = projectArtifactRailEntries([{
    schemaVersion: 1, taskFileId: 'task-file', taskId: 'task', runId: 'run', artifactLedgerId: 'ledger', logicalPath: 'reports/summary.md', displayName: 'summary.md', mediaType: 'text/markdown', byteSize: 90, sha256: 'hash', version: 1, createdAt: 1, status: 'available', origin: 'generated', containsSensitiveContent: false, canExecute: false,
  }], [{ artifactId: 'reply', logicalPath: 'assistant-replies/ai-reply-x.md', displayName: 'ai-reply-x.md', byteSize: 30, createdAt: 2, target: 'app-managed' }]);
  assert.deepEqual(entries.map((entry) => entry.id), ['assistant:reply', 'task:task-file']);
  const tree = projectArtifactRailTree(entries);
  assert.deepEqual(tree.map((node) => node.name), ['已保存 Markdown', '任务 / 运行记录']);
  assert.equal(tree[0]?.children[0]?.children[0]?.children[0]?.entry?.displayName, 'ai-reply-x.md');
  assert.equal(tree[1]?.children[0]?.children[0]?.children[0]?.children[0]?.entry?.displayName, 'summary.md');
});
