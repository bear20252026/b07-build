import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuditedScheduleControlPlane,
  InMemoryScheduleManifestStore,
  InMemoryScheduledRunStore,
  SqliteScheduleManifestStore,
  SqliteScheduledRunStore,
} from '../src/index.js';

const digest = 'f'.repeat(64);

function controlPlane() {
  return new AuditedScheduleControlPlane(new InMemoryScheduleManifestStore(), new InMemoryScheduledRunStore());
}

function register(control: AuditedScheduleControlPlane, id = 'schedule.daily-review', requiresApproval = false): void {
  control.registerCandidate({
    id,
    displayName: '本地复盘计划',
    taskTemplate: {
      id: 'template.daily-review', version: '1.0.0', digest, title: '每日本地复盘',
      goal: '汇总本地知识工作区的只读进展，生成可审计复盘草稿。', profileId: 'plan',
      requestedCapabilities: ['document.parse', 'model.chat', 'filesystem.read'],
    },
    trigger: { kind: 'interval', everyMs: 60_000, startAt: 100, timeZone: 'Asia/Shanghai', missedRunPolicy: 'skip' },
    budget: { maxInputTokens: 2000, maxOutputTokens: 800, maxToolCalls: 4, maxCpuMs: 30_000 },
    requiresApproval,
    note: '只登记未来意图；不启动后台任务。', at: 10,
  });
}

function enable(control: AuditedScheduleControlPlane, id = 'schedule.daily-review'): void {
  control.review(id, 'local-admin', 20, '模板、时区、预算已审查。');
  control.enable(id, 'local-admin', 30, '显式启用。');
}

test('Schedule 默认仅 candidate，审查并显式 enable 后才会生成独立 run 计划', () => {
  const control = controlPlane();
  register(control);
  assert.equal(control.getSchedule('schedule.daily-review')?.status, 'candidate');
  assert.deepEqual(control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-before-enable', at: 100 }), {
    scheduleId: 'schedule.daily-review', at: 100, due: false, reason: 'not_enabled',
  });
  enable(control);
  const plan = control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-on-time', at: 100 });
  assert.equal(plan.due, true);
  assert.equal(plan.run?.status, 'ready');
  assert.equal(plan.run?.runId, 'run-on-time');
  assert.equal(plan.run?.canAuthorize, false);
  assert.equal(plan.run?.canExecute, false);
  assert.deepEqual(control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-on-time', at: 101 }).run, plan.run);
});

test('Schedule 对每个 slot 记录独立 runId、预算和错过 slot 数，且不会补跑多个隐式任务', () => {
  const control = controlPlane();
  register(control);
  enable(control);
  control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-first', at: 100 });
  const delayed = control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-delayed', at: 180_100 });
  assert.equal(delayed.run?.scheduledFor, 180_100);
  assert.equal(delayed.run?.missedSlots, 2);
  assert.equal(control.listRuns('schedule.daily-review').length, 2);
  assert.equal(control.planDueRun({ scheduleId: 'schedule.daily-review', runId: 'run-first', at: 180_100 + 1 }).run?.runId, 'run-first');
  const copied = control.listRuns()[0];
  assert.ok(copied);
  (copied!.budget as { maxToolCalls: number }).maxToolCalls = 999;
  assert.equal(control.listRuns()[0]?.budget.maxToolCalls, 4);
});

test('高风险 Schedule 必须进入 approval inbox，人工批准仍不可执行且不会成为工具授权', () => {
  const control = controlPlane();
  assert.throws(() => control.registerCandidate({
    id: 'schedule.invalid-high-risk', displayName: 'Invalid',
    taskTemplate: { id: 'template.invalid', version: '1.0.0', digest, title: 'Invalid', goal: '运行 Shell 检查。', profileId: 'build', requestedCapabilities: ['shell.execute'] },
    trigger: { kind: 'interval', everyMs: 60_000, startAt: 100, timeZone: 'UTC', missedRunPolicy: 'one' },
    budget: { maxInputTokens: 100, maxOutputTokens: 100, maxToolCalls: 1, maxCpuMs: 1000 }, requiresApproval: false, at: 1,
  }), /requiresApproval/);
  control.registerCandidate({
    id: 'schedule.approval', displayName: '受审批本地检查',
    taskTemplate: { id: 'template.approval', version: '1.0.0', digest, title: '本地检查', goal: '请求运行经审批的本地检查。', profileId: 'build', requestedCapabilities: ['shell.execute'] },
    trigger: { kind: 'interval', everyMs: 60_000, startAt: 100, timeZone: 'UTC', missedRunPolicy: 'one' },
    budget: { maxInputTokens: 100, maxOutputTokens: 100, maxToolCalls: 1, maxCpuMs: 1000 }, requiresApproval: true, at: 1,
  });
  enable(control, 'schedule.approval');
  const pending = control.planDueRun({ scheduleId: 'schedule.approval', runId: 'run-approval', at: 100 }).run;
  assert.equal(pending?.status, 'pending_approval');
  assert.deepEqual(control.approvalInbox().map((run) => run.runId), ['run-approval']);
  const approved = control.approveRun('run-approval', 'local-admin', 101, '仅同意进入实时 policy 检查。');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.canAuthorize, false);
  assert.equal(approved.canExecute, false);
  assert.deepEqual(control.approvalInbox(), []);
});

test('停用或撤销 Schedule 会阻断未处理 run 的审批，撤销为终态', () => {
  const control = controlPlane();
  register(control, 'schedule.blocked', true);
  enable(control, 'schedule.blocked');
  const run = control.planDueRun({ scheduleId: 'schedule.blocked', runId: 'run-blocked', at: 100 }).run;
  assert.equal(run?.status, 'pending_approval');
  control.disable('schedule.blocked', 'local-admin', 101, '需要重新审查。');
  assert.throws(() => control.denyRun('run-blocked', 'local-admin', 102), /已停用、撤销或更新/);
  control.revoke('schedule.blocked', 'local-admin', 103, '任务模板撤销。');
  assert.throws(() => control.enable('schedule.blocked', 'local-admin', 104), /不能从 revoked/);
});

test('SQLite Schedule 与 run 账本追加 revision，在重开后保留 manifest/run 审计历史', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-audited-scheduler-'));
  try {
    const manifests = new SqliteScheduleManifestStore(join(directory, 'schedules.sqlite'));
    const runs = new SqliteScheduledRunStore(join(directory, 'runs.sqlite'));
    const control = new AuditedScheduleControlPlane(manifests, runs);
    register(control, 'schedule.sqlite');
    enable(control, 'schedule.sqlite');
    const created = control.planDueRun({ scheduleId: 'schedule.sqlite', runId: 'run-sqlite', at: 100 }).run;
    assert.ok(created);
    manifests.close(); runs.close();
    const reopenedManifests = new SqliteScheduleManifestStore(join(directory, 'schedules.sqlite'));
    const reopenedRuns = new SqliteScheduledRunStore(join(directory, 'runs.sqlite'));
    assert.deepEqual(reopenedManifests.history('schedule.sqlite').map((item) => item.status), ['candidate', 'reviewed', 'enabled']);
    assert.equal(reopenedRuns.load('run-sqlite')?.taskTemplate.digest, digest);
    reopenedManifests.close(); reopenedRuns.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
