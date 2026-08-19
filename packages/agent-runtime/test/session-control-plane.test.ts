import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  InMemorySessionSnapshotStore,
  LocalSessionControlPlane,
  SessionVersionConflictError,
  SqliteSessionSnapshotStore,
} from '../src/index.js';

const durableScope = {
  agentId: 'personal',
  workspaceId: 'b07-build',
  sourceKind: 'workbench' as const,
  sourceId: 'main',
  persistence: 'durable' as const,
};

function createPlane(): LocalSessionControlPlane {
  return new LocalSessionControlPlane(new InMemorySessionSnapshotStore());
}

test('durable 会话会追加版本并在新的控制面实例中恢复', () => {
  const store = new InMemorySessionSnapshotStore();
  const first = new LocalSessionControlPlane(store);
  const created = first.create({ sessionId: 'session-1', scope: durableScope, at: 100, title: '设计会话' });
  const touched = first.touch({ sessionId: created.sessionId, at: 150, expectedStateVersion: 1 });

  const restored = new LocalSessionControlPlane(store).get('session-1');
  assert.deepEqual(restored, touched);
  assert.equal(restored?.lastInteractionAt, 150);
  assert.equal(restored?.stateVersion, 2);
});

test('ephemeral 和 incognito 会话不写入 durable store，且 incognito 仍在当前控制面可见', () => {
  const store = new InMemorySessionSnapshotStore();
  const plane = new LocalSessionControlPlane(store);
  plane.create({
    sessionId: 'ephemeral-1',
    scope: { ...durableScope, sourceId: 'ephemeral', persistence: 'ephemeral' },
    at: 100,
  });
  const incognito = plane.create({
    sessionId: 'incognito-1',
    scope: { ...durableScope, sourceId: 'incognito', persistence: 'incognito' },
    at: 101,
  });

  assert.equal(store.list().length, 0);
  assert.equal(plane.get(incognito.sessionId)?.scope.persistence, 'incognito');
  assert.equal(new LocalSessionControlPlane(store).get('incognito-1'), undefined);
});

test('会话 mutation 使用 stateVersion 防止陈旧客户端覆盖最新状态', () => {
  const plane = createPlane();
  plane.create({ sessionId: 'session-2', scope: durableScope, at: 100 });
  const pinned = plane.pin({ sessionId: 'session-2', at: 120, expectedStateVersion: 1 }, true);
  assert.equal(pinned.stateVersion, 2);

  assert.throws(
    () => plane.archive({ sessionId: 'session-2', at: 130, expectedStateVersion: 1 }),
    SessionVersionConflictError,
  );
  assert.equal(plane.get('session-2')?.status, 'active');
});

test('reset 归档旧会话并以相同 scope 创建独立的新 durable 会话', () => {
  const plane = createPlane();
  plane.create({ sessionId: 'session-3', scope: durableScope, at: 100, title: '学习路线' });
  const next = plane.reset({ sessionId: 'session-3', nextSessionId: 'session-4', at: 200, expectedStateVersion: 1 });

  assert.equal(plane.get('session-3')?.status, 'archived');
  assert.equal(plane.get('session-3')?.stateVersion, 2);
  assert.equal(next.status, 'active');
  assert.equal(next.stateVersion, 1);
  assert.equal(next.scope.workspaceId, 'b07-build');
  assert.equal(next.title, '学习路线');
});

test('SQLite session store 追加 durable 历史、保持 immutable 副本并拒绝 transient 写入', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-session-store-'));
  const filePath = join(directory, 'sessions.sqlite');
  try {
    const store = new SqliteSessionSnapshotStore(filePath);
    const plane = new LocalSessionControlPlane(store);
    plane.create({ sessionId: 'session-5', scope: durableScope, at: 100 });
    const touched = plane.touch({ sessionId: 'session-5', at: 200, expectedStateVersion: 1 });
    const history = store.history('session-5');

    assert.equal(history.length, 2);
    assert.equal(history[0]?.stateVersion, 1);
    assert.equal(history[1]?.stateVersion, 2);
    assert.deepEqual(new SqliteSessionSnapshotStore(filePath).list(), [touched]);
    assert.throws(() => store.save({ ...touched, scope: { ...touched.scope, persistence: 'incognito' } }));
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
