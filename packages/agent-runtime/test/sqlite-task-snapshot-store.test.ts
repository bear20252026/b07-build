import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteTaskSnapshotStore, type LocalTaskSnapshot } from '../src/index.js';

function snapshot(overrides: Partial<LocalTaskSnapshot> = {}): LocalTaskSnapshot {
  return {
    schemaVersion: 1,
    taskId: 'task-sqlite',
    runId: 'run-sqlite',
    profileId: 'build',
    status: 'running',
    nodeOutcomes: { parse: 'ok' },
    stats: {
      totalNodes: 2,
      startedNodes: 1,
      completedNodes: 1,
      failedNodes: 0,
      blockedNodes: 0,
      maxObservedConcurrency: 1,
    },
    attempt: 1,
    updatedAt: 100,
    ...overrides,
  };
}

test('SQLite 快照存储追加历史、恢复最新版本且不暴露内部可变引用', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-snapshots-'));
  const filePath = join(directory, 'state', 'tasks.sqlite');
  const store = new SqliteTaskSnapshotStore(filePath);
  store.save(snapshot());
  store.save(snapshot({
    status: 'blocked',
    nodeOutcomes: { parse: 'ok', write: 'blocked' },
    attempt: 2,
    updatedAt: 200,
  }));

  const history = store.history('task-sqlite', 'run-sqlite');
  assert.equal(history.length, 2);
  assert.equal(history[0]?.status, 'running');
  assert.equal(history[1]?.status, 'blocked');
  const latest = store.load('task-sqlite', 'run-sqlite');
  assert.equal(latest?.updatedAt, 200);
  if (latest) {
    const mutableLatest = latest as unknown as { nodeOutcomes: Record<string, 'ok' | 'failed' | 'blocked'> };
    mutableLatest.nodeOutcomes.write = 'ok';
  }
  assert.equal(store.load('task-sqlite', 'run-sqlite')?.nodeOutcomes.write, 'blocked');
  store.close();

  const reopened = new SqliteTaskSnapshotStore(filePath);
  assert.equal(reopened.load('task-sqlite', 'run-sqlite')?.status, 'blocked');
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});
