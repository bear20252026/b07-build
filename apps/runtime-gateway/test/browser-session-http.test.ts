import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startLocalGateway } from '../src/gateway-application.js';

const DATABASE_VARIABLES = [
  'AWO_SNAPSHOT_DB', 'AWO_KNOWLEDGE_WORKSPACE_DB', 'AWO_KNOWLEDGE_WORKSPACE_DIR', 'AWO_RECEIPT_DB', 'AWO_SUBTASK_DB',
  'AWO_MCP_MANIFEST_DB', 'AWO_EXTENSION_MANIFEST_DB', 'AWO_EXTENSION_PLAN_DB', 'AWO_PROVIDER_PROFILE_DB', 'AWO_API_USAGE_DB', 'AWO_BROWSER_SESSION_DB',
  'AWO_SKILL_PACK_DB', 'AWO_KNOWLEDGE_IMPORT_DB', 'AWO_AGENT_ADAPTER_MANIFEST_DB', 'AWO_AGENT_ADAPTER_SESSION_DB',
  'AWO_AGENT_ADAPTER_MAILBOX_DB', 'AWO_SCHEDULE_MANIFEST_DB', 'AWO_SCHEDULE_RUN_DB', 'AWO_RUN_TRAJECTORY_DB',
  'AWO_RUN_WORKSPACE_LEDGER_DB', 'AWO_TASK_FILE_WORKSPACE_DB', 'AWO_TASK_FILE_ROOT', 'AWO_PROJECT_WORKSPACE_DB', 'AWO_ADMINISTRATOR_LEASE_DB',
  'AWO_TRUSTED_DESKTOP_ISSUER_DB', 'AWO_COMPONENT_PROVENANCE_DB', 'AWO_COMPONENT_LOCKFILE_DB', 'AWO_COMPONENT_MANAGEMENT_RECEIPT_DB',
  'AWO_NATIVE_HOST_BRIDGE_TRUST_DB', 'AWO_NATIVE_HOST_CHALLENGE_DB', 'AWO_WINDOWS_NATIVE_RELEASE_EVIDENCE_DB',
] as const;

async function withGateway<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'awo-browser-session-http-'));
  const prior = new Map<string, string | undefined>();
  for (const variable of DATABASE_VARIABLES) {
    prior.set(variable, process.env[variable]);
    process.env[variable] = join(root, `${variable.toLowerCase()}.sqlite`);
  }
  process.env.AWO_KNOWLEDGE_WORKSPACE_DIR = join(root, 'knowledge');
  process.env.AWO_TASK_FILE_ROOT = join(root, 'files');
  const app = startLocalGateway(0);
  try { return await run(`http://127.0.0.1:${await app.ready}`); } finally {
    app.close();
    for (const variable of DATABASE_VARIABLES) {
      const priorValue = prior.get(variable);
      if (priorValue === undefined) delete process.env[variable]; else process.env[variable] = priorValue;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function intent(name: string): HeadersInit {
  return { 'content-type': 'application/json', 'x-awo-operator-intent': `browser-session-${name}-v1` };
}

test('browser 会话 Gateway 仅记录脱敏授权状态，不授予网页、秘密、桌面或执行控制', async () => {
  await withGateway(async (baseUrl) => {
    const body = { by: 'local.operator', targetUrl: 'https://docs.example.com/private/path?token=never-returned', reason: '核对公开文档' };
    const missingIntent = await fetch(`${baseUrl}/api/browser-sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(missingIntent.status, 403);
    const invalidField = await fetch(`${baseUrl}/api/browser-sessions`, { method: 'POST', headers: intent('create'), body: JSON.stringify({ ...body, cookie: 'forbidden' }) });
    assert.equal(invalidField.status, 400);

    const created = await fetch(`${baseUrl}/api/browser-sessions`, { method: 'POST', headers: intent('create'), body: JSON.stringify(body) });
    assert.equal(created.status, 201);
    const snapshot = await created.json() as Record<string, unknown>;
    const snapshotText = JSON.stringify(snapshot);
    assert.equal(snapshot.status, 'requested');
    assert.equal(snapshot.targetHost, 'docs.example.com');
    assert.equal(snapshot.canExecute, false);
    assert.equal(snapshot.canReadPageContent, false);
    assert.equal(snapshot.canReadBrowserSecrets, false);
    assert.equal(snapshot.canControlDesktop, false);
    assert.equal(snapshotText.includes('/private/path'), false);
    assert.equal(snapshotText.includes('never-returned'), false);
    assert.equal(Object.hasOwn(snapshot, 'targetUrl'), false);
    const sessionId = String(snapshot.sessionId);
    const path = `${baseUrl}/api/browser-sessions/${encodeURIComponent(sessionId)}`;

    const unauthorizedTransition = await fetch(`${path}/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'local.operator' }) });
    assert.equal(unauthorizedTransition.status, 403);
    for (const action of ['authorize', 'pause', 'resume', 'end'] as const) {
      const response = await fetch(`${path}/${action}`, { method: 'POST', headers: intent(action), body: JSON.stringify({ by: 'local.operator', reason: `${action} review` }) });
      assert.equal(response.status, 200);
      const next = await response.json() as Record<string, unknown>;
      assert.equal(next.canExecute, false);
      assert.equal(next.canReadPageContent, false);
      assert.equal(next.canReadBrowserSecrets, false);
      assert.equal(next.canControlDesktop, false);
    }

    const sessions = await (await fetch(`${baseUrl}/api/browser-sessions?limit=1`)).json() as readonly Record<string, unknown>[];
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.status, 'ended');
    const events = await (await fetch(`${path}/events`)).json() as readonly Record<string, unknown>[];
    assert.deepEqual(events.map((event) => event.type), ['ended', 'resumed', 'paused', 'authorized', 'requested']);
    assert.equal(events.every((event) => event.canExecute === false), true);
    assert.equal((await fetch(`${baseUrl}/api/browser-sessions?limit=0`)).status, 400);
  });
});
