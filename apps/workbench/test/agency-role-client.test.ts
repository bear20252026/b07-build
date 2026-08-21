import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpAgencyRoleClient } from '../src/runtime/agency-role-client.js';

const source = { repository: 'msitarzewski/agency-agents', upstreamPath: 'engineering/engineering-software-architect.md', upstreamUrl: 'https://github.com/msitarzewski/agency-agents/blob/main/engineering/engineering-software-architect.md', license: 'MIT', copyright: 'Copyright (c) 2025 AgentLand Contributors', contentDigest: 'a'.repeat(64) };
const role = { id: 'agency.software-architect', division: 'engineering', displayName: 'Software Architect', description: 'architecture', source, canAutoInject: false, canAuthorize: false, canGrantCapabilities: false };

test('agency 角色客户端只接受带 MIT 来源的目录和显式详情', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => Response.json(String(url).endsWith('/agency.software-architect') ? { ...role, content: '<!-- Copyright (c) 2025 AgentLand Contributors -->\nRole content' } : [role])) as typeof fetch;
  try {
    const client = new HttpAgencyRoleClient('/api');
    assert.equal((await client.list())[0]?.canAutoInject, false);
    assert.equal((await client.detail('agency.software-architect')).content.includes('Copyright (c) 2025 AgentLand Contributors'), true);
  } finally { globalThis.fetch = originalFetch; }
});

test('agency 角色客户端以固定意图创建候选，并拒绝伪造自动授权角色', async () => {
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined;
  globalThis.fetch = (async (_url, init) => { request = init; return Response.json({ alreadyExists: false, pack: { id: 'role.agency.software-architect', status: 'candidate', displayName: 'Agency · Software Architect', source: { digest: 'a'.repeat(64) } } }); }) as typeof fetch;
  try {
    const result = await new HttpAgencyRoleClient('/api').createCandidate('agency.software-architect');
    assert.equal(result.pack.status, 'candidate');
    assert.equal((request?.headers as Record<string, string>)['x-awo-operator-intent'], 'agency-role-candidate-v1');
    assert.equal(request?.body, '{}');
  } finally { globalThis.fetch = originalFetch; }
});
