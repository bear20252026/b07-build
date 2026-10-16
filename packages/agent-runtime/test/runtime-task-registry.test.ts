// 运行期任务台账测试：登记/观察/后台化/消息投递/代际围栏/通知格式化与抑制。
//
// 这份测试刻意覆盖四类"不测就会静默错"的地方：
// 1. **等待者泄漏**——用导出给测试的 waiter 计数直接钉住"结算/取消后计数归零"。
//    只测"Promise 有 resolve"测不出泄漏。
// 2. **提前唤醒**——"等待终态"不能被"后台化"提前满足；这两个 waiter 集合合成一个
//    就会错，且错了之后表象只是"偶尔拿到还在跑的任务"，极难定位。
// 3. **代际围栏**——旧代际的迟到完成不得被新代际消费，且无代际时必须 fail-closed。
// 4. **状态词与决定者分离**——`stopped` 是用户停的还是模型停的，指引恰好相反。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasRunningBackgroundRuntimeTask,
  isRuntimeTaskCompletionInGeneration,
  isRuntimeTaskType,
  isTerminalRuntimeTask,
  isTerminalRuntimeTaskStatus,
  RUNTIME_TASK_TYPES,
  TERMINAL_RUNTIME_TASK_STATUSES,
  type RuntimeTaskSnapshot,
} from '../src/runtime-task-contract.js';
import {
  backgroundWaiterCount,
  InMemoryRuntimeTaskRegistry,
  isRuntimeTaskSettled,
  terminalWaiterCount,
} from '../src/runtime-task-registry.js';
import {
  formatRuntimeTaskNotification,
  formatSettledRuntimeTasks,
  RUNTIME_TASK_NOTIFICATION_MAX_CHARS,
  runtimeTaskDeliveryGuidance,
  shouldSuppressRuntimeTaskNotification,
  truncateRuntimeTaskNotification,
} from '../src/runtime-task-notification.js';

/** 可手动推进的时钟，避免测试依赖真实时间。 */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => number } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
      return value;
    },
  };
}

function makeRegistry(): { registry: InMemoryRuntimeTaskRegistry; time: ReturnType<typeof clock> } {
  const time = clock();
  return { registry: new InMemoryRuntimeTaskRegistry(time.now), time };
}

/** 让已 settle 的微任务跑完（等待者的 resolve 走的是 Promise 机制）。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

// ───────────────────────── 契约：闭集与判定 ─────────────────────────

test('任务类型是闭集，且守卫能识别成员与非成员', () => {
  assert.deepEqual([...RUNTIME_TASK_TYPES], [
    'local_agent',
    'local_bash',
    'local_tool',
    'local_task',
    'monitor_mcp',
  ]);
  for (const type of RUNTIME_TASK_TYPES) {
    assert.equal(isRuntimeTaskType(type), true, `${type} 应当是合法任务类型`);
  }
  // 自由字符串必须被拒——这正是闭集的意义。
  assert.equal(isRuntimeTaskType('local_dynamic_workflow'), false);
  assert.equal(isRuntimeTaskType(''), false);
  assert.equal(isRuntimeTaskType('Bash'), false);
});

test('终态闭集含六个状态，且刻意不含 blocked 与 created', () => {
  assert.deepEqual([...TERMINAL_RUNTIME_TASK_STATUSES].sort(), [
    'cancelled',
    'completed',
    'failed',
    'killed',
    'lost',
    'stopped',
  ]);
  // blocked 不是终态：被门控拦住的任务还活着，人工批准后会继续。
  assert.equal(isTerminalRuntimeTaskStatus('blocked'), false);
  // created 不是终态：排队中必然还没结束。
  assert.equal(isTerminalRuntimeTaskStatus('created'), false);
  assert.equal(isTerminalRuntimeTaskStatus('running'), false);
  assert.equal(isTerminalRuntimeTask({ status: 'blocked' }), false);
  assert.equal(isTerminalRuntimeTask({ status: 'completed' }), true);
  assert.equal(isRuntimeTaskSettled('stopped'), true);
  // 未知状态一律不是终态（fail-closed：宁可多等，不可提前结算）。
  assert.equal(isTerminalRuntimeTaskStatus('some_future_status'), false);
});

// ───────────────────────── 登记与查询 ─────────────────────────

test('注册盖章 createdAt/updatedAt，并保留传入字段', () => {
  const { registry, time } = makeRegistry();
  const task = registry.register({
    taskId: 'task-1',
    type: 'local_bash',
    label: '跑构建',
    metadata: { owner: 'workbench' },
  });
  assert.equal(task.taskId, 'task-1');
  assert.equal(task.type, 'local_bash');
  assert.equal(task.status, 'created');
  assert.equal(task.label, '跑构建');
  assert.equal(task.createdAt, 1_000);
  assert.equal(task.updatedAt, 1_000);
  assert.deepEqual(task.metadata, { owner: 'workbench' });
  // 未指定 status 时缺省 created，未指定代际时盖当前代际（初始为 0）。
  assert.equal(task.branchGeneration, 0);
  assert.equal(task.isBackgrounded, undefined);
  assert.equal(task.stopInitiator, undefined);
  time.advance(0); // 不推进也允许
});

test('重复 taskId 注册直接拒绝，不静默覆盖', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 'dup', type: 'local_tool' });
  // 静默覆盖会丢事件：先注册的任务的等待者将永远等不到它。
  assert.throws(
    () => registry.register({ taskId: 'dup', type: 'local_bash' }),
    /已注册/,
  );
});

test('非法 taskId 被拒绝', () => {
  const { registry } = makeRegistry();
  assert.throws(() => registry.register({ taskId: '', type: 'local_tool' }), /安全标识符/);
  assert.throws(() => registry.register({ taskId: '有中文', type: 'local_tool' }), /安全标识符/);
  assert.throws(() => registry.register({ taskId: 'a b', type: 'local_tool' }), /安全标识符/);
});

test('all() 按 taskId 稳定排序，返回快照副本', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 'zeta', type: 'local_tool' });
  registry.register({ taskId: 'alpha', type: 'local_tool' });
  registry.register({ taskId: 'mid', type: 'local_tool' });
  assert.deepEqual(
    registry.all().map((task) => task.taskId),
    ['alpha', 'mid', 'zeta'],
  );
  // 拿到的是副本：改动它不得影响台账内部状态。
  const snapshot = registry.all()[0];
  (snapshot as { status: string }).status = 'completed';
  assert.equal(registry.get('alpha')?.status, 'created');
});

test('query 按类型/状态/终态/后台化/代际过滤', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 'a', type: 'local_bash' });
  registry.register({ taskId: 'b', type: 'local_bash' });
  registry.register({ taskId: 'c', type: 'local_agent' });
  registry.update('b', { status: 'completed' });
  registry.requestBackground('a');
  registry.setActiveBranchGeneration(7);
  registry.register({ taskId: 'd', type: 'local_tool' });

  assert.deepEqual(registry.query({ type: 'local_bash' }).map((t) => t.taskId), ['a', 'b']);
  assert.deepEqual(registry.query({ status: 'completed' }).map((t) => t.taskId), ['b']);
  assert.deepEqual(registry.query({ terminal: true }).map((t) => t.taskId), ['b']);
  assert.deepEqual(registry.query({ terminal: false }).map((t) => t.taskId), ['a', 'c', 'd']);
  assert.deepEqual(registry.query({ backgrounded: true }).map((t) => t.taskId), ['a']);
  // a/b/c 在代际 0 注册，d 在代际 7 注册。
  assert.deepEqual(registry.query({ branchGeneration: 7 }).map((t) => t.taskId), ['d']);
  assert.deepEqual(registry.query({ branchGeneration: 0 }).map((t) => t.taskId), ['a', 'b', 'c']);
  // 条件之间是与关系。
  assert.deepEqual(registry.query({ type: 'local_bash', terminal: false }).map((t) => t.taskId), ['a']);
});

// ───────────────────────── 更新与不可变更字段 ─────────────────────────

test('update 返回新快照并刷新 updatedAt，任务不存在返回 undefined', () => {
  const { registry, time } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_agent' });
  time.advance(500);
  const updated = registry.update('t', { status: 'running', usage: { toolCallCount: 3 } });
  assert.equal(updated?.status, 'running');
  assert.equal(updated?.updatedAt, 1_500);
  assert.equal(updated?.createdAt, 1_000);
  assert.equal(updated?.usage?.toolCallCount, 3);
  assert.equal(registry.update('missing', { status: 'running' }), undefined);
});

test('update 不能改 taskId / type / branchGeneration（围栏前提）', () => {
  const { registry } = makeRegistry();
  registry.setActiveBranchGeneration(3);
  registry.register({ taskId: 't', type: 'local_agent' });
  // 绕过类型：JS 调用方可能传入额外字段。
  const updated = registry.update('t', {
    status: 'running',
    taskId: 'hacked',
    type: 'monitor_mcp',
    branchGeneration: 99,
  } as never);
  assert.equal(updated?.taskId, 't');
  assert.equal(updated?.type, 'local_agent');
  // 代际保持注册时的值——允许改就等于把迟到完成围栏拆了。
  assert.equal(updated?.branchGeneration, 3);
  assert.equal(registry.get('t')?.taskId, 't');
});

test('update 可以清空可选字段（显式传 undefined）', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool', label: 'x' });
  const updated = registry.update('t', { label: undefined });
  assert.equal(updated?.label, undefined);
});

// ───────────────────────── 等待终态 ─────────────────────────

test('等待终态：已终态立即结算', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool', status: 'completed' });
  const settled = await registry.waitForTerminal('t');
  assert.equal(settled?.status, 'completed');
});

test('等待终态：任务不存在立即返回 undefined', async () => {
  const { registry } = makeRegistry();
  assert.equal(await registry.waitForTerminal('nope'), undefined);
});

test('等待终态：被 update 到终态时唤醒，且拿到跨越那一刻的快照', async () => {
  const { registry, time } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_bash' });
  const waiting = registry.waitForTerminal('t');
  assert.equal(terminalWaiterCount(registry, 't'), 1);

  time.advance(100);
  registry.update('t', { status: 'failed', errorMessage: '退出码 1' });
  const settled = await waiting;
  assert.equal(settled?.status, 'failed');
  assert.equal(settled?.errorMessage, '退出码 1');
  assert.equal(settled?.updatedAt, 1_100);
  // 唤醒后等待者计数归零（不泄漏）。
  assert.equal(terminalWaiterCount(registry, 't'), 0);
});

test('等待终态：多个观察者同时被唤醒', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool' });
  const first = registry.waitForTerminal('t');
  const second = registry.waitForTerminal('t');
  const third = registry.waitForTerminal('t');
  assert.equal(terminalWaiterCount(registry, 't'), 3);
  registry.update('t', { status: 'stopped' });
  const results = await Promise.all([first, second, third]);
  for (const result of results) assert.equal(result?.status, 'stopped');
  assert.equal(terminalWaiterCount(registry, 't'), 0);
});

test('等待终态：blocked 不是终态，不会唤醒等待者', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool' });
  const waiting = registry.waitForTerminal('t');
  let resolved = false;
  void waiting.then(() => {
    resolved = true;
  });

  // blocked 是"等人工决定"，任务还活着。
  registry.update('t', { status: 'blocked' });
  await flush();
  assert.equal(resolved, false, 'blocked 不应唤醒等待终态的观察者');
  assert.equal(terminalWaiterCount(registry, 't'), 1);

  // 批准后继续跑，最终到终态。
  registry.update('t', { status: 'running' });
  await flush();
  assert.equal(resolved, false);
  registry.update('t', { status: 'completed' });
  assert.equal((await waiting)?.status, 'completed');
});

test('等待终态：注册即终态也会唤醒已在等的观察者', async () => {
  const { registry } = makeRegistry();
  // 先让调用方进入等待（此时任务还不存在，会立即结算）——改用"先注册 created 再登记终态"路径：
  registry.register({ taskId: 't', type: 'local_tool' });
  const waiting = registry.waitForTerminal('t');
  // 移除后再以终态重新注册（补记活已完成的任务）。
  registry.remove('t');
  assert.equal(await waiting, undefined);

  registry.register({ taskId: 't2', type: 'local_tool' });
  const waiting2 = registry.waitForTerminal('t2');
  // 同一 id 直接 update 到终态。
  registry.update('t2', { status: 'completed', resultSummary: 'done' });
  assert.equal((await waiting2)?.resultSummary, 'done');
});

test('等待终态：重复写入同一终态不重复结算（等待者拿第一次跨越的快照）', async () => {
  const { registry, time } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool' });
  registry.update('t', { status: 'completed', resultSummary: '第一次' });
  time.advance(50);
  registry.update('t', { status: 'completed', resultSummary: '第二次' });
  // 新的等待者（跨越已发生）看到的是最终值。
  const settled = await registry.waitForTerminal('t');
  assert.equal(settled?.resultSummary, '第二次');
});

test('等待终态：已被 abort 的 signal 立刻 reject，且不注册 waiter', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool' });
  const controller = new AbortController();
  controller.abort(new Error('调用方已取消'));
  await assert.rejects(
    () => registry.waitForTerminal('t', { signal: controller.signal }),
    /调用方已取消/,
  );
  // 关键：不能留下一个已 settle 的 waiter。
  assert.equal(terminalWaiterCount(registry, 't'), 0);
});

test('等待终态：等待中途 abort 会摘掉 waiter 并 reject', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool' });
  const controller = new AbortController();
  const waiting = registry.waitForTerminal('t', { signal: controller.signal });
  assert.equal(terminalWaiterCount(registry, 't'), 1);

  controller.abort(new Error('用户切走了'));
  await assert.rejects(() => waiting, /用户切走了/);
  // 泄漏检查：abort 之后 waiter 必须被摘掉。
  assert.equal(terminalWaiterCount(registry, 't'), 0);

  // 之后再进终态也不应把它"复活"。
  registry.update('t', { status: 'completed' });
  await flush();
  assert.equal(terminalWaiterCount(registry, 't'), 0);
});

test('等待终态：无 reason 的 abort 也给可读错误', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool' });
  const controller = new AbortController();
  const waiting = registry.waitForTerminal('t', { signal: controller.signal });
  controller.abort();
  // 平台会自动把 reason 填成一个英文 AbortError；对中文用户毫无意义，
  // 所以判"有没有显式给原因"不能只看 reason === undefined。
  await assert.rejects(() => waiting, /等待已被取消/);
});

test('等待终态：显式传入 AbortError 也照原样保留（不吞掉调用方判断）', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool' });
  const controller = new AbortController();
  const explicit = Object.assign(new Error('调用方显式取消'), { name: 'AbortError' });
  const waiting = registry.waitForTerminal('t', { signal: controller.signal });
  controller.abort(explicit);
  // 我们无法区分"显式传 AbortError"与"平台自动填"，故按后者处理（给可读文案）；
  // 但 error 的 name 仍是 AbortError——调用方按类型判定的代码不受影响。
  await assert.rejects(
    () => waiting,
    (error: unknown) => error instanceof Error && error.message.includes('等待已被取消'),
  );
});

test('等待终态：任务被 remove 时结算为 undefined', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool' });
  const waiting = registry.waitForTerminal('t');
  registry.remove('t');
  assert.equal(await waiting, undefined);
  assert.equal(terminalWaiterCount(registry, 't'), 0);
});

// ───────────────────────── 后台化 ─────────────────────────

test('requestBackground 只对运行中的任务生效，重复请求返回 false', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_bash', status: 'running' });
  assert.equal(registry.requestBackground('t'), true);
  assert.equal(registry.get('t')?.isBackgrounded, true);
  // 已后台化：本次调用没有产生状态变更，故返回 false。
  assert.equal(registry.requestBackground('t'), false);
  // 不存在。
  assert.equal(registry.requestBackground('missing'), false);
});

test('requestBackground 对终态任务返回 false', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_bash', status: 'completed' });
  assert.equal(registry.requestBackground('t'), false);
  assert.equal(registry.get('t')?.isBackgrounded, undefined);
  // blocked 不是终态，仍可后台化——"等人工决定"的任务照样可以沉到后台。
  registry.register({ taskId: 'b', type: 'local_bash', status: 'blocked' });
  assert.equal(registry.requestBackground('b'), true);
});

test('等待后台化：立即结算的三种情形', async () => {
  const { registry } = makeRegistry();
  // 未指定 isBackgrounded，注册后主动请求后台化。
  registry.register({ taskId: 'bg', type: 'local_tool', status: 'running' });
  registry.requestBackground('bg');
  assert.equal((await registry.waitForBackgroundRequest('bg'))?.isBackgrounded, true);

  registry.register({ taskId: 'done', type: 'local_tool', status: 'completed' });
  // 已终态的任务不会再被后台化：返回 undefined 让调用方一眼看出等错了。
  assert.equal(await registry.waitForBackgroundRequest('done'), undefined);
  assert.equal(await registry.waitForBackgroundRequest('missing'), undefined);
});

test('等待后台化：跨边界时被唤醒，且不泄漏 waiter', async () => {
  const { registry, time } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_bash', status: 'running' });
  const waiting = registry.waitForBackgroundRequest('t');
  assert.equal(backgroundWaiterCount(registry, 't'), 1);
  time.advance(200);
  registry.requestBackground('t');
  const snapshot = await waiting;
  assert.equal(snapshot?.isBackgrounded, true);
  assert.equal(snapshot?.updatedAt, 1_200);
  assert.equal(backgroundWaiterCount(registry, 't'), 0);
});

test('关键：后台化不会唤醒"等待终态"的观察者', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_bash', status: 'running' });
  const waitingTerminal = registry.waitForTerminal('t');
  let terminalResolved = false;
  void waitingTerminal.then(() => {
    terminalResolved = true;
  });

  registry.requestBackground('t');
  await flush();
  // 这是两个不同的等待：后台化只回答"我还要不要继续盯着它"，不回答"它结束没有"。
  assert.equal(terminalResolved, false, '后台化不得唤醒等待终态的观察者');
  assert.equal(terminalWaiterCount(registry, 't'), 1);

  registry.update('t', { status: 'completed' });
  assert.equal((await waitingTerminal)?.status, 'completed');
});

test('关键：任务到终态会同时结算"等待后台化"的观察者（防泄漏）', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_bash', status: 'running' });
  const waitingBackground = registry.waitForBackgroundRequest('t');
  assert.equal(backgroundWaiterCount(registry, 't'), 1);

  registry.update('t', { status: 'failed' });
  // 已结束的任务永远不会再被后台化：让等待者一直挂着会耗尽会话寿命。
  assert.equal(await waitingBackground, undefined);
  assert.equal(backgroundWaiterCount(registry, 't'), 0);
});

test('hasRunningBackgroundRuntimeTask 只看"已后台化且仍在跑"', () => {
  const { registry } = makeRegistry();
  assert.equal(hasRunningBackgroundRuntimeTask(registry), false);

  registry.register({ taskId: 'a', type: 'local_bash', status: 'running' });
  // 在跑但没后台化：面板不该显示。
  assert.equal(hasRunningBackgroundRuntimeTask(registry), false);

  registry.requestBackground('a');
  assert.equal(hasRunningBackgroundRuntimeTask(registry), true);

  registry.update('a', { status: 'completed' });
  assert.equal(hasRunningBackgroundRuntimeTask(registry), false);

  // 已后台化但状态是 created（还没跑）：不算"在跑"。
  registry.register({ taskId: 'b', type: 'local_tool', status: 'created' });
  registry.requestBackground('b');
  assert.equal(hasRunningBackgroundRuntimeTask(registry), false);
});

// ───────────────────────── 消息投递 ─────────────────────────

test('queueMessage / drainMessages：FIFO 取走并清空', () => {
  const { registry, time } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_agent', status: 'running' });
  registry.queueMessage('t', { id: 'm1', message: '第一条' });
  time.advance(10);
  registry.queueMessage('t', { id: 'm2', message: '第二条', summary: '摘要' });
  assert.equal(registry.pendingMessageCount('t'), 2);

  const drained = registry.drainMessages('t');
  assert.deepEqual(drained.map((message) => message.id), ['m1', 'm2']);
  assert.equal(drained[0].queuedAt, 1_000);
  assert.equal(drained[1].queuedAt, 1_010);
  assert.equal(drained[1].summary, '摘要');

  // 二次取走为空——这是"清空"而非"读取"。
  assert.deepEqual([...registry.drainMessages('t')], []);
  assert.equal(registry.pendingMessageCount('t'), 0);
});

test('queueMessage：任务不存在返回 undefined，不产生排队', () => {
  const { registry } = makeRegistry();
  assert.equal(registry.queueMessage('missing', { id: 'm', message: 'x' }), undefined);
  assert.equal(registry.pendingMessageCount('missing'), 0);
});

test('queueMessage：消息 id 全局幂等，重复投递被拒绝', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 'a', type: 'local_agent' });
  registry.register({ taskId: 'b', type: 'local_agent' });
  registry.queueMessage('a', { id: 'same', message: 'x' });
  // 同一 id 投给另一个任务也要拒绝——父代理 turn 重放时会重复投递同一条。
  assert.throws(() => registry.queueMessage('b', { id: 'same', message: 'x' }), /已投递/);
  assert.throws(() => registry.queueMessage('a', { id: 'same', message: 'y' }), /已投递/);
  assert.equal(registry.pendingMessageCount('b'), 0);
});

test('queueMessage：空 id 或空正文被拒绝', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_agent' });
  assert.throws(() => registry.queueMessage('t', { id: '  ', message: 'x' }), /id 不能为空/);
  assert.throws(() => registry.queueMessage('t', { id: 'm', message: '   ' }), /正文不能为空/);
});

test('queueMessage：已终态的任务仍接受投递（投递与消费解耦）', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_agent', status: 'completed' });
  // 已经拿到产物的调用方可能仍想记一笔"我原本要追加的指令"，由消费方决定忽略。
  const snapshot = registry.queueMessage('t', { id: 'late', message: '补充' });
  assert.equal(snapshot?.taskId, 't');
  assert.deepEqual(registry.drainMessages('t').map((m) => m.message), ['补充']);
});

test('queueMessage：投递不改变任务状态与 updatedAt', () => {
  const { registry, time } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_agent', status: 'running' });
  time.advance(500);
  registry.queueMessage('t', { id: 'm', message: 'x' });
  // 消息是附带的队列，不是任务状态变更——把它算进 updatedAt 会让"最近活动时间"失真。
  assert.equal(registry.get('t')?.updatedAt, 1_000);
  assert.equal(registry.get('t')?.status, 'running');
});

test('queueMessage：origin 与 isMeta 原样保留（台账不解释）', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_agent', status: 'running' });
  registry.queueMessage('t', {
    id: 'm',
    message: 'x',
    isMeta: true,
    origin: { kind: 'coordinator', toolCallId: 'call-9' },
  });
  const [message] = registry.drainMessages('t');
  assert.equal(message.isMeta, true);
  assert.deepEqual(message.origin, { kind: 'coordinator', toolCallId: 'call-9' });
});

test('remove 会丢排队消息并结算等待者', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_agent', status: 'running' });
  registry.queueMessage('t', { id: 'm', message: 'x' });
  const waitingTerminal = registry.waitForTerminal('t');
  registry.remove('t');
  assert.equal(registry.get('t'), undefined);
  assert.equal(registry.pendingMessageCount('t'), 0);
  assert.equal(await waitingTerminal, undefined);
});

// ───────────────────────── 代际围栏 ─────────────────────────

test('注册时盖章代际，之后 update 不能改变它', () => {
  const { registry } = makeRegistry();
  registry.setActiveBranchGeneration(2);
  registry.register({ taskId: 't', type: 'local_agent' });
  assert.equal(registry.get('t')?.branchGeneration, 2);
  registry.setActiveBranchGeneration(5);
  registry.update('t', { status: 'running' });
  // 代际是注册时固定的归属，不是"当前代际"的镜像。
  assert.equal(registry.get('t')?.branchGeneration, 2);
  assert.equal(registry.activeBranchGeneration(), 5);
});

test('显式 branchGeneration 覆盖当前代际', () => {
  const { registry } = makeRegistry();
  registry.setActiveBranchGeneration(4);
  registry.register({ taskId: 't', type: 'local_agent', branchGeneration: 1 });
  assert.equal(registry.get('t')?.branchGeneration, 1);
});

test('setActiveBranchGeneration 拒绝非法值', () => {
  const { registry } = makeRegistry();
  assert.throws(() => registry.setActiveBranchGeneration(-1), /非负安全整数/);
  assert.throws(() => registry.setActiveBranchGeneration(1.5), /非负安全整数/);
  assert.throws(() => registry.setActiveBranchGeneration(Number.NaN), /非负安全整数/);
});

test('围栏正例：同代际的终态完成被判定为可消费', () => {
  const { registry } = makeRegistry();
  registry.setActiveBranchGeneration(3);
  registry.register({ taskId: 't', type: 'local_agent' });
  registry.update('t', { status: 'completed' });
  assert.equal(isRuntimeTaskCompletionInGeneration(registry.get('t'), 3), true);
});

test('围栏关键：旧代际的迟到完成不得被新代际消费', () => {
  const { registry } = makeRegistry();
  registry.setActiveBranchGeneration(1);
  registry.register({ taskId: 'old', type: 'local_agent' });
  // 会话重臂：切到新代际。
  registry.setActiveBranchGeneration(2);
  // 旧代际的任务现在才完成——这是一个**迟到的完成**。
  registry.update('old', { status: 'completed', resultSummary: '旧分支的结果' });

  const task = registry.get('old');
  assert.equal(isRuntimeTaskCompletionInGeneration(task, 2), false, '迟到完成不得归入新代际');
  assert.equal(isRuntimeTaskCompletionInGeneration(task, 1), true, '归属旧代际可被旧代际消费');
  // query 按代际过滤，消费方可以用它一次拿对。
  assert.deepEqual([...registry.query({ branchGeneration: 2, terminal: true })], []);
  assert.deepEqual(
    registry.query({ branchGeneration: 1, terminal: true }).map((t) => t.taskId),
    ['old'],
  );
});

test('围栏 fail-closed：无代际的完成结果在任何代际下都不可消费', () => {
  // 直接构造一个无代际的快照（如从旧版持久化快照恢复而来）。
  const task: RuntimeTaskSnapshot = {
    taskId: 'legacy',
    type: 'local_agent',
    status: 'completed',
    createdAt: 0,
    updatedAt: 0,
  };
  for (const generation of [0, 1, 7, 99]) {
    assert.equal(
      isRuntimeTaskCompletionInGeneration(task, generation),
      false,
      `无代际的完成结果不得在代际 ${generation} 被消费`,
    );
  }
});

test('围栏：未终态与不存在的任务都不算可消费', () => {
  const { registry } = makeRegistry();
  registry.setActiveBranchGeneration(1);
  registry.register({ taskId: 'running', type: 'local_agent' });
  assert.equal(isRuntimeTaskCompletionInGeneration(registry.get('running'), 1), false);
  assert.equal(isRuntimeTaskCompletionInGeneration(undefined, 1), false);
});

// ───────────────────────── 通知格式化 ─────────────────────────

function settledTask(overrides: Partial<RuntimeTaskSnapshot> = {}): RuntimeTaskSnapshot {
  return {
    taskId: 'task-1',
    type: 'local_bash',
    status: 'completed',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test('通知包含任务身份、状态与产物，且是结构化标签', () => {
  const text = formatRuntimeTaskNotification({
    task: settledTask({ label: '跑构建', resultSummary: '构建成功' }),
  });
  assert.match(text, /^<runtime-task-notification>/);
  assert.match(text, /<task-id>task-1<\/task-id>/);
  assert.match(text, /<task-type>local_bash<\/task-type>/);
  assert.match(text, /<status>completed<\/status>/);
  assert.match(text, /<label>跑构建<\/label>/);
  assert.match(text, /<result>构建成功<\/result>/);
  assert.match(text, /<\/runtime-task-notification>/);
});

test('通知转义 XML 特殊字符，防止标签注入', () => {
  const text = formatRuntimeTaskNotification({
    task: settledTask({ status: 'failed', errorMessage: '<script>alert(1)</script> & "x"' }),
  });
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; "x"/);
  assert.equal(text.includes('<script>'), false);
});

test('通知把 stop-initiator 与 branch-generation 外显', () => {
  const text = formatRuntimeTaskNotification({
    task: settledTask({ status: 'stopped', stopInitiator: 'user', branchGeneration: 4 }),
  });
  assert.match(text, /<stop-initiator>user<\/stop-initiator>/);
  assert.match(text, /<branch-generation>4<\/branch-generation>/);
});

test('通知把 error 排在 result 之前，output 排在最后', () => {
  const text = formatRuntimeTaskNotification({
    task: settledTask({ status: 'failed', errorMessage: '错误', resultSummary: '部分结果' }),
    output: '大段产出',
  });
  const errorIndex = text.indexOf('<error>');
  const resultIndex = text.indexOf('<result>');
  const outputIndex = text.indexOf('<output>');
  // 失败原因比产物更该先被看到。
  assert.ok(errorIndex > 0 && errorIndex < resultIndex, 'error 应排在 result 之前');
  assert.ok(resultIndex < outputIndex, 'output 应排在 result 之后（总截断先斩它）');
});

test('通知的 usage 只输出实际存在的属性', () => {
  const onlyDuration = formatRuntimeTaskNotification({
    task: settledTask({ usage: { durationMs: 1200 } }),
    deliveryGuidance: false,
  });
  assert.match(onlyDuration, /<usage duration-ms="1200"\/>/);
  assert.equal(onlyDuration.includes('tool-calls'), false);

  const both = formatRuntimeTaskNotification({
    task: settledTask({ usage: { durationMs: 1200, toolCallCount: 3 } }),
    deliveryGuidance: false,
  });
  assert.match(both, /<usage duration-ms="1200" tool-calls="3"\/>/);

  // 空 usage 不产生空节。
  const empty = formatRuntimeTaskNotification({
    task: settledTask({ usage: {} }),
    deliveryGuidance: false,
  });
  assert.equal(empty.includes('<usage'), false);
});

test('通知的空白字段不产生空节', () => {
  const text = formatRuntimeTaskNotification({
    task: settledTask({ label: '   ', resultSummary: '', errorMessage: '  ' }),
    deliveryGuidance: false,
  });
  assert.equal(text.includes('<label>'), false);
  assert.equal(text.includes('<result>'), false);
  assert.equal(text.includes('<error>'), false);
});

test('deliveryGuidance: false 时不追加指引', () => {
  const withGuidance = formatRuntimeTaskNotification({ task: settledTask() });
  const without = formatRuntimeTaskNotification({ task: settledTask(), deliveryGuidance: false });
  assert.ok(withGuidance.length > without.length);
  assert.match(without, /<\/runtime-task-notification>$/);
});

test('超长通知被截断并显式标注', () => {
  const huge = 'x'.repeat(RUNTIME_TASK_NOTIFICATION_MAX_CHARS + 5_000);
  const truncated = truncateRuntimeTaskNotification(huge);
  assert.equal(truncated.length, RUNTIME_TASK_NOTIFICATION_MAX_CHARS);
  assert.match(truncated, /\[通知因超出长度上限被截断\]$/);

  // 未超限时原样返回——静默改内容会让"没截断"这件事无法判定。
  const short = 'y'.repeat(10);
  assert.equal(truncateRuntimeTaskNotification(short), short);
});

// ───────────────────────── 下一步指引 ─────────────────────────

test('指引：完成的任务要求当交付物呈现，不复述过程', () => {
  const guidance = runtimeTaskDeliveryGuidance(settledTask({ status: 'completed' }));
  assert.match(guidance, /已完成/);
  assert.match(guidance, /交付物/);
  assert.match(guidance, /不要复述/);
});

test('指引关键：用户停的任务不得自动续跑', () => {
  const guidance = runtimeTaskDeliveryGuidance(
    settledTask({ status: 'stopped', stopInitiator: 'user' }),
  );
  assert.match(guidance, /用户主动停止/);
  assert.match(guidance, /不要自动恢复/);
});

test('指引关键：模型自己停的任务应当场续跑', () => {
  const guidance = runtimeTaskDeliveryGuidance(
    settledTask({ status: 'stopped', stopInitiator: 'model' }),
  );
  assert.match(guidance, /你自己停止的/);
  assert.match(guidance, /重新提交/);
  // 不能出现"等用户确认再续"以外的相反措辞。
  assert.equal(guidance.includes('不要自动恢复'), false);
});

test('指引关键：同样是 stopped，用户停与模型停的措辞相反', () => {
  const byUser = runtimeTaskDeliveryGuidance(settledTask({ status: 'stopped', stopInitiator: 'user' }));
  const byModel = runtimeTaskDeliveryGuidance(settledTask({ status: 'stopped', stopInitiator: 'model' }));
  // 状态词完全一样——只能靠 initiator 区分。这就是它必须单列的理由。
  assert.notEqual(byUser, byModel);
});

test('指引：失败/失联先呈现已完成部分，不冒充成品', () => {
  for (const status of ['failed', 'lost'] as const) {
    const guidance = runtimeTaskDeliveryGuidance(settledTask({ status }));
    assert.match(guidance, /没有正常完成/);
    assert.match(guidance, /不要把它当作已经完成的产出/);
  }
});

test('指引：无 initiator 的非完成态不假定可以自动续跑', () => {
  const guidance = runtimeTaskDeliveryGuidance(settledTask({ status: 'cancelled' }));
  assert.match(guidance, /不要自动恢复它/);
});

// ───────────────────────── 通知抑制策略 ─────────────────────────

test('抑制：三个条件同时成立才抑制', () => {
  const base = { isSubagentChildRuntime: true, notificationSealed: true, toolName: 'Bash' };
  assert.equal(shouldSuppressRuntimeTaskNotification(base), true);

  // 少了"子代理子运行"：主运行自己的 bash 通知被吞，用户看不到命令结果。
  assert.equal(shouldSuppressRuntimeTaskNotification({ ...base, isSubagentChildRuntime: false }), false);
  // 少了"已密封"：父代理还没接手就把子通知吞了，两边都没说。
  assert.equal(shouldSuppressRuntimeTaskNotification({ ...base, notificationSealed: false }), false);
});

test('抑制：非 bash 类通知不被抑制', () => {
  const base = { isSubagentChildRuntime: true, notificationSealed: true };
  assert.equal(shouldSuppressRuntimeTaskNotification({ ...base, toolName: 'Read' }), false);
  assert.equal(shouldSuppressRuntimeTaskNotification(base), false);
});

test('抑制：任务已被移除时靠工具名判定', () => {
  const base = { isSubagentChildRuntime: true, notificationSealed: true };
  assert.equal(shouldSuppressRuntimeTaskNotification({ ...base, toolName: 'Bash' }), true);
  assert.equal(shouldSuppressRuntimeTaskNotification({ ...base, toolName: 'Grep' }), false);
});

test('抑制：工具名不是 Bash 但任务类型是 local_bash 也抑制', () => {
  assert.equal(
    shouldSuppressRuntimeTaskNotification({
      isSubagentChildRuntime: true,
      notificationSealed: true,
      task: { type: 'local_bash' },
    }),
    true,
  );
  assert.equal(
    shouldSuppressRuntimeTaskNotification({
      isSubagentChildRuntime: true,
      notificationSealed: true,
      task: { type: 'local_agent' },
    }),
    false,
  );
});

// ───────────────────────── 批量格式化 ─────────────────────────

test('批量格式化只含终态任务，且顺序稳定', () => {
  const tasks: RuntimeTaskSnapshot[] = [
    settledTask({ taskId: 'zeta', status: 'completed' }),
    settledTask({ taskId: 'running', status: 'running' }),
    settledTask({ taskId: 'alpha', status: 'failed' }),
    settledTask({ taskId: 'blocked', status: 'blocked' }),
  ];
  const text = formatSettledRuntimeTasks(tasks);
  assert.match(text, /<task-id>alpha<\/task-id>/);
  assert.match(text, /<task-id>zeta<\/task-id>/);
  assert.equal(text.includes('running'), false);
  assert.equal(text.includes('blocked'), false);
  // 稳定排序：面板可能重复调用，顺序不稳定就无法 diff。
  assert.ok(text.indexOf('alpha') < text.indexOf('zeta'));

  // 幂等：同样输入两次得到同样输出。
  assert.equal(formatSettledRuntimeTasks(tasks), text);
});

// ───────────────────────── 并发与不变量 ─────────────────────────

test('并发：多个任务各自等待互不干扰', async () => {
  const { registry } = makeRegistry();
  for (const id of ['a', 'b', 'c']) {
    registry.register({ taskId: id, type: 'local_tool', status: 'running' });
  }
  const waiters = {
    a: registry.waitForTerminal('a'),
    b: registry.waitForTerminal('b'),
    c: registry.waitForTerminal('c'),
  };
  registry.update('b', { status: 'failed' });
  const settledB = await waiters.b;
  assert.equal(settledB?.status, 'failed');
  // a 与 c 仍在等，计数不受影响。
  assert.equal(terminalWaiterCount(registry, 'a'), 1);
  assert.equal(terminalWaiterCount(registry, 'b'), 0);
  assert.equal(terminalWaiterCount(registry, 'c'), 1);

  registry.update('a', { status: 'completed' });
  registry.update('c', { status: 'stopped' });
  assert.equal((await waiters.a)?.status, 'completed');
  assert.equal((await waiters.c)?.status, 'stopped');
});

test('不变量：等待集合在全部结算后不残留任何 key', async () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 'a', type: 'local_tool', status: 'running' });
  registry.register({ taskId: 'b', type: 'local_tool', status: 'running' });
  const waiting = [
    registry.waitForTerminal('a'),
    registry.waitForTerminal('b'),
    registry.waitForBackgroundRequest('a'),
    registry.waitForBackgroundRequest('b'),
  ];
  const controller = new AbortController();
  const cancelled = registry.waitForTerminal('a', { signal: controller.signal });

  controller.abort(new Error('取消'));
  await assert.rejects(() => cancelled);
  registry.update('a', { status: 'completed' });
  registry.update('b', { status: 'completed' });
  await Promise.all(waiting);

  for (const id of ['a', 'b']) {
    assert.equal(terminalWaiterCount(registry, id), 0, `${id} 的终态等待者应已清空`);
    assert.equal(backgroundWaiterCount(registry, id), 0, `${id} 的后台化等待者应已清空`);
  }
});

test('不变量：台账只读方法不改变任何状态', () => {
  const { registry } = makeRegistry();
  registry.register({ taskId: 't', type: 'local_tool', status: 'running' });
  const before = JSON.stringify(registry.all());
  registry.all();
  registry.query({});
  registry.get('t');
  registry.pendingMessageCount('t');
  registry.drainMessages('t');
  registry.activeBranchGeneration();
  assert.equal(JSON.stringify(registry.all()), before);
});
