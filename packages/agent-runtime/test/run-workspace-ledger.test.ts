import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TaskEvent } from '@awo/protocol';
import {
  InMemoryRunWorkspaceLedgerStore,
  RunWorkspaceLedger,
  SqliteRunWorkspaceLedgerStore,
  type LocalTaskSnapshot,
} from '../src/index.js';

function snapshot(status: LocalTaskSnapshot['status'] = 'blocked', attempt = 1): LocalTaskSnapshot {
  return {
    schemaVersion: 1, taskId: 'task-1', runId: 'run-1', profileId: 'build', authorityMode: 'review',
    inputProvenance: [], status, nodeOutcomes: { understand: 'ok', deliver: 'blocked' }, attempt, updatedAt: 30,
  };
}

function toolResult(outputRef = 'local://task/task-1/inspect', eventId = 'event-tool-result-1'): TaskEvent {
  return {
    protocolVersion: '1.0', eventId, taskId: 'task-1', runId: 'run-1', at: 20,
    type: 'tool.result', callId: 'inspect', status: 'ok', outputRef,
  };
}

test('Run Workspace Ledger 只登记允许的受控 output reference，拒绝任意路径与 URI', () => {
  const ledger = new RunWorkspaceLedger(new InMemoryRunWorkspaceLedgerStore());
  const artifact = ledger.recordTaskEvent(toolResult());
  assert.equal(artifact?.reference, 'local://task/task-1/inspect');
  assert.equal(artifact?.kind, 'tool-output');
  assert.equal(artifact?.containsSensitiveContent, false);
  assert.equal(artifact?.canReplaySideEffects, false);
  assert.equal(artifact?.referenceDigest.length, 64);
  assert.equal(ledger.recordTaskEvent(toolResult())?.artifactLedgerId, artifact?.artifactLedgerId);
  assert.equal(ledger.recordTaskEvent(toolResult('file:///private/api-key.txt', 'event-tool-result-invalid')), undefined);
  assert.equal(ledger.listArtifacts('task-1', 'run-1').length, 1);
});

test('Run Workspace Ledger 对 artifact.created 丢弃 path 与 mime，只保存 artifact ID 派生引用', () => {
  const ledger = new RunWorkspaceLedger(new InMemoryRunWorkspaceLedgerStore());
  const event: TaskEvent = {
    protocolVersion: '1.0', eventId: 'event-artifact-1', taskId: 'task-1', runId: 'run-1', at: 21,
    type: 'artifact.created', artifactId: 'report-1', mime: 'text/plain', path: 'C:\\Users\\private\\secret-report.txt',
  };
  const artifact = ledger.recordTaskEvent(event);
  assert.equal(artifact?.reference, 'artifact://report-1');
  assert.equal(JSON.stringify(artifact).includes('secret-report'), false);
  assert.equal(JSON.stringify(artifact).includes('text/plain'), false);
});

test('Run Workspace Ledger 为任务快照生成不可复放检查点，并保持同 attempt 幂等', () => {
  const ledger = new RunWorkspaceLedger(new InMemoryRunWorkspaceLedgerStore());
  ledger.recordTaskEvent(toolResult());
  const first = ledger.recordCheckpoint(snapshot(), true);
  const replayed = ledger.recordCheckpoint(snapshot(), true);
  assert.equal(first.checkpointId, 'checkpoint:task-1:run-1:1');
  assert.equal(first.artifactCount, 1);
  assert.equal(first.canResume, true);
  assert.equal(first.canReplaySideEffects, false);
  assert.equal(first.nodeOutcomeDigest.length, 64);
  assert.equal(first.artifactManifestDigest.length, 64);
  assert.deepEqual(replayed, first);
  assert.equal(ledger.listCheckpoints('task-1', 'run-1').length, 1);
});

test('SQLite Run Workspace Ledger 可重开审查且防御性复制 metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-workspace-ledger-'));
  const filePath = join(directory, 'workspace-ledger.sqlite');
  const firstStore = new SqliteRunWorkspaceLedgerStore(filePath);
  const firstLedger = new RunWorkspaceLedger(firstStore);
  firstLedger.recordTaskEvent(toolResult());
  firstLedger.recordCheckpoint(snapshot('failed', 1), true);
  const listed = firstLedger.listArtifacts('task-1', 'run-1');
  (listed[0] as { reference: string }).reference = 'artifact://mutated';
  assert.equal(firstLedger.listArtifacts('task-1', 'run-1')[0]?.reference, 'local://task/task-1/inspect');
  firstStore.close();

  const reopenedStore = new SqliteRunWorkspaceLedgerStore(filePath);
  const reopenedLedger = new RunWorkspaceLedger(reopenedStore);
  assert.equal(reopenedLedger.listArtifacts('task-1', 'run-1')[0]?.referenceDigest.length, 64);
  assert.equal(reopenedLedger.listCheckpoints('task-1', 'run-1')[0]?.canResume, true);
  reopenedStore.close();
  rmSync(directory, { recursive: true, force: true });
});


test('Run Workspace Ledger 将 source event 幂等范围限定为 task/run，避免不同运行相互抑制', () => {
  const ledger = new RunWorkspaceLedger(new InMemoryRunWorkspaceLedgerStore());
  const first = ledger.recordTaskEvent(toolResult());
  const second = ledger.recordTaskEvent({ ...toolResult(), runId: 'run-2' });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.artifactLedgerId, second.artifactLedgerId);
  assert.equal(ledger.listArtifacts('task-1', 'run-1').length, 1);
  assert.equal(ledger.listArtifacts('task-1', 'run-2').length, 1);
});
