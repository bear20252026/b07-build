// 一个文件=一种作用：扩展宿主启动映射（激活计划 → ExtensionLaunchSpec）的验收测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExtensionActivationPlanner,
  ExtensionRegistry,
  InMemoryExtensionManifestStore,
  InMemoryExtensionPlanStore,
  InMemoryMcpManifestStore,
  McpRegistry,
  McpRegistryPluginBackendResolver,
  RuleBasedCapabilityPolicy,
  isAbsoluteExecutablePath,
  planExtensionHostLaunch,
  type ExtensionActivationPlan,
  type PluginBackendResolver,
  type PluginMcpAppDeclaration,
} from '../src/index.js';

const digest = 'e'.repeat(64);

/** 跨平台绝对可执行路径夹具：只做映射校验，不 spawn。 */
const ABSOLUTE_HOST = process.platform === 'win32'
  ? 'C:\\awo\\extension\\bin\\host.exe'
  : '/opt/awo/extension/bin/host';

function install(
  registry: ExtensionRegistry,
  id: string,
  options: Partial<{ budget: { maxMemoryMb: number; maxCpuMs: number; maxStartupMs: number } }> = {},
): void {
  registry.discover({
    id,
    version: '1.0.0',
    kind: 'tool-adapter',
    displayName: id,
    source: { type: 'local-path', locator: `/tmp/${id}`, digest },
    compatibility: { hostApiVersion: 'awo.extension.v1', protocols: ['awo.task-event.v1'] },
    declaredCapabilities: ['filesystem.read'],
    requestedPermissions: ['filesystem.read'],
    dataBoundary: 'local-only',
    resourceBudget: options.budget ?? { maxMemoryMb: 128, maxCpuMs: 1_000, maxStartupMs: 100 },
    entry: { mode: 'supervised-process', ref: `bin/${id}` },
    at: 1,
  });
  registry.review(id, 'local-admin', 2);
  registry.install(id, digest, 'local-admin', 3);
}

function planFor(
  registry: ExtensionRegistry,
  overrides: Partial<{ allowRead: boolean; requestedExtensionIds: readonly string[] }> = {},
): ExtensionActivationPlan {
  const policy = new RuleBasedCapabilityPolicy([
    {
      capability: 'filesystem.read',
      decision: overrides.allowRead === false ? 'deny' : 'allow',
      reason: '测试策略',
    },
  ]);
  const planner = new ExtensionActivationPlanner(registry, policy, new InMemoryExtensionPlanStore());
  return planner.plan({
    taskId: 'task-001',
    runId: 'run-001',
    planId: 'plan-001',
    at: 10,
    target: {
      profileId: 'build',
      requiredCapabilities: ['filesystem.read'],
      requiredProtocols: ['awo.task-event.v1'],
      maximumDataBoundary: 'local-only',
      requestedExtensionIds: overrides.requestedExtensionIds,
      exclusiveKinds: ['tool-adapter'],
    },
  });
}

/** 后端声明：插件 plugin.json 的 mcpApp 字段（这里只关心 serverId 解析）。 */
function declaration(serverId: string): PluginMcpAppDeclaration {
  return { serverId, htmlResourceUri: 'mcpapp://local/index.html', requestedToolNames: ['read_docs'] };
}

const okResolver: PluginBackendResolver = {
  resolve: () => ({ executable: ABSOLUTE_HOST, args: ['--transport', 'stdio'], resolvedBy: 'test' }),
};

function mcpRegistryWith(id: string, options: Partial<{ enabled: boolean; transport: 'stdio' | 'streamable_http'; executable: string }> = {}): McpRegistry {
  const registry = new McpRegistry(new InMemoryMcpManifestStore());
  registry.register({
    id,
    displayName: id,
    connection: options.transport === 'streamable_http'
      ? { transport: 'streamable_http', endpoint: 'https://example.test/mcp' }
      : { transport: 'stdio', executable: options.executable ?? 'npx', args: ['--yes', '@example/reviewed-mcp'] },
    declaredTools: [{ name: 'read_docs', description: '读取文档。', capability: 'filesystem.read', risk: 'low' }],
    sourceDigest: digest,
    reviewedBy: 'local-admin',
    at: 100,
  });
  if (options.enabled !== false) registry.enable(id, 'local-admin', 110);
  return registry;
}

test('选中的插件 + 可解析后端 → 产出启动规格，预算取自 manifest', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry, 'plugin.alpha');
  const decision = planExtensionHostLaunch({
    plan: planFor(registry),
    registry,
    backendDeclarations: new Map([['plugin.alpha', declaration('mcp-local')]]),
    resolver: okResolver,
  });
  assert.equal(decision.outcome, 'ready');
  assert.deepEqual(decision.rejections, []);
  assert.deepEqual(decision.launches, [{
    extensionId: 'plugin.alpha',
    // discover=1 → review=2 → install=3：激活计划引用的是 installed revision。
    revision: 3,
    executable: ABSOLUTE_HOST,
    args: ['--transport', 'stdio'],
    budget: { maxMemoryMb: 128, maxCpuMs: 1_000, maxStartupMs: 100 },
  }]);
});

test('blocked 计划绝不产出启动规格（fail-closed）', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry, 'plugin.alpha');
  // 策略 deny → 条目 blocked → 计划整体 blocked。
  const blockedPlan = planFor(registry, { allowRead: false });
  assert.equal(blockedPlan.outcome, 'blocked');
  const blocked = planExtensionHostLaunch({
    plan: blockedPlan,
    registry,
    backendDeclarations: new Map([['plugin.alpha', declaration('mcp-local')]]),
    resolver: okResolver,
  });
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(blocked.launches.length, 0);
  assert.deepEqual(blocked.rejections.map((entry) => entry.code), ['PLAN_NOT_READY']);
});

test('计划 ready 但条目未选中 → 该条目不启动', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry, 'plugin.alpha');
  install(registry, 'plugin.beta');
  // 请求只选中 plugin.beta：plugin.alpha 被标记为 ignored。
  const plan = planFor(registry, { requestedExtensionIds: ['plugin.beta'] });
  assert.equal(plan.outcome, 'ready');
  const decision = planExtensionHostLaunch({
    plan,
    registry,
    backendDeclarations: new Map([
      ['plugin.alpha', declaration('mcp-local')],
      ['plugin.beta', declaration('mcp-local')],
    ]),
    resolver: okResolver,
  });
  assert.deepEqual(decision.launches.map((entry) => entry.extensionId), ['plugin.beta']);
  assert.deepEqual(
    decision.rejections.map((entry) => [entry.extensionId, entry.code]),
    [['plugin.alpha', 'ENTRY_NOT_SELECTED']],
  );
});

test('缺失后端声明 / 适配器解析失败 / 相对路径 一律拒绝', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry, 'plugin.alpha');
  const plan = planFor(registry);

  const missing = planExtensionHostLaunch({
    plan,
    registry,
    backendDeclarations: new Map(),
    resolver: okResolver,
  });
  assert.deepEqual(missing.rejections.map((entry) => entry.code), ['BACKEND_DECLARATION_MISSING']);

  const unresolved = planExtensionHostLaunch({
    plan,
    registry,
    backendDeclarations: new Map([['plugin.alpha', declaration('mcp-local')]]),
    resolver: { resolve: () => undefined },
  });
  assert.deepEqual(unresolved.rejections.map((entry) => entry.code), ['BACKEND_NOT_RESOLVED']);

  const relative = planExtensionHostLaunch({
    plan,
    registry,
    backendDeclarations: new Map([['plugin.alpha', declaration('mcp-local')]]),
    resolver: { resolve: () => ({ executable: 'npx', args: [], resolvedBy: 'test' }) },
  });
  assert.deepEqual(relative.rejections.map((entry) => entry.code), ['EXECUTABLE_NOT_ABSOLUTE']);
  assert.equal(relative.outcome, 'blocked');
});

test('预算越界与非法 args 拒绝，绝不静默截断', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry, 'plugin.alpha', { budget: { maxMemoryMb: 999_999, maxCpuMs: 1_000, maxStartupMs: 100 } });
  const budget = planExtensionHostLaunch({
    plan: planFor(registry),
    registry,
    backendDeclarations: new Map([['plugin.alpha', declaration('mcp-local')]]),
    resolver: okResolver,
  });
  assert.deepEqual(budget.rejections.map((entry) => entry.code), ['BUDGET_OUT_OF_RANGE']);

  const registry2 = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry2, 'plugin.alpha');
  const args = planExtensionHostLaunch({
    plan: planFor(registry2),
    registry: registry2,
    backendDeclarations: new Map([['plugin.alpha', declaration('mcp-local')]]),
    resolver: { resolve: () => ({ executable: ABSOLUTE_HOST, args: ['--flag\ninjected'], resolvedBy: 'test' }) },
  });
  assert.deepEqual(args.rejections.map((entry) => entry.code), ['ARGS_INVALID']);
});

test('默认适配器只把已启用、stdio 的 MCP server 解析成可执行声明', () => {
  const declarationValue = declaration('mcp-local');
  const enabledStdio = new McpRegistryPluginBackendResolver(mcpRegistryWith('mcp-local'));
  assert.deepEqual(enabledStdio.resolve(declarationValue), {
    executable: 'npx',
    args: ['--yes', '@example/reviewed-mcp'],
    resolvedBy: 'mcp:mcp-local',
  });
  // 未启用（仅登记）→ 拒绝。
  const disabled = new McpRegistryPluginBackendResolver(mcpRegistryWith('mcp-local', { enabled: false }));
  assert.equal(disabled.resolve(declarationValue), undefined);
  // HTTP 传输没有本地进程可承载 → 拒绝。
  const http = new McpRegistryPluginBackendResolver(mcpRegistryWith('mcp-local', { transport: 'streamable_http' }));
  assert.equal(http.resolve(declarationValue), undefined);
  // 未登记 serverId → 拒绝。
  const unknown = new McpRegistryPluginBackendResolver(mcpRegistryWith('other'));
  assert.equal(unknown.resolve(declarationValue), undefined);
});

test('默认适配器 + 绝对路径 MCP executable 端到端产出启动规格', () => {
  const registry = new ExtensionRegistry(new InMemoryExtensionManifestStore());
  install(registry, 'plugin.alpha');
  const resolver = new McpRegistryPluginBackendResolver(mcpRegistryWith('mcp-local', { executable: ABSOLUTE_HOST }));
  const decision = planExtensionHostLaunch({
    plan: planFor(registry),
    registry,
    backendDeclarations: new Map([['plugin.alpha', declaration('mcp-local')]]),
    resolver,
  });
  assert.equal(decision.outcome, 'ready');
  assert.equal(decision.launches[0]?.executable, ABSOLUTE_HOST);
});

test('绝对路径判定覆盖盘符 / UNC / POSIX，并拒绝 PATH 命令名与控制字符', () => {
  assert.equal(isAbsoluteExecutablePath('/opt/awo/host'), true);
  assert.equal(isAbsoluteExecutablePath('C:\\awo\\host.exe'), true);
  assert.equal(isAbsoluteExecutablePath('D:/awo/host.exe'), true);
  assert.equal(isAbsoluteExecutablePath('\\\\server\\share\\host.exe'), true);
  assert.equal(isAbsoluteExecutablePath('npx'), false);
  assert.equal(isAbsoluteExecutablePath('./bin/host'), false);
  assert.equal(isAbsoluteExecutablePath('bin\\host.exe'), false);
  assert.equal(isAbsoluteExecutablePath(''), false);
  assert.equal(isAbsoluteExecutablePath('/opt/awo/host\ninjected'), false);
  assert.equal(isAbsoluteExecutablePath('/opt/awo/\0host'), false);
});
