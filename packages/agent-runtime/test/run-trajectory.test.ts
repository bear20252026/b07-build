import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TaskEvent } from '@awo/protocol';
import {
  InMemoryRunTrajectoryStore,
  RunTrajectoryLedger,
  SqliteRunTrajectoryStore,
} from '../src/index.js';

function createdEvent(): TaskEvent {
  return {
    protocolVersion: '1.0',
    eventId: 'event-created-1',
    taskId: 'task-1',
    runId: 'run-1',
    at: 10,
    type: 'task.created',
    goal: '绝不能进入 trajectory 的私密任务目标',
  };
}

test('Run Trajectory 对 Task Event 进行脱敏 append-only 投影，并允许同 source event 幂等重放', () => {
  const ledger = new RunTrajectoryLedger(new InMemoryRunTrajectoryStore());
  const first = ledger.recordTaskEvent(createdEvent(), 'gateway.intent');
  const replayed = ledger.recordTaskEvent(createdEvent(), 'gateway.intent');
  assert.equal(first.trajectoryEventId, 'trajectory:event-created-1');
  assert.equal(first.sequence, 1);
  assert.equal(first.canReplaySideEffects, false);
  assert.equal(typeof first.attributes.goalDigest, 'string');
  assert.equal((first.attributes.goalDigest as string).length, 64);
  assert.equal(JSON.stringify(first).includes('私密任务目标'), false);
  assert.equal(replayed.sequence, 1);
  assert.equal(ledger.list('task-1', 'run-1').length, 1);
});

test('Run Trajectory 只保留 tool metadata，拒绝 tool args 与 output ref 泄漏', () => {
  const ledger = new RunTrajectoryLedger(new InMemoryRunTrajectoryStore());
  ledger.recordTaskEvent(createdEvent());
  const event: TaskEvent = {
    protocolVersion: '1.0',
    eventId: 'event-tool-1',
    taskId: 'task-1',
    runId: 'run-1',
    at: 11,
    type: 'tool.called',
    callId: 'call-1',
    tool: {
      name: 'workspace.inspect',
      args: { secret: 'never-log-me' },
      capability: 'filesystem.read',
      risk: 'low',
    },
    inputHash: 'input-hash-1',
  };
  const trajectory = ledger.recordTaskEvent(event);
  assert.equal(trajectory.sequence, 2);
  assert.deepEqual(trajectory.attributes, {
    callId: 'call-1', toolName: 'workspace.inspect', capability: 'filesystem.read', risk: 'low', inputHash: 'input-hash-1',
  });
  assert.equal(JSON.stringify(trajectory).includes('never-log-me'), false);
});

test('SQLite Run Trajectory 账本按 run/sequence 保持可重开审查和防御性复制', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-trajectory-'));
  const filePath = join(directory, 'trajectory.sqlite');
  const firstStore = new SqliteRunTrajectoryStore(filePath);
  const firstLedger = new RunTrajectoryLedger(firstStore);
  firstLedger.recordTaskEvent(createdEvent());
  const listed = firstLedger.list('task-1', 'run-1');
  (listed[0].attributes as Record<string, string>).goalDigest = 'mutated';
  assert.notEqual(firstLedger.list('task-1', 'run-1')[0].attributes.goalDigest, 'mutated');
  firstStore.close();

  const reopenedStore = new SqliteRunTrajectoryStore(filePath);
  const reopenedLedger = new RunTrajectoryLedger(reopenedStore);
  assert.equal(reopenedLedger.list('task-1', 'run-1')[0].sequence, 1);
  reopenedStore.close();
  rmSync(directory, { recursive: true, force: true });
});

test('Run Trajectory 对执行权限选择仅投影 authorityMode，不携带管理员租约数据', () => {
  const ledger = new RunTrajectoryLedger(new InMemoryRunTrajectoryStore());
  const trajectory = ledger.recordTaskEvent({
    protocolVersion: '1.0', eventId: 'event-authority-1', taskId: 'task-1', runId: 'run-1', at: 12,
    type: 'execution.authority.selected', authorityMode: 'automate',
  }, 'gateway.intent');
  assert.deepEqual(trajectory.attributes, { authorityMode: 'automate' });
  assert.equal(trajectory.canReplaySideEffects, false);
  assert.equal(JSON.stringify(trajectory).includes('lease'), false);
});
