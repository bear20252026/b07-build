import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  SessionCommandLedger,
  acceptSessionCommand,
  createSessionCommand,
  rejectSessionCommand,
  sessionCommandKey,
  withCommandBase,
  SESSION_COMMAND_REASON_CODES,
  type SessionCommand,
} from '../src/index.js';

function command(overrides: { commandId?: string; sessionId?: string | null; content?: string; baseRevision?: number } = {}): SessionCommand {
  return createSessionCommand({
    clientId: 'client-1',
    sessionId: overrides.sessionId ?? 'sess-1',
    type: 'session/send',
    payload: { content: overrides.content ?? 'hi' },
    ...(overrides.commandId === undefined ? {} : { commandId: overrides.commandId }),
    ...(overrides.baseRevision === undefined ? {} : { baseRevision: overrides.baseRevision }),
  });
}

test('首次提交放行写线；未决期间同 id 重复提交只拿 in-flight，绝不二次写线', () => {
  const ledger = new SessionCommandLedger();
  const first = command({ commandId: 'cmd-1' });
  const begin = ledger.begin(first);
  assert.equal(begin.kind, 'send');
  assert.equal(ledger.pendingCount, 1);
  const again = ledger.begin(command({ commandId: 'cmd-1' }));
  assert.equal(again.kind, 'in-flight');
  assert.equal(ledger.pendingCount, 1, '在途登记不因重复提交而翻倍');
  assert.equal(ledger.settledCount, 0);
});

test('幂等键按会话分桶：同名 commandId 在不同会话互不干扰，建会话命令自成一桶', () => {
  const ledger = new SessionCommandLedger();
  assert.equal(sessionCommandKey({ sessionId: null, commandId: 'cmd-1' }), 'null:cmd-1');
  assert.equal(ledger.begin(command({ commandId: 'cmd-1', sessionId: 'sess-A' })).kind, 'send');
  assert.equal(ledger.begin(command({ commandId: 'cmd-1', sessionId: 'sess-B' })).kind, 'send');
  assert.equal(ledger.begin(command({ commandId: 'cmd-1', sessionId: 'sess-A' })).kind, 'in-flight');
  assert.equal(ledger.pendingCount, 2);
});

test('同 id 换载荷是串号提交：在途与已裁决两条路径都 fail-closed 拒发', () => {
  const ledger = new SessionCommandLedger();
  ledger.begin(command({ commandId: 'cmd-1', content: 'hi' }));
  const hijack = ledger.begin(command({ commandId: 'cmd-1', content: 'rm -rf /' }));
  assert.equal(hijack.kind, 'conflict');
  ledger.settle(command({ commandId: 'cmd-1', content: 'hi' }), acceptSessionCommand('cmd-1'));
  const afterSettle = ledger.begin(command({ commandId: 'cmd-1', content: 'rm -rf /' }));
  assert.equal(afterSettle.kind, 'conflict');
});

test('已 accepted 的裁决重放直接复用原裁决：一次副作用都不再产生', () => {
  const ledger = new SessionCommandLedger();
  const first = command({ commandId: 'cmd-1' });
  ledger.begin(first);
  const ack = acceptSessionCommand('cmd-1', { accepted: true, stateRevision: 4 });
  assert.equal(ledger.settle(first, ack), true);
  assert.equal(ledger.pendingCount, 0);
  assert.equal(ledger.settledCount, 1);
  const replay = ledger.begin(command({ commandId: 'cmd-1' }));
  assert.equal(replay.kind, 'settled');
  assert.deepEqual(replay.kind === 'settled' ? replay.ack : undefined, ack);
  assert.equal(ledger.find(first), ack);
});

test('stale 裁决：带新基准可复用原 commandId 重发，沿用过期基准则拒绝空转', () => {
  const ledger = new SessionCommandLedger();
  const first = command({ commandId: 'cmd-1', baseRevision: 3 });
  ledger.begin(first);
  ledger.settle(first, rejectSessionCommand('cmd-1', { status: 'stale', reasonCode: SESSION_COMMAND_REASON_CODES.staleRevision, revisionAtDecision: 7 }));
  const sameBase = ledger.begin(command({ commandId: 'cmd-1', baseRevision: 3 }));
  assert.equal(sameBase.kind, 'conflict', '过期基准原地重放必然再次 stale');
  const refreshed = ledger.begin(withCommandBase(first, { revision: 7 }));
  assert.equal(refreshed.kind, 'send');
  assert.equal(refreshed.kind === 'send' ? refreshed.command.commandId : undefined, 'cmd-1', '重试复用幂等键');
  assert.equal(ledger.settledCount, 0, '重发即从未决表接管，不留双份');
  assert.equal(ledger.pendingCount, 1);
});

test('结果未知的 failed 允许复用原 id 重发，由对端按 id 去重', () => {
  const ledger = new SessionCommandLedger();
  const first = command({ commandId: 'cmd-9' });
  ledger.begin(first);
  ledger.settle(first, rejectSessionCommand('cmd-9', { status: 'failed', reasonCode: SESSION_COMMAND_REASON_CODES.transportClosed }));
  assert.equal(ledger.begin(command({ commandId: 'cmd-9' })).kind, 'send');
});

test('已裁决表有界：超限淘汰最早裁决，容量内保留可对账读数', () => {
  const ledger = new SessionCommandLedger(2);
  for (const id of ['a', 'b', 'c']) {
    const cmd = command({ commandId: id });
    ledger.begin(cmd);
    ledger.settle(cmd, acceptSessionCommand(id));
  }
  assert.equal(ledger.settledCount, 2);
  assert.equal(ledger.find(command({ commandId: 'a' })), undefined, '最早裁决被挤出');
  assert.notEqual(ledger.find(command({ commandId: 'c' })), undefined);
});

test('settle 只认在途登记：陌生或已裁决的 id 返回 false，不伪造裁决', () => {
  const ledger = new SessionCommandLedger();
  const cmd = command({ commandId: 'cmd-1' });
  assert.equal(ledger.settle(cmd, acceptSessionCommand('cmd-1')), false);
  ledger.begin(cmd);
  assert.equal(ledger.settle(cmd, acceptSessionCommand('cmd-1')), true);
  assert.equal(ledger.settle(cmd, rejectSessionCommand('cmd-1', { status: 'failed' })), false, '同一裁决不覆盖');
});

test('载荷不可序列化即拒发：坏命令绝不落到线上', () => {
  const ledger = new SessionCommandLedger();
  const cyclic: Record<string, unknown> = { name: 'loop' };
  cyclic.self = cyclic;
  const bad = createSessionCommand({ clientId: 'c1', sessionId: 's1', type: 't', payload: cyclic });
  assert.equal(ledger.begin(bad).kind, 'conflict');
  assert.equal(ledger.pendingCount, 0);
});

test('clear：会话关闭后历史裁决不再被新会话复用', () => {
  const ledger = new SessionCommandLedger();
  const cmd = command({ commandId: 'cmd-1' });
  ledger.begin(cmd);
  ledger.settle(cmd, acceptSessionCommand('cmd-1'));
  ledger.clear();
  assert.equal(ledger.settledCount, 0);
  assert.equal(ledger.pendingCount, 0);
  assert.equal(ledger.begin(command({ commandId: 'cmd-1' })).kind, 'send');
});
