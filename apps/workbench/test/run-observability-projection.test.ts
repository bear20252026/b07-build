import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunObservabilityProjection } from '../src/components/observability/run-observability-projection.js';

const snapshot = { schemaVersion: 1, taskId: 'task-one', runId: 'run-one', profileId: 'build' as const, authorityMode: 'review' as const, status: 'failed' as const, nodeOutcomes: { execute: 'failed' as const }, attempt: 1, updatedAt: 1 };
const event = { schemaVersion: 1, trajectoryEventId: 'trajectory-one', taskId: 'task-one', runId: 'run-one', sequence: 1, at: 1, source: 'task-runtime' as const, kind: 'node.failed', attributes: {}, canReplaySideEffects: false };

test('可观测性投影把可恢复检查点显示为明确用户意图，而不是自动重放能力', () => {
  const result = createRunObservabilityProjection({ snapshot, events: [event], checkpoints: [{ schemaVersion: 1, checkpointId: 'checkpoint-one', taskId: 'task-one', runId: 'run-one', attempt: 1, status: 'failed', nodeOutcomeDigest: 'a'.repeat(64), artifactManifestDigest: 'b'.repeat(64), artifactCount: 0, createdAt: 1, canResume: true }] });
  assert.equal(result.recoveryState, 'available');
  assert.match(result.summary, /用户明确/);
  assert.equal(result.lastSequence, 1);
});

test('阻塞状态始终优先表述为人工审批，不受检查点数量影响', () => {
  const result = createRunObservabilityProjection({ snapshot: { ...snapshot, status: 'blocked', nodeOutcomes: { approve: 'blocked' } }, events: [], checkpoints: [] });
  assert.equal(result.recoveryState, 'blocked');
  assert.match(result.summary, /人工确认/);
});
