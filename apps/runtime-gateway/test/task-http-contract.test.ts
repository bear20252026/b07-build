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
  'AWO_RUN_WORKSPACE_LEDGER_DB',
  'AWO_TASK_FILE_WORKSPACE_DB',
  'AWO_TASK_FILE_ROOT',
  'AWO_ADMINISTRATOR_LEASE_DB',
  'AWO_TRUSTED_DESKTOP_ISSUER_DB',
  'AWO_COMPONENT_PROVENANCE_DB',
  'AWO_COMPONENT_LOCKFILE_DB',
  'AWO_COMPONENT_MANAGEMENT_RECEIPT_DB',
  'AWO_NATIVE_HOST_BRIDGE_TRUST_DB',
  'AWO_NATIVE_HOST_CHALLENGE_DB',
  'AWO_WINDOWS_NATIVE_RELEASE_EVIDENCE_DB',
] as const;

async function withGateway<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'awo-gateway-http-'));
  const previous = new Map<string, string | undefined>();
  for (const key of DATABASE_VARIABLES) {
    previous.set(key, process.env[key]);
    process.env[key] = join(root, `${key.toLowerCase()}.sqlite`);
  }
  process.env.AWO_KNOWLEDGE_WORKSPACE_DIR = join(root, 'knowledge-workspaces');
  process.env.AWO_TASK_FILE_ROOT = join(root, 'task-file-root');
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
      body: JSON.stringify({ schemaVersion: 1, goal: privateGoal, profileId: 'build' }),
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

    const workspaceResponse = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/workspace`);
    assert.equal(workspaceResponse.status, 200);
    const artifacts = await workspaceResponse.json() as readonly { reference: string; referenceDigest: string; containsSensitiveContent: boolean; canReplaySideEffects: boolean }[];
    assert.equal(artifacts.length >= 1, true);
    assert.equal(artifacts.every((artifact) => /^local:\/\/task\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$|^artifact:\/\/[A-Za-z0-9._:-]+$/.test(artifact.reference)), true);
    assert.equal(artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.referenceDigest) && artifact.containsSensitiveContent === false && artifact.canReplaySideEffects === false), true);
    assert.equal(JSON.stringify(artifacts).includes(privateGoal), false);
    assert.equal((await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/workspace`, { method: 'POST' })).status, 404);

    const checkpointsResponse = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/checkpoints`);
    assert.equal(checkpointsResponse.status, 200);
    const checkpoints = await checkpointsResponse.json() as readonly { attempt: number; artifactCount: number; canResume: boolean; canReplaySideEffects: boolean; nodeOutcomeDigest: string; artifactManifestDigest: string }[];
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.attempt, 1);
    assert.equal(checkpoints[0]?.artifactCount, artifacts.length);
    assert.equal(checkpoints[0]?.canResume, true);
    assert.equal(checkpoints[0]?.canReplaySideEffects, false);
    assert.equal(/^[a-f0-9]{64}$/.test(checkpoints[0]?.nodeOutcomeDigest ?? ''), true);
    assert.equal(/^[a-f0-9]{64}$/.test(checkpoints[0]?.artifactManifestDigest ?? ''), true);
    assert.equal((await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/checkpoints`, { method: 'POST' })).status, 404);
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


test('Gateway Component Lock Report 只投影冷路径隔离决定，拒绝登记、修复或激活动作', async () => {
  await withGateway(async (baseUrl) => {
    const reportResponse = await fetch(`${baseUrl}/api/components/lock-report`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json() as { schemaVersion: number; decisions: readonly unknown[]; canActivate: boolean; canAutoRepair: boolean; lockfile?: unknown };
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.decisions, []);
    assert.equal(report.lockfile, undefined);
    assert.equal(report.canActivate, false);
    assert.equal(report.canAutoRepair, false);

    const writeAttempt = await fetch(`${baseUrl}/api/components/lock-report`, { method: 'POST', body: '{}' });
    assert.equal(writeAttempt.status, 404);
  });
});

test('Gateway Native Host Authentication Report 仅投影脱敏 bridge/nonce 摘要，普通 HTTP 无法认证或获取 challenge', async () => {
  await withGateway(async (baseUrl) => {
    const reportResponse = await fetch(`${baseUrl}/api/native-host-authentication`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json() as { schemaVersion: number; bridges: readonly unknown[]; challengeSummary: { issued: number; consumedVerified: number; consumedRejected: number }; browserCanAuthenticate: boolean; canIssueChallenge: boolean; canExecute: boolean };
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.bridges, []);
    assert.deepEqual(report.challengeSummary, { issued: 0, consumedVerified: 0, consumedRejected: 0 });
    assert.equal(report.browserCanAuthenticate, false);
    assert.equal(report.canIssueChallenge, false);
    assert.equal(report.canExecute, false);

    const writeAttempt = await fetch(`${baseUrl}/api/native-host-authentication`, { method: 'POST', body: JSON.stringify({ nonce: 'a'.repeat(64), signatureBase64: 'forbidden' }) });
    assert.equal(writeAttempt.status, 404);
  });
});

test('Gateway Windows Native Release Report 仅投影脱敏 Windows evidence，普通 HTTP 无法采集、比对或信任 bridge', async () => {
  await withGateway(async (baseUrl) => {
    const reportResponse = await fetch(`${baseUrl}/api/windows/native-release-evidence`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json() as { schemaVersion: number; platform: string; evidences: readonly unknown[]; windowsOnly: boolean; browserCanCaptureEvidence: boolean; canRegisterBridge: boolean; canTrustBridge: boolean; canExecute: boolean };
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.platform, 'windows');
    assert.deepEqual(report.evidences, []);
    assert.deepEqual([report.windowsOnly, report.browserCanCaptureEvidence, report.canRegisterBridge, report.canTrustBridge, report.canExecute], [true, false, false, false, false]);
    const writeAttempt = await fetch(`${baseUrl}/api/windows/native-release-evidence`, { method: 'POST', body: JSON.stringify({ helperPath: 'forbidden', authenticodeStatus: 'valid' }) });
    assert.equal(writeAttempt.status, 404);
  });
});

test('Gateway Component Management Receipt Report 仅可观察脱敏回执，普通 HTTP 不能调用本地宿主管理 authority', async () => {
  await withGateway(async (baseUrl) => {
    const reportResponse = await fetch(`${baseUrl}/api/components/management-receipts`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json() as { schemaVersion: number; receipts: readonly unknown[]; browserCanManage: boolean; canExecute: boolean; canAutoRemediate: boolean };
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(report.receipts, []);
    assert.equal(report.browserCanManage, false);
    assert.equal(report.canExecute, false);
    assert.equal(report.canAutoRemediate, false);

    const writeAttempt = await fetch(`${baseUrl}/api/components/management-receipts`, { method: 'POST', body: JSON.stringify({ action: 'register-candidate' }) });
    assert.equal(writeAttempt.status, 404);
  });
});

test('Gateway Security Posture Audit 只输出冷路径 finding，拒绝任何修复或控制方法', async () => {
  await withGateway(async (baseUrl) => {
    const audit = await fetch(`${baseUrl}/api/security-posture/audit`);
    assert.equal(audit.status, 200);
    const report = await audit.json() as { canExecute: boolean; canAutoRemediate: boolean; findings: readonly { checkId: string; canExecute: boolean; canAutoRemediate: boolean; evidenceDigest: string }[] };
    assert.equal(report.canExecute, false);
    assert.equal(report.canAutoRemediate, false);
    assert.equal(report.findings.some((finding) => finding.checkId === 'providers.active-missing'), true);
    assert.equal(report.findings.some((finding) => finding.checkId === 'recovery.drill-missing'), true);
    assert.equal(report.findings.every((finding) => finding.canExecute === false && finding.canAutoRemediate === false && /^[a-f0-9]{64}$/.test(finding.evidenceDigest)), true);

    const writeAttempt = await fetch(`${baseUrl}/api/security-posture/audit`, { method: 'POST', body: '{}' });
    assert.equal(writeAttempt.status, 404);
  });
});

test('Gateway 仅在已批准的 filesystem.write 后公开 task/run 专属文件，并提供显式 ZIP 交付', async () => {
  await withGateway(async (baseUrl) => {
    const submitted = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'p13-files-task-submit' },
      body: JSON.stringify({ schemaVersion: 1, goal: '生成一份可审查的本地交付说明', profileId: 'build', authorityMode: 'review' }),
    });
    assert.equal(submitted.status, 201);
    const snapshot = await submitted.json() as { taskId: string; runId: string; status: string };
    assert.equal(snapshot.status, 'blocked');

    const beforeApproval = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/files`);
    assert.equal(beforeApproval.status, 200);
    assert.deepEqual(await beforeApproval.json(), []);

    const approved = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/approvals/deliver`, {
      method: 'POST',
      headers: { 'idempotency-key': 'p13-files-deliver-approval' },
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json() as { status: string }).status, 'completed');

    const filesResponse = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/files`);
    assert.equal(filesResponse.status, 200);
    const files = await filesResponse.json() as readonly { taskFileId: string; logicalPath: string; sha256: string; canExecute: boolean; containsSensitiveContent: boolean }[];
    assert.equal(files.length, 1);
    const file = files[0];
    assert.ok(file);
    assert.equal(file.logicalPath, 'deliverables/task-delivery.md');
    assert.equal(file.canExecute, false);
    assert.equal(file.containsSensitiveContent, false);
    assert.equal(/^[a-f0-9]{64}$/.test(file.sha256), true);
    assert.equal(JSON.stringify(files).includes('生成一份可审查的本地交付说明'), false);

    const preview = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/files/${file.taskFileId}/preview`);
    assert.equal(preview.status, 200);
    const previewJson = await preview.json() as { language: string; content: string; truncated: boolean };
    assert.equal(previewJson.language, 'markdown');
    assert.match(previewJson.content, /可自动执行：否/);
    assert.equal(previewJson.truncated, false);

    const diff = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/files/${file.taskFileId}/diff`);
    assert.equal(diff.status, 200);
    assert.equal((await diff.json() as { previousVersion?: number }).previousVersion, undefined);

    const missingKey = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/deliveries`, { method: 'POST' });
    assert.equal(missingKey.status, 400);
    const deliveryRequest = { method: 'POST', headers: { 'idempotency-key': 'p13-delivery-create' } };
    const deliveryResponse = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/deliveries`, deliveryRequest);
    assert.equal(deliveryResponse.status, 201);
    const receipt = await deliveryResponse.json() as { deliveryId: string; fileCount: number; sha256: string; canAutoExecute: boolean; canAutoExtract: boolean };
    assert.equal(receipt.fileCount, 1);
    assert.equal(receipt.canAutoExecute, false);
    assert.equal(receipt.canAutoExtract, false);
    assert.equal(/^[a-f0-9]{64}$/.test(receipt.sha256), true);

    const repeated = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/deliveries`, deliveryRequest);
    assert.equal(repeated.status, 201);
    assert.equal((await repeated.json() as { deliveryId: string }).deliveryId, receipt.deliveryId);
    const download = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/${snapshot.runId}/deliveries/${receipt.deliveryId}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/zip');
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="ai-work-os-/);
    const body = Buffer.from(await download.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString('hex'), '504b0304');
    assert.match(body.toString('utf8'), /task-delivery\.md/);

    const crossRun = await fetch(`${baseUrl}/api/tasks/${snapshot.taskId}/run-not-this-one/files/${file.taskFileId}/preview`);
    assert.equal(crossRun.status, 404);
  });
});
