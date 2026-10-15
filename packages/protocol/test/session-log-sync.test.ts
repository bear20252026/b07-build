import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  createSessionLogSync,
  type SessionLogBase,
  type SessionLogReplay,
} from '../src/index.js';

/** 让在途补齐的微任务/定时器跑一轮。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Peer = (base: SessionLogBase, forceSnapshot: boolean) => SessionLogReplay<number, string> | Promise<SessionLogReplay<number, string>>;

interface Limits {
  readonly retryMs?: number;
  readonly pendingCap?: number;
  readonly maxAttempts?: number;
}

/** 假对端 + 观测点：测试只断言「放行了什么、请求了什么、何时停摆」。 */
function harness(peer: Peer, limits: Limits = {}) {
  const applied: number[] = [];
  const snapshots: unknown[] = [];
  const requests: { readonly base: SessionLogBase; readonly forceSnapshot: boolean }[] = [];
  const incompleteReasons: string[] = [];
  let recoveredCount = 0;
  const sync = createSessionLogSync<number, string>({
    requestReplay: async (base, forceSnapshot) => {
      requests.push({ base, forceSnapshot });
      return peer(base, forceSnapshot);
    },
    applyEntry: (entry) => { applied.push(entry.seq); },
    applySnapshot: (snapshot) => { snapshots.push(snapshot.snapshot); },
    onIncomplete: (reason) => { incompleteReasons.push(reason); },
    onRecovered: () => { recoveredCount += 1; },
    retryMs: limits.retryMs ?? 2,
    ...(limits.pendingCap === undefined ? {} : { pendingCap: limits.pendingCap }),
    ...(limits.maxAttempts === undefined ? {} : { maxAttempts: limits.maxAttempts }),
  });
  return {
    sync, applied, snapshots, requests, incompleteReasons,
    get recovered(): number { return recoveredCount; },
  };
}

const noReplay = (): SessionLogReplay<number, string> => ({ kind: 'entries', entries: [] });

test('连续条目按序放行；重复与迟到条目静默丢弃且水位不倒退', async () => {
  const h = harness(noReplay);
  h.sync.bootstrap({ seq: 0 });
  h.sync.acceptEntry({ seq: 1, payload: 1 });
  h.sync.acceptEntry({ seq: 2, payload: 2 });
  h.sync.acceptEntry({ seq: 2, payload: 22 });
  h.sync.acceptEntry({ seq: 1, payload: 11 });
  await tick();
  assert.deepEqual(h.applied, [1, 2]);
  assert.equal(h.sync.watermark, 2);
  assert.equal(h.sync.bufferedCount, 0);
  assert.equal(h.requests.length, 0, '连续流不该请求补齐');
  assert.equal(h.sync.incomplete, false);
});

test('非法序号条目被忽略：非整数、负数都不进入水位', async () => {
  const h = harness(noReplay);
  h.sync.bootstrap({ seq: 0 });
  h.sync.acceptEntry({ seq: -1, payload: 1 });
  h.sync.acceptEntry({ seq: 1.5, payload: 2 });
  await tick();
  assert.deepEqual(h.applied, []);
  assert.equal(h.requests.length, 0, '非法条目不该触发补齐');
  assert.equal(h.sync.watermark, 0);
});

test('bootstrap 只在基准未建立时生效，已建立的水位不被批首改写', async () => {
  const h = harness(noReplay);
  h.sync.bootstrap({ seq: 4 });
  h.sync.bootstrap({ seq: 0 });
  assert.equal(h.sync.watermark, 4, '已建立的基准不可被后来的锚定倒退');
  h.sync.acceptEntry({ seq: 5, payload: 5 });
  assert.deepEqual(h.applied, [5]);
});

test('基准未建立时条目先缓存，续播从 base.seq+1 起才建立基准并放行', async () => {
  const h = harness(() => ({ kind: 'entries', entries: [{ seq: 1, payload: 1 }, { seq: 2, payload: 2 }] }));
  h.sync.acceptEntry({ seq: 2, payload: 2 });
  assert.deepEqual(h.applied, [], '没有基准就不能证明连续性，绝不先放行');
  await tick();
  assert.deepEqual(h.applied, [1, 2]);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].base, { seq: 0 });
  assert.equal(h.sync.watermark, 2);
});

test('缺口条目先缓存并在补齐后按序冲刷；并发缺口只发一次补齐', async () => {
  const h = harness(() => ({ kind: 'entries', entries: [{ seq: 2, payload: 2 }, { seq: 3, payload: 3 }] }));
  h.sync.bootstrap({ seq: 1 });
  h.sync.acceptEntry({ seq: 4, payload: 4 });
  h.sync.acceptEntry({ seq: 5, payload: 5 });
  assert.deepEqual(h.applied, [], '带洞的流一条都不放行');
  await tick();
  assert.deepEqual(h.applied, [2, 3, 4, 5]);
  assert.equal(h.requests.length, 1, 'single flight：在途补齐不重复发');
  assert.equal(h.requests[0].base.seq, 1);
  assert.equal(h.requests[0].forceSnapshot, false);
  assert.equal(h.sync.watermark, 5);
});

test('补齐轮仍填不上洞即升级为强制快照，快照救回后清空其水位以下缓存', async () => {
  const h = harness((base, forceSnapshot) => forceSnapshot
    ? { kind: 'snapshot', snapshot: { seq: 6, snapshot: 'AUTH' } }
    // 只回 5，洞（4）仍在——但 5 已被本轮的续播起点证明可用。
    : { kind: 'entries', entries: [{ seq: 5, payload: 5 }] });
  h.sync.bootstrap({ seq: 3 });
  h.sync.acceptEntry({ seq: 5, payload: 5 });
  await tick();
  assert.deepEqual(h.applied, [], '续播批首条不是 base+1 → 洞仍未填，一条都不放行');
  assert.equal(h.requests.length, 1);
  await sleep(10);
  assert.equal(h.requests.length >= 2, true, '仍有洞时按退避再次补齐');
  assert.equal(h.requests[h.requests.length - 1].forceSnapshot, true, 'recovery 数据仍缺 → 升级要快照');
  assert.deepEqual(h.snapshots, ['AUTH']);
  assert.equal(h.sync.watermark, 6);
  assert.equal(h.sync.bufferedCount, 0, '快照已覆盖的缓存不得二次放行');
  assert.deepEqual(h.applied, [], '条目内容已在快照里，不再单独放行');
});

test('快照之后迟到的补齐应答按世代作废，不得再放行条目', async () => {
  let release: (replay: SessionLogReplay<number, string>) => void = () => undefined;
  const h = harness(() => new Promise<SessionLogReplay<number, string>>((resolve) => { release = resolve; }));
  h.sync.bootstrap({ seq: 1 });
  h.sync.acceptEntry({ seq: 3, payload: 3 });
  await tick();
  assert.equal(h.requests.length, 1);
  h.sync.acceptSnapshot({ seq: 10, snapshot: 'AUTH' });
  release({ kind: 'entries', entries: [{ seq: 2, payload: 2 }] });
  await tick();
  assert.deepEqual(h.applied, [], '迟到补齐的结果早已被权威快照取代');
  assert.deepEqual(h.snapshots, ['AUTH']);
  assert.equal(h.sync.watermark, 10);
});

test('流从不完整被权威快照救回时才报 recovered，正常收敛不打扰调用方', async () => {
  const h = harness(() => ({ kind: 'entries', entries: [] }), { maxAttempts: 1 });
  h.sync.bootstrap({ seq: 0 });
  h.sync.acceptEntry({ seq: 9, payload: 9 });
  await sleep(20);
  assert.equal(h.sync.incomplete, true, '轮数耗尽即停摆');
  assert.deepEqual(h.incompleteReasons, ['session-log-resync-attempts-exhausted']);
  assert.equal(h.recovered, 0);
  h.sync.acceptSnapshot({ seq: 10, snapshot: 'AUTH' });
  assert.equal(h.sync.incomplete, false);
  assert.equal(h.recovered, 1);
  h.sync.acceptEntry({ seq: 11, payload: 11 });
  assert.deepEqual(h.applied, [11], '停摆解除后按序放行');
});

test('停摆后不再放行任何条目，也不重复上报 incomplete', async () => {
  const h = harness(noReplay, { maxAttempts: 1 });
  h.sync.bootstrap({ seq: 0 });
  h.sync.acceptEntry({ seq: 9, payload: 9 });
  await sleep(20);
  h.sync.acceptEntry({ seq: 1, payload: 1 });
  h.sync.acceptEntry({ seq: 2, payload: 2 });
  await tick();
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.incompleteReasons, ['session-log-resync-attempts-exhausted']);
  assert.equal(h.requests.length, 1, '停摆后不再发补齐请求');
});

test('缓冲超限明确标记 gap-unresolved，绝不静默丢事件', async () => {
  const h = harness(noReplay, { pendingCap: 2, maxAttempts: 50 });
  h.sync.bootstrap({ seq: 0 });
  h.sync.acceptEntry({ seq: 4, payload: 4 });
  h.sync.acceptEntry({ seq: 5, payload: 5 });
  h.sync.acceptEntry({ seq: 6, payload: 6 });
  await tick();
  assert.deepEqual(h.incompleteReasons, ['session-log-gap-unresolved']);
  assert.equal(h.sync.bufferedCount, 0);
  assert.deepEqual(h.applied, []);
});

test('换分支（noteEpoch）后旧水位作废并要求权威快照', async () => {
  const h = harness((base, forceSnapshot) => forceSnapshot
    ? { kind: 'snapshot', snapshot: { seq: 1, logEpoch: 'branch-b', snapshot: 'B' } }
    : noReplay());
  h.sync.noteEpoch('branch-a');
  h.sync.bootstrap({ seq: 5 });
  h.sync.acceptEntry({ seq: 6, payload: 6 });
  assert.deepEqual(h.applied, [6]);
  h.sync.noteEpoch('branch-b');
  await tick();
  assert.equal(h.requests[0].forceSnapshot, true);
  assert.deepEqual(h.snapshots, ['B']);
  assert.equal(h.sync.watermark, 1, '旧分支水位不能带进新分支');
  assert.deepEqual(h.applied, [6], '新分支水位之前的条目不得重放');
  h.sync.acceptEntry({ seq: 2, logEpoch: 'branch-a', payload: 99 });
  await tick();
  assert.equal(h.sync.bufferedCount, 0, '外来分支条目不进入本分支缓冲');
});

test('noteServerSeq 只在基准未建立时定起点，已建立且对端领先即触发补齐', async () => {
  const h = harness(() => ({ kind: 'entries', entries: [{ seq: 3, payload: 3 }] }));
  h.sync.noteServerSeq(2);
  assert.equal(h.sync.hasBase, true);
  assert.equal(h.sync.watermark, 2);
  h.sync.acceptEntry({ seq: 3, payload: 3 });
  assert.deepEqual(h.applied, [3]);
  h.sync.noteServerSeq(9);
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].base.seq, 3);
});

test('reset 清空基准、缓冲与停摆标记，迟到结果作废', async () => {
  let release: (replay: SessionLogReplay<number, string>) => void = () => undefined;
  const h = harness(() => new Promise<SessionLogReplay<number, string>>((resolve) => { release = resolve; }));
  h.sync.bootstrap({ seq: 0 });
  h.sync.acceptEntry({ seq: 5, payload: 5 });
  await tick();
  h.sync.reset();
  assert.equal(h.sync.hasBase, false);
  assert.equal(h.sync.incomplete, false);
  assert.equal(h.sync.bufferedCount, 0);
  h.sync.bootstrap({ seq: 0 });
  release({ kind: 'entries', entries: [{ seq: 1, payload: 1 }] });
  await tick();
  assert.deepEqual(h.applied, [], '重开后的会话不能接收上一轮在途补齐的结果');
});
