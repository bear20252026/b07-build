import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteSecurityPostureAuditStore } from '../src/index.js';

function report(auditId: string, auditedAt: number) {
  return {
    schemaVersion: 1 as const,
    auditId,
    auditedAt,
    evidenceDigest: 'a'.repeat(64),
    findings: [{
      checkId: 'recovery.drill-missing', severity: 'warning' as const, subjectKind: 'recovery' as const, subjectId: 'recovery-bundle',
      evidenceDigest: 'b'.repeat(64), remediationHint: 'operator review', canExecute: false as const, canAutoRemediate: false as const,
    }],
    canExecute: false as const,
    canAutoRemediate: false as const,
  };
}

test('SQLite Security Posture Audit store 保持 append-only 历史、可重开审查和防御性复制', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-security-audit-'));
  const path = join(root, 'audit.sqlite');
  try {
    const store = new SqliteSecurityPostureAuditStore(path);
    store.append(report(`audit:${'a'.repeat(64)}`, 10));
    store.append(report(`audit:${'b'.repeat(64)}`, 20));
    store.close();

    const reopened = new SqliteSecurityPostureAuditStore(path);
    assert.equal(reopened.latest(`audit:${'a'.repeat(64)}`)?.auditedAt, 10);
    assert.deepEqual(reopened.list().map((entry) => entry.auditedAt), [20, 10]);
    const view = reopened.list();
    (view[0].findings as unknown as { checkId: string }[])[0].checkId = 'mutated';
    assert.equal(reopened.list()[0].findings[0].checkId, 'recovery.drill-missing');
    reopened.close();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
