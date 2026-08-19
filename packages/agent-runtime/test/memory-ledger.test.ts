import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  InMemoryMemoryLedgerStore,
  MemoryLedger,
  SqliteMemoryLedgerStore,
} from '../src/index.js';

const scope = {
  agentId: 'personal',
  workspaceId: 'b07-build',
  path: 'learning/agent-runtime',
  sessionPersistence: 'durable' as const,
};

const provenance = {
  sourceType: 'user' as const,
  sourceId: 'user-1',
  trust: 'user_confirmed' as const,
  citations: ['user://preference/1'],
};

function ledger(): MemoryLedger {
  return new MemoryLedger(new InMemoryMemoryLedgerStore());
}

test('候选记忆不会进入上下文，确认后才按独立 preference 预算选择', () => {
  const runtime = ledger();
  runtime.addCandidate({
    id: 'memory-preference',
    kind: 'preference',
    scope,
    content: '我偏好 TypeScript 和本地优先设计。',
    estimatedTokens: 5,
    provenance,
    at: 100,
  });
  runtime.addCandidate({
    id: 'memory-decision',
    kind: 'decision',
    scope,
    content: '任务写入必须经过审批与预算。',
    estimatedTokens: 6,
    provenance,
    at: 101,
  });

  assert.deepEqual(runtime.selectForContext({
    agentId: 'personal', workspaceId: 'b07-build', query: 'TypeScript', at: 110,
    maxPreferenceTokens: 10, maxOtherTokens: 10,
  }).preferences, []);

  runtime.confirm('memory-preference', 120);
  runtime.confirm('memory-decision', 121);
  const selected = runtime.selectForContext({
    agentId: 'personal', workspaceId: 'b07-build', query: 'TypeScript 审批', at: 130,
    maxPreferenceTokens: 5, maxOtherTokens: 6,
  });

  assert.equal(selected.preferences.length, 1);
  assert.equal(selected.otherMemories.length, 1);
  assert.equal(selected.preferences[0]?.record.id, 'memory-preference');
  assert.equal(selected.otherMemories[0]?.record.id, 'memory-decision');
  assert.equal(selected.otherMemories[0]?.canAuthorize, false);
  assert.deepEqual(selected.preferences[0]?.record.provenance.citations, ['user://preference/1']);
});

test('跨 workspace、过期和 session 范围的 confirmed 记忆不会越界注入', () => {
  const runtime = ledger();
  runtime.addCandidate({
    id: 'memory-session', kind: 'working_note',
    scope: { ...scope, sessionId: 'session-a' }, content: '只适用于当前会话。', estimatedTokens: 2,
    provenance, at: 100,
  });
  runtime.addCandidate({
    id: 'memory-expired', kind: 'durable_fact',
    scope, content: '已经过期的事实。', estimatedTokens: 2,
    provenance, at: 100, expiresAt: 110,
  });
  runtime.addCandidate({
    id: 'memory-other-workspace', kind: 'durable_fact',
    scope: { ...scope, workspaceId: 'other-workspace' }, content: '其他项目事实。', estimatedTokens: 2,
    provenance, at: 100,
  });
  runtime.confirm('memory-session', 101);
  runtime.confirm('memory-expired', 101);
  runtime.confirm('memory-other-workspace', 101);

  const current = runtime.selectForContext({
    agentId: 'personal', workspaceId: 'b07-build', sessionId: 'session-a', query: '会话', at: 120,
    maxPreferenceTokens: 10, maxOtherTokens: 10,
  });
  assert.deepEqual(current.otherMemories.map((entry) => entry.record.id), ['memory-session']);

  const another = runtime.selectForContext({
    agentId: 'personal', workspaceId: 'b07-build', sessionId: 'session-b', query: '会话', at: 120,
    maxPreferenceTokens: 10, maxOtherTokens: 10,
  });
  assert.equal(another.otherMemories.length, 0);
});

test('incognito 会话禁止持久记忆，retract 使用 append-only revision 且不覆盖历史', () => {
  const runtime = ledger();
  assert.throws(() => runtime.addCandidate({
    id: 'memory-incognito', kind: 'working_note',
    scope: { ...scope, sessionPersistence: 'incognito' }, content: '不应保存。', estimatedTokens: 1,
    provenance, at: 100,
  }), /incognito/);

  runtime.addCandidate({
    id: 'memory-retract', kind: 'pending_intent', scope,
    content: '迁移完成前不得修改 API。', estimatedTokens: 4, provenance, at: 100,
  });
  const confirmed = runtime.confirm('memory-retract', 110);
  const retracted = runtime.retract('memory-retract', 120);
  assert.equal(confirmed.revision, 2);
  assert.equal(retracted.revision, 3);
  assert.equal(runtime.selectForContext({
    agentId: 'personal', workspaceId: 'b07-build', query: '迁移', at: 130,
    maxPreferenceTokens: 10, maxOtherTokens: 10,
  }).otherMemories.length, 0);
});

test('SQLite ledger 追加 revision、持久化 provenance 并提供不可变历史', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-memory-ledger-'));
  const filePath = join(directory, 'memory.sqlite');
  try {
    const store = new SqliteMemoryLedgerStore(filePath);
    const runtime = new MemoryLedger(store);
    runtime.addCandidate({
      id: 'memory-sqlite', kind: 'durable_fact', scope,
      content: 'SQLite ledger 是 append-only。', estimatedTokens: 5, provenance, at: 100,
    });
    const confirmed = runtime.confirm('memory-sqlite', 110);
    const history = store.history('memory-sqlite');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.status, 'candidate');
    assert.equal(history[1]?.status, 'confirmed');
    assert.equal(new SqliteMemoryLedgerStore(filePath).load('memory-sqlite')?.revision, confirmed.revision);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
