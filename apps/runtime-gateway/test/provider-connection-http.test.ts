import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startLocalGateway } from '../src/gateway-application.js';

const DATABASE_VARIABLES = [
  'AWO_SNAPSHOT_DB', 'AWO_KNOWLEDGE_WORKSPACE_DB', 'AWO_KNOWLEDGE_WORKSPACE_DIR', 'AWO_RECEIPT_DB', 'AWO_SUBTASK_DB', 'AWO_MCP_MANIFEST_DB',
  'AWO_EXTENSION_MANIFEST_DB', 'AWO_EXTENSION_PLAN_DB', 'AWO_PROVIDER_PROFILE_DB', 'AWO_SKILL_PACK_DB', 'AWO_AGENT_ADAPTER_MANIFEST_DB',
  'AWO_AGENT_ADAPTER_SESSION_DB', 'AWO_AGENT_ADAPTER_MAILBOX_DB', 'AWO_SCHEDULE_MANIFEST_DB', 'AWO_SCHEDULE_RUN_DB', 'AWO_RUN_TRAJECTORY_DB',
  'AWO_ADMINISTRATOR_LEASE_DB', 'AWO_TRUSTED_DESKTOP_ISSUER_DB', 'AWO_COMPONENT_PROVENANCE_DB', 'AWO_COMPONENT_LOCKFILE_DB',
  'AWO_COMPONENT_MANAGEMENT_RECEIPT_DB', 'AWO_NATIVE_HOST_BRIDGE_TRUST_DB', 'AWO_NATIVE_HOST_CHALLENGE_DB', 'AWO_WINDOWS_NATIVE_RELEASE_EVIDENCE_DB',
] as const;

async function withGateway<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'awo-provider-connection-http-'));
  const previous = new Map<string, string | undefined>();
  for (const key of DATABASE_VARIABLES) {
    previous.set(key, process.env[key]);
    process.env[key] = join(root, `${key.toLowerCase()}.sqlite`);
  }
  process.env.AWO_KNOWLEDGE_WORKSPACE_DIR = join(root, 'knowledge-workspaces');
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-never-returned';
  const app = startLocalGateway(0);
  try {
    return await run(`http://127.0.0.1:${await app.ready}`);
  } finally {
    app.close();
    for (const key of DATABASE_VARIABLES) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
}

test('Provider connections API 只投影脱敏目录，注册与激活均需要显式 operator intent', async () => {
  await withGateway(async (baseUrl) => {
    const listed = await fetch(`${baseUrl}/api/providers/connections`);
    assert.equal(listed.status, 200);
    const catalog = await listed.json() as readonly Record<string, unknown>[];
    assert.equal(catalog.length >= 6, true);
    const openai = catalog.find((item) => item.providerId === 'openai');
    assert.deepEqual(Object.keys(openai ?? {}).sort(), ['canAutoConnect', 'canReadSecret', 'credentialAvailability', 'credentialReference', 'defaultModel', 'displayName', 'driverId', 'profileStatus', 'providerId', 'schemaVersion']);
    assert.equal(JSON.stringify(catalog).includes('sk-test-never-returned'), false);
    assert.equal(JSON.stringify(catalog).includes('https://api.openai.com'), false);

    const prohibited = await fetch(`${baseUrl}/api/providers/connections/openai/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewedBy: 'desktop-owner' }) });
    assert.equal(prohibited.status, 403);
    const badBody = await fetch(`${baseUrl}/api/providers/connections/openai/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' }, body: JSON.stringify({ reviewedBy: 'desktop-owner', apiKey: 'forbidden' }) });
    assert.equal(badBody.status, 400);

    const registered = await fetch(`${baseUrl}/api/providers/connections/openai/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' }, body: JSON.stringify({ reviewedBy: 'desktop-owner' }) });
    assert.equal(registered.status, 201);
    assert.equal((await registered.json() as { profileStatus: string }).profileStatus, 'registered');
    const activated = await fetch(`${baseUrl}/api/providers/connections/openai/activate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'provider-connection-v1' }, body: JSON.stringify({ reviewedBy: 'desktop-owner' }) });
    assert.equal(activated.status, 200);
    const active = await activated.json() as Record<string, unknown>;
    assert.equal(active.profileStatus, 'active');
    assert.equal(JSON.stringify(active).includes('sk-test-never-returned'), false);
  });
});
