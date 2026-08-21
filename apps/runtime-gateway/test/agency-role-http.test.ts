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
  'AWO_RUN_WORKSPACE_LEDGER_DB', 'AWO_TASK_FILE_WORKSPACE_DB', 'AWO_TASK_FILE_ROOT', 'AWO_ADMINISTRATOR_LEASE_DB',
  'AWO_TRUSTED_DESKTOP_ISSUER_DB', 'AWO_COMPONENT_PROVENANCE_DB', 'AWO_COMPONENT_LOCKFILE_DB', 'AWO_COMPONENT_MANAGEMENT_RECEIPT_DB',
  'AWO_NATIVE_HOST_BRIDGE_TRUST_DB', 'AWO_NATIVE_HOST_CHALLENGE_DB', 'AWO_WINDOWS_NATIVE_RELEASE_EVIDENCE_DB',
] as const;

async function withGateway<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'awo-agency-role-http-'));
  const prior = new Map<string, string | undefined>();
  for (const variable of DATABASE_VARIABLES) { prior.set(variable, process.env[variable]); process.env[variable] = join(root, `${variable.toLowerCase()}.sqlite`); }
  process.env.AWO_KNOWLEDGE_WORKSPACE_DIR = join(root, 'knowledge'); process.env.AWO_TASK_FILE_ROOT = join(root, 'files');
  const app = startLocalGateway(0);
  try { return await run(`http://127.0.0.1:${await app.ready}`); } finally {
    app.close(); for (const variable of DATABASE_VARIABLES) { const priorValue = prior.get(variable); if (priorValue === undefined) delete process.env[variable]; else process.env[variable] = priorValue; }
    rmSync(root, { recursive: true, force: true });
  }
}

test('agency 角色目录需要显式详情和操作者 intent，候选仍走 Skill Pack 审查生命周期', async () => {
  await withGateway(async (baseUrl) => {
    const list = await (await fetch(`${baseUrl}/api/agency-roles`)).json() as readonly Record<string, unknown>[];
    assert.equal(list.length, 8);
    const architect = list.find((item) => item.id === 'agency.software-architect');
    assert.ok(architect);
    assert.equal(Object.hasOwn(architect, 'content'), false);
    assert.equal(architect?.canAutoInject, false); assert.equal(architect?.canAuthorize, false); assert.equal(architect?.canGrantCapabilities, false);
    const detail = await (await fetch(`${baseUrl}/api/agency-roles/agency.software-architect`)).json() as Record<string, unknown>;
    assert.equal(typeof detail.content, 'string');
    assert.equal(String(detail.content).includes('Copyright (c) 2025 AgentLand Contributors'), true);
    const forbidden = await fetch(`${baseUrl}/api/agency-roles/agency.software-architect/candidate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(forbidden.status, 403);
    const invalid = await fetch(`${baseUrl}/api/agency-roles/agency.software-architect/candidate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'agency-role-candidate-v1' }, body: JSON.stringify({ inject: true }) });
    assert.equal(invalid.status, 400);
    const created = await fetch(`${baseUrl}/api/agency-roles/agency.software-architect/candidate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'agency-role-candidate-v1' }, body: '{}' });
    assert.equal(created.status, 201);
    const result = await created.json() as { alreadyExists: boolean; pack: { status: string; id: string } };
    assert.equal(result.alreadyExists, false); assert.equal(result.pack.id, 'role.agency.software-architect'); assert.equal(result.pack.status, 'candidate');
    const duplicate = await (await fetch(`${baseUrl}/api/agency-roles/agency.software-architect/candidate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'agency-role-candidate-v1' }, body: '{}' })).json() as { alreadyExists: boolean; pack: { status: string } };
    assert.equal(duplicate.alreadyExists, true); assert.equal(duplicate.pack.status, 'candidate');
    const skillSummaries = await (await fetch(`${baseUrl}/api/skills/packs`)).text();
    assert.equal(skillSummaries.includes('role.agency.software-architect'), true);
    assert.equal(skillSummaries.includes('You are'), false);
  });
});
