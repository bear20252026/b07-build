// 一个文件=一种作用：profile 落 memory-ledger 存储的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryMemoryLedgerStore,
  MemoryLedger,
  MemoryLedgerSubagentProfileStore,
  createBuiltInExploreProfile,
  type SubagentProfile,
} from '../src/index.js';

function reviewerProfile(): SubagentProfile {
  return {
    name: 'reviewer',
    description: '审查代码',
    source: 'user',
    systemPrompt: '你是审查者。',
    color: 'purple',
    tools: ['Read', 'Grep'],
  };
}

test('profile 落账：save 后可 list 还原，字段往返一致', () => {
  const ledger = new MemoryLedger(new InMemoryMemoryLedgerStore());
  const store = new MemoryLedgerSubagentProfileStore(ledger);
  const record = store.save(reviewerProfile(), { workspaceId: 'ws-1', at: 100 });

  assert.equal(record.status, 'confirmed');
  assert.equal(record.kind, 'durable_fact');
  assert.deepEqual(store.list({ workspaceId: 'ws-1' }), [reviewerProfile()]);
  assert.deepEqual(store.list({ workspaceId: 'ws-2' }), [], '按工作区隔离');
});

test('内容变更追加新修订并 supersede 旧记录，历史保留', () => {
  const ledger = new MemoryLedger(new InMemoryMemoryLedgerStore());
  const store = new MemoryLedgerSubagentProfileStore(ledger);
  store.save(reviewerProfile(), { workspaceId: 'ws-1', at: 100 });
  store.save({ ...reviewerProfile(), description: '审查代码（已更新）' }, { workspaceId: 'ws-1', at: 200 });

  const records = ledger.list();
  assert.equal(records.length, 2, '两条逻辑记录：一条已 supersede，一条 confirmed');
  assert.equal(records.filter((item) => item.status === 'superseded').length, 1);
  assert.equal(store.list({ workspaceId: 'ws-1' })[0]?.description, '审查代码（已更新）');
});

test('相同内容重复 save 幂等，不产生新修订', () => {
  const ledger = new MemoryLedger(new InMemoryMemoryLedgerStore());
  const store = new MemoryLedgerSubagentProfileStore(ledger);
  store.save(reviewerProfile(), { workspaceId: 'ws-1', at: 100 });
  store.save(reviewerProfile(), { workspaceId: 'ws-1', at: 300 });
  assert.equal(ledger.list().length, 1);
});

test('内置 profile 不落账：它们是代码常量而非用户事实', () => {
  const store = new MemoryLedgerSubagentProfileStore(new MemoryLedger(new InMemoryMemoryLedgerStore()));
  assert.throws(
    () => store.save(createBuiltInExploreProfile(), { workspaceId: 'ws-1', at: 100 }),
    /内置 profile 不落账/u,
  );
});
