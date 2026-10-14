import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  SESSION_COMMAND_REASON_CODES,
  SESSION_COMMAND_STATUSES,
  SessionCommandError,
  acceptSessionCommand,
  createSessionCommand,
  isStaleSessionCommand,
  rejectSessionCommand,
  sessionCommandId,
  withCommandBase,
} from '../src/index.js';

test('命令信封：缺省生成幂等 id 与观测时间戳，可选基准只在传入时出现', () => {
  const command = createSessionCommand({ clientId: 'c1', sessionId: 's1', type: 'session/send', payload: { content: 'hi' } });
  assert.equal(command.sessionId, 's1');
  assert.equal(command.type, 'session/send');
  assert.equal(command.commandId.length > 0, true);
  assert.equal(typeof command.issuedAt, 'number');
  assert.equal('baseRevision' in command, false, '未传基准即不做基准校验');
  assert.equal('baseLogEpoch' in command, false);
  const pinned = createSessionCommand({
    clientId: 'c1', sessionId: null, type: 'session/create', payload: {},
    commandId: 'cmd-fixed', baseRevision: 0, baseLogEpoch: 'branch-a', issuedAt: 123,
  });
  assert.deepEqual(
    pinned,
    { commandId: 'cmd-fixed', clientId: 'c1', sessionId: null, type: 'session/create', payload: {}, baseRevision: 0, baseLogEpoch: 'branch-a', issuedAt: 123 },
  );
});

test('命令信封：坏标识与非法基准直接抛错，不带着坏信封继续走', () => {
  assert.throws(() => createSessionCommand({ clientId: '', sessionId: 's1', type: 't', payload: {} }), SessionCommandError);
  assert.throws(() => createSessionCommand({ clientId: 'c1', sessionId: 'x'.repeat(129), type: 't', payload: {} }), SessionCommandError);
  assert.throws(() => createSessionCommand({ clientId: 'c1', sessionId: 's1', type: '', payload: {} }), SessionCommandError);
  assert.throws(() => createSessionCommand({ clientId: 'c1', sessionId: 's1', type: 't', payload: {}, baseRevision: 1.5 }), SessionCommandError);
  assert.throws(() => createSessionCommand({ clientId: 'c1', sessionId: 's1', type: 't', payload: {}, baseRevision: -1 }), SessionCommandError);
  assert.throws(() => createSessionCommand({ clientId: 'c1', sessionId: 's1', type: 't', payload: {}, commandId: 'x'.repeat(200) }), SessionCommandError);
});

test('重试形态只刷新 CAS 基准，幂等键 commandId 必须原样保留', () => {
  const command = createSessionCommand({ clientId: 'c1', sessionId: 's1', type: 'session/send', payload: { content: 'hi' }, baseRevision: 3 });
  const retry = withCommandBase(command, { revision: 7, logEpoch: 'branch-b' });
  assert.equal(retry.commandId, command.commandId, '换 id 等于第二次提交');
  assert.equal(retry.baseRevision, 7);
  assert.equal(retry.baseLogEpoch, 'branch-b');
  assert.deepEqual(retry.payload, command.payload);
  const untouched = withCommandBase(command, {});
  assert.equal(untouched.baseRevision, 3, '未指定即沿用原基准');
  assert.equal(untouched.sessionId, 's1');
});

test('裁决：闭集状态、失败必带稳定拒绝码、stale 判定只认状态', () => {
  assert.deepEqual([...SESSION_COMMAND_STATUSES], ['accepted', 'rejected', 'stale', 'duplicate', 'noop', 'failed']);
  const accepted = acceptSessionCommand('cmd-1', { ok: true });
  assert.deepEqual(accepted, { commandId: 'cmd-1', status: 'accepted', result: { ok: true } });
  assert.equal('reasonCode' in accepted, false, '成功裁决不需要拒绝码');
  const bare = rejectSessionCommand('cmd-1', { status: 'failed' });
  assert.equal(bare.reasonCode, SESSION_COMMAND_REASON_CODES.invalidEnvelope, '缺码裁决无法对账');
  const stale = rejectSessionCommand('cmd-1', { status: 'stale', reasonCode: SESSION_COMMAND_REASON_CODES.staleRevision, revisionAtDecision: 9 });
  assert.equal(isStaleSessionCommand(stale), true);
  assert.equal(stale.revisionAtDecision, 9);
  assert.equal(isStaleSessionCommand(accepted), false);
  assert.equal('revisionAtDecision' in acceptSessionCommand('cmd-2'), false, '对端未回即缺失，不得用本地推测填充');
});

test('命令标识唯一且落在长度约束内（重试靠复用而非新生成）', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 500; i += 1) ids.add(sessionCommandId());
  assert.equal(ids.size, 500);
  for (const id of ids) assert.equal(id.length <= 128, true);
});
