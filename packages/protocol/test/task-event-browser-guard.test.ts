import assert from 'node:assert/strict';
import test from 'node:test';
import { isBrowserTaskEvent } from '../src/task-event-browser-guard.js';

const envelope = {
  protocolVersion: '1.0',
  eventId: 'event-1',
  taskId: 'task-1',
  runId: 'run-1',
  at: 1_728_000_000_000,
};

test('浏览器事件守卫接受完整的已验证事件摘要', () => {
  assert.equal(isBrowserTaskEvent({
    ...envelope,
    type: 'tool.called',
    callId: 'call-1',
    inputHash: 'sha256:abc',
    tool: { name: 'search', args: { query: 'local-first' }, capability: 'network.fetch', risk: 'medium' },
  }), true);
  assert.equal(isBrowserTaskEvent({
    ...envelope,
    type: 'input.provenance.recorded',
    provenance: [{ inputId: 'input-1', digest: 'sha256:def', trust: 'external-untrusted', sourceKind: 'web' }],
  }), true);
});

test('浏览器事件守卫拒绝不完整、未知或越界事件，且不授予任何执行能力', () => {
  assert.equal(isBrowserTaskEvent({ ...envelope, type: 'task.created' }), false);
  assert.equal(isBrowserTaskEvent({ ...envelope, type: 'agent.profile.selected', profileId: 'admin-root' }), false);
  assert.equal(isBrowserTaskEvent({ ...envelope, type: 'tool.called', callId: 'call-1', inputHash: 'sha256:abc', tool: { name: 'run', args: {}, capability: 'shell.root', risk: 'high' } }), false);
  assert.equal(isBrowserTaskEvent({ ...envelope, type: 'unknown.event' }), false);
});
