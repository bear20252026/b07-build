import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startLocalGateway } from '../src/gateway-application.js';

const DATABASE_VARIABLES = [
  'AWO_SNAPSHOT_DB',
  'AWO_KNOWLEDGE_WORKSPACE_DB',
  'AWO_KNOWLEDGE_WORKSPACE_DIR',
  'AWO_RECEIPT_DB',
  'AWO_SUBTASK_DB',
  'AWO_MCP_MANIFEST_DB',
  'AWO_EXTENSION_MANIFEST_DB',
  'AWO_EXTENSION_PLAN_DB',
  'AWO_PROVIDER_PROFILE_DB',
  'AWO_SKILL_PACK_DB',
  'AWO_AGENT_ADAPTER_MANIFEST_DB',
  'AWO_AGENT_ADAPTER_SESSION_DB',
  'AWO_AGENT_ADAPTER_MAILBOX_DB',
  'AWO_SCHEDULE_MANIFEST_DB',
  'AWO_SCHEDULE_RUN_DB',
  'AWO_RUN_TRAJECTORY_DB',
  'AWO_ADMINISTRATOR_LEASE_DB',
  'AWO_TRUSTED_DESKTOP_ISSUER_DB',
] as const;

async function withGateway<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'awo-gateway-http-'));
  const previous = new Map<string, string | undefined>();
  for (const key of DATABASE_VARIABLES) {
    previous.set(key, process.env[key]);
    process.env[key] = join(root, `${key.toLowerCase()}.sqlite`);
  }
  process.env.AWO_KNOWLEDGE_WORKSPACE_DIR = join(root, 'knowledge-workspaces');
  const application = startLocalGateway(0);
  try {
    const port = await application.ready;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    application.close();
    for (const key of DATABASE_VARIABLES) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { force: true, recursive: true });
  }
}

test('Gateway 强制 Task Submit HTTP v1，并提供脱敏且只读的 run trajectory', async () => {
  await withGateway(async (baseUrl) => {
    const localHealth = await fetch(`${baseUrl}/api/local-models/health`);
    assert.equal(localHealth.status, 200);
    assert.deepEqual(await localHealth.json(), []);
    const prohibitedLocalModelWrite = await fetch(`${baseUrl}/api/local-models/health`, { method: 'POST' });
    assert.equal(prohibitedLocalModelWrite.status, 404);

    const diagnostics = await fetch(`${baseUrl}/api/control-plane/diagnostics`);
    assert.equal(diagnostics.status, 200);
    const diagnosticReport = await diagnostics.json() as { canExecute: boolean; authority: { adminIssuance: string; browserCanIssue: boolean }; extensions: unknown[]; skillPacks: unknown[]; providers: unknown[]; trustedDesktopIssuers: unknown[] };
    assert.equal(diagnosticReport.canExecute, false);
    assert.deepEqual(diagnosticReport.authority, { adminIssuance: 'trusted-desktop-host-required', browserCanIssue: false, canExecute: false });
    assert.deepEqual(diagnosticReport.extensions, []);
    assert.deepEqual(diagnosticReport.skillPacks, []);
    assert.deepEqual(diagnosticReport.providers, []);
    assert.deepEqual(diagnosticReport.trustedDesktopIssuers, []);
    const prohibitedDiagnosticWrite = await fetch(`${baseUrl}/api/control-plane/diagnostics`, { method: 'POST' });
    assert.equal(prohibitedDiagnosticWrite.status, 404);

    const automated = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'authority-automate-accepted' },
      body: JSON.stringify({ schemaVersion: 1, goal: '受控自动完成本地任务', profileId: 'build', authorityMode: 'automate' }),
    });
    assert.equal(automated.status, 201);
    assert.equal((await automated.json() as { authorityMode?: string }).authorityMode, 'automate');

    const rejectedAdmin = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'authority-admin-rejected' },
      body: JSON.stringify({ schemaVersion: 1, goal: '不可信 HTTP 不得签发管理员租约', profileId: 'build', authorityMode: 'admin', administratorLease: { operatorId: 'owner-local', allowedCapabilities: ['filesystem.write'], reason: 'maintenance' } }),
    });
    assert.equal(rejectedAdmin.status, 403);

    const missingVersion = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'contract-missing-version' },
      body: JSON.stringify({ goal: 'missing contract version', profileId: 'plan' }),
    });
    assert.equal(missingVersion.status, 400);

    const privateGoal = '此私密目标不得出现在默认运行轨迹中';
    const submitted = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'contract-v1-accepted' },
      body: JSON.stringify({ schemaVersion: 1, goal: privateGoal, profileId: 'plan' }),
    });
    assert.equal(submitted.status, 201);
    const snapshot = await submitted.json() as { taskId: string; runId: string };

    const trajectoryResponse = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/trajectory`);
    assert.equal(trajectoryResponse.status, 200);
    const trajectory = await trajectoryResponse.json() as readonly Record<string, unknown>[];
    assert.equal(trajectory.length >= 3, true);
    assert.equal(JSON.stringify(trajectory).includes(privateGoal), false);
    assert.equal(trajectory.every((event) => event.canReplaySideEffects === false), true);
    assert.equal(trajectory[0].source, 'gateway.intent');
  });
});


test('Gateway 将 external provenance 绑定到快照、轨迹与幂等指纹，并在 automate 下保持 taint 失败关闭', async () => {
  await withGateway(async (baseUrl) => {
    const provenance = [{ schemaVersion: 1, inputId: 'web-brief-1', trust: 'external-untrusted', sourceKind: 'web', contentDigest: 'a'.repeat(64) }];
    const submitted = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'taint-provenance-bound' },
      body: JSON.stringify({ schemaVersion: 1, goal: '总结外部不可信资料', profileId: 'build', authorityMode: 'automate', inputProvenance: provenance }),
    });
    assert.equal(submitted.status, 201);
    const snapshot = await submitted.json() as { taskId: string; runId: string; status: string; inputProvenance: readonly { trust: string; contentDigest: string }[] };
    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.inputProvenance.length, 2);
    assert.equal(snapshot.inputProvenance.some((input) => input.trust === 'external-untrusted'), true);

    const trajectoryResponse = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/trajectory`);
    const trajectory = await trajectoryResponse.json() as readonly { kind: string; attributes: Record<string, unknown>; canReplaySideEffects: boolean }[];
    const provenanceEvent = trajectory.find((event) => event.kind === 'input.provenance.recorded');
    assert.ok(provenanceEvent);
    assert.equal(provenanceEvent?.attributes.externalUntrustedCount, 1);
    assert.equal(JSON.stringify(provenanceEvent).includes('a'.repeat(64)), false);
    assert.equal(provenanceEvent?.canReplaySideEffects, false);

    const alteredReplay = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'taint-provenance-bound' },
      body: JSON.stringify({ schemaVersion: 1, goal: '总结外部不可信资料', profileId: 'build', authorityMode: 'automate', inputProvenance: [{ ...provenance[0], trust: 'derived-untrusted', sourceKind: 'tool-output' }] }),
    });
    assert.equal(alteredReplay.status, 409);
  });
});
