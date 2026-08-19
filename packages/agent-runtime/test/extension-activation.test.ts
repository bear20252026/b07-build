import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExtensionActivationPlanner,
  ExtensionDoctor,
  ExtensionRegistry,
  InMemoryExtensionManifestStore,
  InMemoryExtensionPlanStore,
  RuleBasedCapabilityPolicy,
  SqliteExtensionPlanStore,
} from '../src/index.js';

const digest = 'd'.repeat(64);

function install(
  registry: ExtensionRegistry,
  id: string,
  options: Partial<{ kind: 'model-provider' | 'tool-adapter'; boundary: 'local-only' | 'external-allowed'; capabilities: readonly ('model.chat' | 'filesystem.read')[]; permissions: readonly ('model.chat' | 'filesystem.read')[]; mode: 'supervised-process' | 'in-process' }> = {},
): void {
  registry.discover({
    id,
    version: '1.0.0',
    kind: options.kind ?? 'model-provider',
    displayName: id,
    source: { type: 'local-path', locator: `/tmp/${id}`, digest },
    compatibility: { hostApiVersion: 'awo.extension.v1', protocols: ['awo.task-event.v1'] },
    declaredCapabilities: options.capabilities ?? ['model.chat'],
    requestedPermissions: options.permissions ?? ['model.chat'],
    dataBoundary: options.boundary ?? 'local-only',
    resourceBudget: { maxMemoryMb: 128, maxCpuMs: 1000, maxStartupMs: 100 },
    entry: { mode: options.mode ?? 'supervised-process', ref: `bin/${id}` },
    at: 1,
  });
  registry.review(id, 'local-admin', 2);
  registry.install(id, digest, 'local-admin', 3);
}

function target(overrides: Partial<{ requiredCapabilities: readonly ('model.chat' | 'filesystem.read')[]; maximumDataBoundary: 'local-only' | 'external-allowed'; requestedExtensionIds: readonly string[]; exclusiveKinds: readonly ('model-provider' | 'tool-adapter')[] }> = {}) {
  return {
    profileId: 'build' as const,
    requiredCapabilities: overrides.requiredCapabilities ?? ['model.chat'],
    requiredProtocols: ['awo.task-event.v1'],
    maximumDataBoundary: overrides.maximumDataBoundary ?? 'local-only',
    requestedExtensionIds: overrides.requestedExtensionIds,
    exclusiveKinds: overrides.exclusiveKinds,
  };
}

test('activation planner 仅为已安装且满足任务边界的 extension 输出 selected metadata，绝不授予执行权', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry, 'provider.local');
  const planner = new ExtensionActivationPlanner(
    registry,
    new RuleBasedCapabilityPolicy([{ capability: 'model.chat', decision: 'allow', reason: '本地模型允许' }]),
    new InMemoryExtensionPlanStore(),
  );
  const plan = planner.plan({ taskId: 'task-001', runId: 'run-001', target: target(), at: 10, planId: 'plan-001' });
  assert.equal(plan.outcome, 'ready');
  assert.deepEqual(plan.entries, [{
    extensionId: 'provider.local', revision: 3, kind: 'model-provider', decision: 'selected', reasons: [],
    effectiveCapabilities: ['model.chat'], canExecute: false,
  }]);
});

test('planner 保留策略拒绝、审批要求、数据边界与未安装状态的结构化原因', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry, 'provider.external', { boundary: 'external-allowed' });
  registry.discover({
    id: 'provider.discovered', version: '1.0.0', kind: 'model-provider', displayName: 'discovered',
    source: { type: 'local-path', locator: '/tmp/discovered', digest }, compatibility: { hostApiVersion: 'awo.extension.v1', protocols: ['awo.task-event.v1'] },
    declaredCapabilities: ['filesystem.read'], requestedPermissions: ['filesystem.read'], dataBoundary: 'local-only',
    resourceBudget: { maxMemoryMb: 64, maxCpuMs: 100, maxStartupMs: 100 }, at: 1,
  });
  const planner = new ExtensionActivationPlanner(
    registry,
    new RuleBasedCapabilityPolicy([
      { capability: 'model.chat', decision: 'require_approval', reason: '模型访问需审批' },
      { capability: 'filesystem.read', decision: 'deny', reason: '父任务拒绝读取' },
    ]),
    new InMemoryExtensionPlanStore(),
  );
  const plan = planner.plan({ taskId: 'task-002', runId: 'run-002', target: target({ requiredCapabilities: [] }), at: 10, planId: 'plan-002' });
  assert.equal(plan.outcome, 'blocked');
  assert.deepEqual(plan.entries.map((entry) => [entry.extensionId, entry.decision, entry.reasons.map((reason) => reason.code)]), [
    ['provider.discovered', 'blocked', ['NOT_INSTALLED', 'POLICY_DENIED']],
    ['provider.external', 'blocked', ['DATA_BOUNDARY_EXCEEDED', 'APPROVAL_REQUIRED']],
  ]);
});

test('同一独占 kind 的候选必须由请求显式缩小，不能静默选中一个 extension', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry, 'provider.one');
  install(registry, 'provider.two');
  const planner = new ExtensionActivationPlanner(
    registry,
    new RuleBasedCapabilityPolicy([{ capability: 'model.chat', decision: 'allow', reason: '允许' }]),
    new InMemoryExtensionPlanStore(),
  );
  const conflict = planner.plan({ taskId: 'task-003', runId: 'run-003', target: target(), at: 10, planId: 'plan-003' });
  assert.equal(conflict.outcome, 'blocked');
  assert.ok(conflict.entries.every((entry) => entry.reasons.some((reason) => reason.code === 'EXCLUSIVE_KIND_CONFLICT')));
  const narrowed = planner.plan({ taskId: 'task-003', runId: 'run-003', target: target({ requestedExtensionIds: ['provider.one'] }), at: 11, planId: 'plan-004' });
  assert.equal(narrowed.outcome, 'ready');
  assert.equal(narrowed.entries.find((entry) => entry.extensionId === 'provider.one')?.decision, 'selected');
  assert.equal(narrowed.entries.find((entry) => entry.extensionId === 'provider.two')?.decision, 'ignored');
});

test('doctor 只读取 metadata 并报告待审查、撤销与尚未支持的 in-process host 模式', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  registry.discover({
    id: 'tool.discovered', version: '1.0.0', kind: 'tool-adapter', displayName: 'discovered',
    source: { type: 'local-path', locator: '/tmp/tool', digest }, compatibility: { hostApiVersion: 'awo.extension.v1', protocols: [] },
    declaredCapabilities: [], requestedPermissions: [], dataBoundary: 'local-only', resourceBudget: { maxMemoryMb: 64, maxCpuMs: 100, maxStartupMs: 100 }, at: 1,
  });
  install(registry, 'provider.inprocess', { mode: 'in-process' });
  registry.revoke('provider.inprocess', 'local-admin', 4);
  const diagnostics = new ExtensionDoctor(registry).inspect();
  assert.deepEqual(diagnostics.map((item) => [item.extensionId, item.code]), [
    ['tool.discovered', 'REVIEW_REQUIRED'],
    ['provider.inprocess', 'REVOKED'],
  ]);
});

test('SQLite plan store 追加不可覆盖，重开后仍可按 task/run 审查计划', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-extension-plan-'));
  const filePath = join(directory, 'plans.sqlite');
  try {
    const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
    install(registry, 'provider.local');
    const store = new SqliteExtensionPlanStore(filePath);
    const planner = new ExtensionActivationPlanner(registry, new RuleBasedCapabilityPolicy([
      { capability: 'model.chat', decision: 'allow', reason: '允许' },
    ]), store);
    planner.plan({ taskId: 'task-005', runId: 'run-005', target: target(), at: 10, planId: 'plan-sqlite' });
    assert.throws(() => planner.plan({ taskId: 'task-005', runId: 'run-005', target: target(), at: 11, planId: 'plan-sqlite' }), /UNIQUE|已存在/);
    store.close();

    const reopened = new SqliteExtensionPlanStore(filePath);
    assert.deepEqual(reopened.list('task-005', 'run-005').map((plan) => plan.planId), ['plan-sqlite']);
    assert.equal(reopened.load('plan-sqlite')?.entries[0]?.canExecute, false);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
