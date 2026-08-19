import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  InMemoryTaskCommandReceiptStore,
  SqliteTaskCommandReceiptStore,
  type TaskCommandReceipt,
} from '../src/index.js';

const receipt: TaskCommandReceipt = {
  schemaVersion: 1,
  command: 'submit',
  idempotencyKey: 'submit-key-0001',
  fingerprint: 'v1:goal:build',
  taskId: 'task-0001',
  runId: 'run-0001',
  goal: '验证幂等任务提交',
  profileId: 'build',
  acceptedAt: 100,
};

const snapshot = {
  schemaVersion: 1 as const,
  taskId: 'task-0001',
  runId: 'run-0001',
  profileId: 'build' as const,
  status: 'completed' as const,
  nodeOutcomes: { understand: 'ok' as const },
  attempt: 1,
  updatedAt: 110,
};

test('相同命令与意图指纹稳定重放，不同指纹复用幂等键会被拒绝', () => {
  const store = new InMemoryTaskCommandReceiptStore();
  assert.equal(store.claim(receipt).kind, 'claimed');
  const replay = store.claim({ ...receipt, acceptedAt: 101 });
  assert.equal(replay.kind, 'replayed');
  assert.equal(replay.receipt.taskId, 'task-0001');
  assert.throws(() => store.claim({ ...receipt, fingerprint: 'v1:other-goal' }), /不同/);
});

test('完成收据保存防御性快照，调用方不能篡改缓存结果', () => {
  const store = new InMemoryTaskCommandReceiptStore();
  store.claim(receipt);
  const completed = store.complete('submit', receipt.idempotencyKey, snapshot, 110);
  assert.equal(completed.completedAt, 110);
  const mutableReturnedOutcomes = completed.snapshot?.nodeOutcomes as { understand: string };
  mutableReturnedOutcomes.understand = 'failed';
  assert.equal(store.get('submit', receipt.idempotencyKey)?.snapshot?.nodeOutcomes.understand, 'ok');
});

test('SQLite 收据保留 claim 与 complete 历史，并能在重开后安全重放', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-command-receipts-'));
  const filePath = join(directory, 'receipts.sqlite');
  try {
    const store = new SqliteTaskCommandReceiptStore(filePath);
    store.claim(receipt);
    store.complete('submit', receipt.idempotencyKey, snapshot, 110);
    assert.equal(store.history('submit', receipt.idempotencyKey).length, 2);
    store.close();

    const reopened = new SqliteTaskCommandReceiptStore(filePath);
    const replay = reopened.claim({ ...receipt, acceptedAt: 111 });
    assert.equal(replay.kind, 'replayed');
    assert.equal(replay.receipt.snapshot?.updatedAt, 110);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
