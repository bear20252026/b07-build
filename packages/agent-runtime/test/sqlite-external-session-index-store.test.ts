// 一个文件=一种作用：SQLite 外部会话索引账本的单元测试（临时目录，关闭重开验证持久化）。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  externalSessionContentIdentity,
  externalSessionIdentity,
  SqliteExternalSessionIndexStore,
  type ExternalSessionIndexRecord,
} from '../src/index.js';

function record(overrides: Partial<ExternalSessionIndexRecord> & { sessionId: string; sessionKey: string }): ExternalSessionIndexRecord {
  return {
    sourceId: 'ext-src',
    relativePath: 'a.jsonl',
    filePath: 'a.jsonl',
    status: 'indexed',
    contentDigest: 'd'.repeat(64),
    messageCount: 1,
    observedSizeBytes: 10,
    observedModifiedAtMs: 100,
    indexedAtMs: 1000,
    ...overrides,
  };
}

test('SQLite 账本：占位幂等、提交 upsert 只留一条、回滚不误删已提交记录、游标持久化', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-ext-session-store-'));
  const dbPath = join(root, 'index.sqlite');
  try {
    const sessionId = externalSessionIdentity('ext-src', 'a.jsonl');
    const store = new SqliteExternalSessionIndexStore(dbPath);

    // 占位幂等：第一次新建，第二次不覆盖。
    assert.equal(
      store.claim({ sessionId, sourceId: 'ext-src', relativePath: 'a.jsonl', filePath: 'a.jsonl', observedSizeBytes: 10, observedModifiedAtMs: 100, at: 1000 }),
      true,
    );
    assert.equal(
      store.claim({ sessionId, sourceId: 'ext-src', relativePath: 'a.jsonl', filePath: 'a.jsonl', observedSizeBytes: 10, observedModifiedAtMs: 100, at: 1000 }),
      false,
    );
    assert.equal(store.load(sessionId)?.status, 'indexing');

    // 占位可回滚（观测匹配）。
    store.rollback(sessionId, { sizeBytes: 10, modifiedAtMs: 100 });
    assert.equal(store.load(sessionId), undefined);

    // 提交后 upsert：同主键只留一条，内容身份随摘要变化。
    const first = record({ sessionId, sessionKey: externalSessionContentIdentity('ext-src', 'a.jsonl', 'd'.repeat(64)) });
    store.commit(first);
    assert.equal(store.list().length, 1);
    store.commit({ ...first, sessionKey: externalSessionContentIdentity('ext-src', 'a.jsonl', 'e'.repeat(64)), contentDigest: 'e'.repeat(64), messageCount: 5, observedSizeBytes: 20, observedModifiedAtMs: 200 });
    assert.equal(store.list().length, 1, 'upsert 不得新增第二条');
    assert.equal(store.load(sessionId)?.messageCount, 5);
    assert.equal(store.load(sessionId)?.observedModifiedAtMs, 200);

    // 回滚不得删除已提交记录（即便观测值匹配）。
    store.rollback(sessionId, { sizeBytes: 20, modifiedAtMs: 200 });
    assert.equal(store.load(sessionId)?.status, 'indexed');

    // 游标持久化。
    store.saveCursor({ sourceId: 'ext-src', watermarkMs: 1234, lastProcessedCount: 3, updatedAtMs: 2000 });
    assert.deepEqual(store.loadCursor('ext-src'), { sourceId: 'ext-src', watermarkMs: 1234, lastProcessedCount: 3, updatedAtMs: 2000 });
    store.saveCursor({ sourceId: 'ext-src', watermarkMs: 4321, lastProcessedCount: 4, updatedAtMs: 3000 });
    assert.equal(store.loadCursor('ext-src')?.watermarkMs, 4321);
    assert.equal(store.loadCursor('missing'), undefined);
    store.close();

    // 关闭重开后记录与游标仍在。
    const reopened = new SqliteExternalSessionIndexStore(dbPath);
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.load(sessionId)?.messageCount, 5);
    assert.equal(reopened.loadCursor('ext-src')?.lastProcessedCount, 4);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
