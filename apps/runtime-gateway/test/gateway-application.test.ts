import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayComposition } from '../src/gateway-application.js';

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
  'AWO_API_USAGE_DB',
  'AWO_BROWSER_SESSION_DB',
  'AWO_SKILL_PACK_DB',
  'AWO_KNOWLEDGE_IMPORT_DB',
  'AWO_AGENT_ADAPTER_MANIFEST_DB',
  'AWO_AGENT_ADAPTER_SESSION_DB',
  'AWO_AGENT_ADAPTER_MAILBOX_DB',
  'AWO_SCHEDULE_MANIFEST_DB',
  'AWO_SCHEDULE_RUN_DB',
  'AWO_PROJECT_WORKSPACE_DB',
] as const;

function withIsolatedGatewayPaths<T>(run: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'awo-gateway-composition-'));
  const previous = new Map<string, string | undefined>();
  for (const key of DATABASE_VARIABLES) {
    previous.set(key, process.env[key]);
    process.env[key] = join(root, `${key.toLowerCase()}.sqlite`);
  }
  process.env.AWO_KNOWLEDGE_WORKSPACE_DIR = join(root, 'knowledge-workspaces');
  try {
    return run();
  } finally {
    for (const key of DATABASE_VARIABLES) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { force: true, recursive: true });
  }
}

test('Gateway composition closes all SQLite control-plane resources idempotently', () => {
  withIsolatedGatewayPaths(() => {
    const first = createGatewayComposition();
    assert.equal(first.dependencies.defaultKnowledgeWorkspaceId, 'default-local');
    first.close();
    first.close();

    const second = createGatewayComposition();
    second.close();
  });
});
