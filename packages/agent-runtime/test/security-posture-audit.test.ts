import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  InMemorySecurityPostureAuditStore,
  SecurityPostureAuditLedger,
  SecurityPostureAuditService,
} from '../src/index.js';

function evidence(overrides: Partial<import('../src/security-posture-audit.js').SecurityPostureEvidenceV1> = {}) {
  return {
    schemaVersion: 1 as const,
    taintGateEnforced: true,
    extensions: [],
    providers: [],
    localModels: [],
    trustedDesktopIssuers: [],
    recovery: { quickCheckOk: false },
    resourceIsolation: { requested: true, enforced: false },
    ...overrides,
  };
}

test('Security Posture Audit 对缺失恢复、requested-only 隔离和无 active provider 生成稳定只读 finding', () => {
  const audit = new SecurityPostureAuditService();
  const report = audit.inspect(evidence(), 100);
  assert.equal(report.canExecute, false);
  assert.equal(report.canAutoRemediate, false);
  assert.deepEqual(report.findings.map((finding) => finding.checkId), [
    'providers.active-missing',
    'recovery.drill-missing',
    'resource-isolation.requested-only',
  ]);
  assert.equal(report.findings.every((finding) => finding.canExecute === false && finding.canAutoRemediate === false && /^[a-f0-9]{64}$/.test(finding.evidenceDigest)), true);
  const reopened = audit.inspect(evidence(), 101);
  assert.equal(reopened.auditId, report.auditId);
  assert.equal(reopened.evidenceDigest, report.evidenceDigest);
});

test('Security Posture Audit 报告 taint gate、构件、Provider、本地模型和 issuer 漂移，但不调用外部动作', () => {
  const report = new SecurityPostureAuditService().inspect(evidence({
    taintGateEnforced: false,
    extensions: [{ id: 'extension-1', status: 'revoked', findingCodes: ['REVOKED'] }],
    providers: [{ id: 'provider-1', status: 'active', dataBoundary: 'cloud-allowed' }],
    localModels: [{ id: 'local-1', offline: true, healthStatus: 'unhealthy' }],
    trustedDesktopIssuers: [{ issuerId: 'desktop-1', status: 'registered' }],
    recovery: { latestDrillAt: 50, quickCheckOk: true },
    resourceIsolation: { requested: false, enforced: false },
  }), 200);
  assert.deepEqual(report.findings.map((finding) => finding.checkId), [
    'extensions.unreviewed-or-revoked',
    'input.provenance.taint-gate-required',
    'issuers.untrusted',
    'local-models.unhealthy',
    'providers.data-boundary-not-local-only',
  ]);
  assert.equal(JSON.stringify(report).includes('cloud-allowed'), false);
});

test('Security Posture Audit evidence 与账本失败关闭，并保持防御性复制', () => {
  const audit = new SecurityPostureAuditService();
  assert.throws(() => audit.inspect(evidence({ extensions: [{ id: 'extension-1', status: 'reviewed', findingCodes: ['unsafe-code'] }] })), /findingCodes/);
  const store = new InMemorySecurityPostureAuditStore();
  const ledger = new SecurityPostureAuditLedger(store);
  const report = audit.inspect(evidence(), 300);
  assert.equal(ledger.record(report).auditId, report.auditId);
  assert.equal(ledger.record(report).auditId, report.auditId);
  assert.equal(ledger.list().length, 1);
  const view = ledger.list();
  (view[0].findings as unknown as { checkId: string }[]).push({ checkId: 'mutated' });
  assert.equal(ledger.list()[0].findings.some((finding) => finding.checkId === 'mutated'), false);
});
