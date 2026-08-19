import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContextAssembler,
  InMemoryMemoryLedgerStore,
  MemoryLedger,
} from '../src/index.js';

const durableScope = {
  agentId: 'personal',
  workspaceId: 'b07-build',
  sessionId: 'session-001',
  path: 'learning/agent-runtime',
  sessionPersistence: 'durable' as const,
};

const durableSession = { ...durableScope, persistence: 'durable' as const };

const provenance = {
  sourceType: 'session' as const,
  sourceId: 'session-001',
  trust: 'trusted_local' as const,
  citations: ['session://session-001'],
};

function createLedger(): MemoryLedger {
  const ledger = new MemoryLedger(new InMemoryMemoryLedgerStore());
  ledger.addCandidate({
    id: 'memory-preference', kind: 'preference', scope: durableScope,
    content: '偏好本地优先和 TypeScript。', estimatedTokens: 2, provenance, at: 10,
  });
  ledger.addCandidate({
    id: 'memory-decision', kind: 'decision', scope: durableScope,
    content: '写入动作必须通过明确审批。', estimatedTokens: 3, provenance, at: 11,
  });
  ledger.confirm('memory-preference', 12);
  ledger.confirm('memory-decision', 13);
  return ledger;
}

test('L0–L4 按固定层序装配，记忆独立预算且每项带可审查出处', () => {
  const ledger = createLedger();
  const assembler = new ContextAssembler(ledger);
  const result = assembler.assemble({
    taskId: 'task-0001', runId: 'run-0001', at: 100, query: 'TypeScript 审批',
    session: durableSession,
    maxTokens: 14, maxPreferenceTokens: 2, maxDurableMemoryTokens: 3,
    currentTurn: [{ id: 'turn-001', content: '实现受控上下文。', estimatedTokens: 2 }],
    workingSet: [{ id: 'work-001', content: '当前仅能修改运行时。', estimatedTokens: 3 }],
    knowledge: [{ id: 'knowledge-001', content: '知识引用内容。', estimatedTokens: 4, citations: ['knowledge://doc-1#chunk-1'] }],
    archive: [{ id: 'archive-001', content: '旧检查点。', estimatedTokens: 4 }],
  });

  assert.deepEqual(result.injections.map((item) => item.layer), [
    'L0_current_turn', 'L1_session_working_set', 'L2_durable_memory', 'L2_durable_memory', 'L3_knowledge',
  ]);
  assert.deepEqual(result.injections.map((item) => item.id), [
    'turn-001', 'work-001', 'memory:memory-preference@2', 'memory:memory-decision@2', 'knowledge-001',
  ]);
  assert.deepEqual(result.injections.at(-1)?.citations, ['knowledge://doc-1#chunk-1']);
  assert.equal(result.memory?.preferenceTokens, 2);
  assert.equal(result.memory?.otherTokens, 3);
  assert.equal(result.requiresCompactionPreparation, true);
  assert.deepEqual(result.omissions, [{ id: 'archive-001', layer: 'L4_archive', reason: 'budget_exceeded' }]);

  const rejected = assembler.prepareCompaction(result, durableSession, {
    candidate: {
      id: 'candidate-missing-coverage', kind: 'working_note', scope: durableScope,
      content: '应保留原状态。', estimatedTokens: 2, provenance, at: 101,
    },
    coveredItemIds: [],
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(ledger.get('candidate-missing-coverage'), undefined);

  const prepared = assembler.prepareCompaction(result, durableSession, {
    candidate: {
      id: 'candidate-archive-summary', kind: 'working_note', scope: durableScope,
      content: '旧检查点摘要已被审查候选承接。', estimatedTokens: 3, provenance, at: 102,
    },
    coveredItemIds: ['archive-001'],
  });
  assert.deepEqual(prepared, {
    status: 'prepared_candidate', candidateId: 'candidate-archive-summary', preservedWorkingSetIds: ['work-001'],
  });
  assert.equal(ledger.get('candidate-archive-summary')?.status, 'candidate');
});

test('incognito 装配仅使用当前轮和内存工作集，且压缩不写入持久记忆', () => {
  const ledger = createLedger();
  const assembler = new ContextAssembler(ledger);
  const session = { ...durableScope, sessionId: 'session-incognito', persistence: 'incognito' as const };
  const result = assembler.assemble({
    taskId: 'task-0002', runId: 'run-0002', at: 200, query: '本地优先', session,
    maxTokens: 1, maxPreferenceTokens: 2, maxDurableMemoryTokens: 3,
    currentTurn: [{ id: 'turn-002', content: '私密问题。', estimatedTokens: 1 }],
    workingSet: [{ id: 'work-002', content: '临时工作集。', estimatedTokens: 2 }],
    knowledge: [{ id: 'knowledge-002', content: '不得读取的本地知识。', estimatedTokens: 2 }],
    archive: [{ id: 'archive-002', content: '不得读取的历史。', estimatedTokens: 2 }],
  });

  assert.deepEqual(result.injections.map((item) => item.layer), ['L0_current_turn']);
  assert.equal(result.memory, undefined);
  assert.deepEqual(result.omissions, [
    { id: 'work-002', layer: 'L1_session_working_set', reason: 'budget_exceeded' },
    { id: 'knowledge-002', layer: 'L3_knowledge', reason: 'incognito_isolation' },
    { id: 'archive-002', layer: 'L4_archive', reason: 'incognito_isolation' },
  ]);
  assert.equal(result.requiresCompactionPreparation, true);
  assert.deepEqual(assembler.prepareCompaction(result, session), {
    status: 'skipped_incognito', preservedWorkingSetIds: [],
  });
  assert.equal(ledger.list().length, 2);
});

test('L0 当前轮不能被总预算静默丢弃', () => {
  const assembler = new ContextAssembler(createLedger());
  assert.throws(() => assembler.assemble({
    taskId: 'task-0003', runId: 'run-0003', at: 300, query: '测试',
    session: durableSession,
    maxTokens: 1, maxPreferenceTokens: 0, maxDurableMemoryTokens: 0,
    currentTurn: [{ id: 'turn-too-large', content: '不能静默裁剪。', estimatedTokens: 2 }],
  }), /L0 当前轮/);
});
