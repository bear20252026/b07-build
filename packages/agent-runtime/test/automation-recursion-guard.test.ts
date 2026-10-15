import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuditedScheduleControlPlane,
  InMemoryScheduleManifestStore,
  InMemoryScheduledRunStore,
  ScheduleRecursionGuardError,
  type ScheduleRecursionGuardCode,
  type ScheduleTurnFacts,
} from '../src/index.js';

const digest = 'f'.repeat(64);

function controlPlane() {
  return new AuditedScheduleControlPlane(new InMemoryScheduleManifestStore(), new InMemoryScheduledRunStore());
}

function registerRequest(id: string) {
  return {
    id,
    displayName: '本地复盘计划',
    taskTemplate: {
      id: 'template.daily-review', version: '1.0.0', digest, title: '每日本地复盘',
      goal: '汇总本地知识工作区的只读进展，生成可审计复盘草稿。', profileId: 'plan' as const,
      requestedCapabilities: ['document.parse', 'model.chat', 'filesystem.read'] as const,
    },
    trigger: { kind: 'interval' as const, everyMs: 60_000, startAt: 100, timeZone: 'Asia/Shanghai', missedRunPolicy: 'skip' as const },
    budget: { maxInputTokens: 2000, maxOutputTokens: 800, maxToolCalls: 4, maxCpuMs: 30_000 },
    requiresApproval: false,
    at: 10,
  };
}

function register(control: AuditedScheduleControlPlane, id = 'schedule.daily-review'): void {
  control.registerCandidate(registerRequest(id));
}

function enable(control: AuditedScheduleControlPlane, id = 'schedule.daily-review'): void {
  control.review(id, 'local-admin', 20, '模板、时区、预算已审查。');
  control.enable(id, 'local-admin', 30, '显式启用。');
}

function expectGuard(fn: () => unknown, code: ScheduleRecursionGuardCode, operation: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ScheduleRecursionGuardError, '应为 ScheduleRecursionGuardError');
    assert.equal(error.code, code);
    assert.equal(error.operation, operation);
    assert.equal(error.recoverable, false);
    assert.equal(error.retryable, false);
    return true;
  });
}

const AUTOMATION: ScheduleTurnFacts = { automationTurn: true };
const OFF_PEAK: ScheduleTurnFacts = { offPeakTurn: true };

test('automation 轮在写任务定义前拒绝，且拒绝基于本轮事实而非请求内容', () => {
  const control = controlPlane();
  // 即使请求本身非法，也先由本轮事实拒绝——handler 级最终裁决先于入参校验。
  expectGuard(
    () => control.registerCandidate({ ...registerRequest('schedule.bad'), displayName: '' }, AUTOMATION),
    'AUTOMATION_TURN_SCHEDULE_WRITE_DENIED',
    'registerCandidate',
  );
  assert.deepEqual(control.listSchedules(), [], '被拒的登记不得写入账本');
  expectGuard(
    () => control.registerCandidate(registerRequest('schedule.automation'), AUTOMATION),
    'AUTOMATION_TURN_SCHEDULE_WRITE_DENIED',
    'registerCandidate',
  );
  assert.deepEqual(control.listSchedules(), []);
});

test('automation 轮拒绝全部定义变更（review/enable/disable/revoke），只读入口放行', () => {
  const control = controlPlane();
  register(control, 'schedule.guarded');
  control.review('schedule.guarded', 'local-admin', 20);
  control.enable('schedule.guarded', 'local-admin', 30);
  expectGuard(() => control.review('schedule.guarded', 'local-admin', 40, undefined, AUTOMATION), 'AUTOMATION_TURN_SCHEDULE_WRITE_DENIED', 'review');
  expectGuard(() => control.disable('schedule.guarded', 'local-admin', 41, undefined, AUTOMATION), 'AUTOMATION_TURN_SCHEDULE_WRITE_DENIED', 'disable');
  expectGuard(() => control.revoke('schedule.guarded', 'local-admin', 42, undefined, AUTOMATION), 'AUTOMATION_TURN_SCHEDULE_WRITE_DENIED', 'revoke');
  expectGuard(() => control.enable('schedule.guarded', 'local-admin', 43, undefined, AUTOMATION), 'AUTOMATION_TURN_SCHEDULE_WRITE_DENIED', 'enable');
  // 被拒后定义保持原状；只读入口不受 automation 轮限制。
  assert.equal(control.getSchedule('schedule.guarded')?.status, 'enabled');
  assert.equal(control.listSchedules().length, 1);
  assert.deepEqual(control.listRuns('schedule.guarded'), []);
  assert.deepEqual(control.approvalInbox(), []);
});

test('automation 轮放行派生（planDueRun），与上游「cron 轮放行闲时派生」一致', () => {
  const control = controlPlane();
  register(control);
  enable(control);
  const plan = control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-automation', at: 100 }, AUTOMATION);
  assert.equal(plan.due, true);
  assert.equal(plan.run?.status, 'ready');
});

test('闲时派发轮在派生新 run 前拒绝', () => {
  const control = controlPlane();
  register(control);
  enable(control);
  expectGuard(
    () => control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-offpeak', at: 100 }, OFF_PEAK),
    'OFF_PEAK_TURN_DERIVATION_DENIED',
    'planDueRun',
  );
  assert.deepEqual(control.listRuns('schedule.daily-review'), [], '被拒的派生不得写入账本');
});

test('两条边界判据互不混同：闲时只看 offPeakTurn，automation 轮不受 offPeak 判据影响', () => {
  const control = controlPlane();
  register(control);
  enable(control);
  // automationTurn=true 且 offPeakTurn=false：派生放行（闲时判据不因 automation 轮触发）。
  assert.equal(
    control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-a', at: 100 }, { automationTurn: true, offPeakTurn: false }).due,
    true,
  );
  // offPeakTurn=true 且 automationTurn=false：派生被拒。
  expectGuard(
    () => control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-b', at: 200_100 }, { automationTurn: false, offPeakTurn: true }),
    'OFF_PEAK_TURN_DERIVATION_DENIED',
    'planDueRun',
  );
  // 闲时边界的 deny 列表只覆盖派生，不覆盖定义写（对齐上游 off-peak 工具清单）。
  assert.doesNotThrow(() => control.registerCandidate(registerRequest('schedule.from-offpeak'), OFF_PEAK));
});

test('无本轮事实（普通用户轮）时行为与既有控制面一致', () => {
  const control = controlPlane();
  assert.doesNotThrow(() => control.registerCandidate(registerRequest('schedule.normal')));
  assert.doesNotThrow(() => control.registerCandidate(registerRequest('schedule.normal-false'), { automationTurn: false, offPeakTurn: false }));
  control.review('schedule.normal', 'local-admin', 20);
  control.enable('schedule.normal', 'local-admin', 30);
  const plan = control.planDueRun({ scheduleId: 'schedule.normal', runId: 'run-normal', at: 100 });
  assert.equal(plan.due, true);
  assert.equal(plan.run?.canExecute, false);
});
