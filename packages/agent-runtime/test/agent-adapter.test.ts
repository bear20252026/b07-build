import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentAdapterControlPlane,
  InMemoryAdapterApprovalMailboxStore,
  InMemoryAgentAdapterManifestStore,
  InMemoryAgentAdapterSessionStore,
  SqliteAdapterApprovalMailboxStore,
  SqliteAgentAdapterManifestStore,
  SqliteAgentAdapterSessionStore,
} from '../src/index.js';

const digest = 'c'.repeat(64);

function controlPlane() {
  return new AgentAdapterControlPlane(
    new InMemoryAgentAdapterManifestStore(),
    new InMemoryAgentAdapterSessionStore(),
    new InMemoryAdapterApprovalMailboxStore(),
  );
}

function register(control: AgentAdapterControlPlane, id = 'adapter.opencode'): void {
  control.registerCandidate({
    id,
    version: '1.0.0',
    displayName: 'OpenCode ACP Adapter',
    source: { type: 'local-path', locator: '/opt/awo/adapters/opencode', digest },
    protocol: {
      transport: 'acp-jsonrpc-stdio',
      supportedVersions: ['1.0'],
      declaredAgentCapabilities: ['session.new', 'prompt.text', 'session.cancel', 'permission.request'],
      requestedHostCapabilities: ['filesystem.read', 'filesystem.write', 'shell.execute'],
      independentSessions: true,
    },
    dataBoundary: 'local-only',
    connectionRef: 'extension-host.opencode-acp',
    note: '仅登记受控 ACP metadata；不启动 opencode。',
    at: 100,
  });
}

function review(control: AgentAdapterControlPlane, id = 'adapter.opencode'): void {
  control.review(id, digest, 'local-admin', 110, '来源和协议范围已复核。');
}

function negotiate(control: AgentAdapterControlPlane, session = 'adapter-session-one') {
  return control.negotiate({
    adapterId: 'adapter.opencode', adapterSessionId: session,
    parentTaskId: 'task-parent', parentRunId: 'run-parent', agentSessionId: 'external-session-42',
    transport: 'acp-jsonrpc-stdio', protocolVersion: '1.0',
    offeredCapabilities: ['session.new', 'prompt.text', 'terminal'], at: 120,
  });
}

test('Adapter manifest 默认仅 candidate，digest 审查后才可协商外部 Agent session', () => {
  const control = controlPlane();
  register(control);
  assert.equal(control.getManifest('adapter.opencode')?.status, 'candidate');
  assert.throws(() => negotiate(control), /未处于 reviewed/);
  assert.throws(() => control.review('adapter.opencode', 'd'.repeat(64), 'local-admin', 110), /digest 不一致/);
  review(control);
  assert.equal(control.getManifest('adapter.opencode')?.status, 'reviewed');
  assert.throws(() => control.registerCandidate({
    id: 'adapter.invalid', version: '1.0.0', displayName: 'Invalid adapter',
    source: { type: 'local-path', locator: '/tmp/adapter', digest },
    protocol: { transport: 'acp-jsonrpc-stdio', supportedVersions: ['1.0'], declaredAgentCapabilities: [], requestedHostCapabilities: [], independentSessions: false as unknown as true },
    dataBoundary: 'local-only', connectionRef: 'extension-host.invalid', at: 1,
  }), /independentSessions/);
});

test('ACP 能力协商仅接受 manifest 已审查能力，并将 host 与外部 session 明确隔离', () => {
  const control = controlPlane();
  register(control);
  review(control);
  const session = negotiate(control);
  assert.equal(session.adapterSessionId, 'adapter-session-one');
  assert.equal(session.agentSessionId, 'external-session-42');
  assert.notEqual(session.adapterSessionId, session.agentSessionId);
  assert.deepEqual(session.acceptedCapabilities, ['session.new', 'prompt.text']);
  assert.deepEqual(session.rejectedCapabilities, ['terminal']);
  assert.equal(session.status, 'negotiated');
  assert.throws(() => control.negotiate({
    adapterId: 'adapter.opencode', adapterSessionId: 'adapter-session-invalid',
    parentTaskId: 'task-parent', parentRunId: 'run-parent', agentSessionId: 'external-session-x',
    transport: 'cli-json-lines', protocolVersion: '1.0', offeredCapabilities: [], at: 121,
  }), /transport/);
});

test('只读桥只产生不可执行、不可授权意图；高风险外部请求只能进入 approval mailbox', () => {
  const control = controlPlane();
  register(control);
  review(control);
  negotiate(control, 'adapter-session-read');
  control.openBridge({ adapterSessionId: 'adapter-session-read', mode: 'read-only', at: 130 });
  const intent = control.proposeReadOnlyIntent({
    adapterSessionId: 'adapter-session-read', intentId: 'intent-read', capability: 'filesystem.read', summary: '读取仓库状态用于生成分析。', at: 131,
  });
  assert.equal(intent.canAuthorize, false);
  assert.equal(intent.canExecute, false);
  assert.throws(() => control.proposeReadOnlyIntent({
    adapterSessionId: 'adapter-session-read', intentId: 'intent-write', capability: 'filesystem.write' as unknown as 'filesystem.read', summary: '越权写入。', at: 132,
  }), /只读桥/);

  negotiate(control, 'adapter-session-approval');
  control.openBridge({ adapterSessionId: 'adapter-session-approval', mode: 'approval-required', at: 133 });
  const pending = control.proposeApproval({
    mailboxId: 'mailbox-write', adapterSessionId: 'adapter-session-approval', intentId: 'intent-write',
    capability: 'filesystem.write', summary: '请求写入已审核补丁。', at: 134,
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.canAuthorize, false);
  assert.equal(pending.canExecute, false);
  const approved = control.approveMailbox('mailbox-write', 'local-admin', 135, '批准意图；执行仍需实时 policy。');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.canAuthorize, false);
  assert.equal(approved.canExecute, false);
});

test('停用或撤销 Adapter 会阻断既有 session 的桥接和待处理审批，撤销为终态', () => {
  const control = controlPlane();
  register(control);
  review(control);
  negotiate(control, 'adapter-session-pending');
  control.openBridge({ adapterSessionId: 'adapter-session-pending', mode: 'approval-required', at: 130 });
  control.proposeApproval({
    mailboxId: 'mailbox-pending', adapterSessionId: 'adapter-session-pending', intentId: 'intent-pending',
    capability: 'shell.execute', summary: '请求运行本地检查。', at: 131,
  });
  control.disable('adapter.opencode', 'local-admin', 132, '审查已过期。');
  assert.throws(() => control.denyMailbox('mailbox-pending', 'local-admin', 133), /已停用、撤销或更新/);
  control.revoke('adapter.opencode', 'local-admin', 134, '来源撤销。');
  assert.throws(() => control.review('adapter.opencode', digest, 'local-admin', 135), /不能从 revoked/);
});

test('SQLite adapter、session 与 mailbox 账本追加 revision，在重开后保持审计历史与防御性拷贝', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-agent-adapter-'));
  try {
    const manifests = new SqliteAgentAdapterManifestStore(join(directory, 'manifests.sqlite'));
    const sessions = new SqliteAgentAdapterSessionStore(join(directory, 'sessions.sqlite'));
    const mailbox = new SqliteAdapterApprovalMailboxStore(join(directory, 'mailbox.sqlite'));
    const control = new AgentAdapterControlPlane(manifests, sessions, mailbox);
    register(control, 'adapter.sqlite');
    control.review('adapter.sqlite', digest, 'local-admin', 110);
    const session = control.negotiate({
      adapterId: 'adapter.sqlite', adapterSessionId: 'adapter-session-sqlite',
      parentTaskId: 'task-parent', parentRunId: 'run-parent', agentSessionId: 'external-session-sqlite',
      transport: 'acp-jsonrpc-stdio', protocolVersion: '1.0', offeredCapabilities: ['session.new'], at: 120,
    });
    const copy = control.getManifest('adapter.sqlite');
    assert.ok(copy);
    (copy!.protocol.declaredAgentCapabilities as string[]).push('terminal');
    assert.deepEqual(control.getManifest('adapter.sqlite')?.protocol.declaredAgentCapabilities, ['session.new', 'prompt.text', 'session.cancel', 'permission.request']);
    manifests.close(); sessions.close(); mailbox.close();

    const reopenedManifests = new SqliteAgentAdapterManifestStore(join(directory, 'manifests.sqlite'));
    const reopenedSessions = new SqliteAgentAdapterSessionStore(join(directory, 'sessions.sqlite'));
    const reopenedMailbox = new SqliteAdapterApprovalMailboxStore(join(directory, 'mailbox.sqlite'));
    assert.deepEqual(reopenedManifests.history('adapter.sqlite').map((item) => item.status), ['candidate', 'reviewed']);
    assert.equal(reopenedSessions.load(session.adapterSessionId)?.agentSessionId, 'external-session-sqlite');
    reopenedManifests.close(); reopenedSessions.close(); reopenedMailbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
