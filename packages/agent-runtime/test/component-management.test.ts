import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  ComponentLockfileLedger,
  ComponentManagementAuthority,
  ComponentProvenanceRegistry,
  InMemoryComponentLockfileStore,
  InMemoryComponentManagementReceiptStore,
  InMemoryComponentProvenanceStore,
  InMemoryTrustedDesktopIssuerStore,
  TrustedDesktopIssuerRegistry,
  type ComponentManagementAction,
  type ComponentManagementPayload,
} from '../src/index.js';

const NOW = 10_000;
const DIGEST = 'a'.repeat(64);

function digest(payload: ComponentManagementPayload): string {
  const normalized = 'componentIds' in payload ? { componentIds: [...payload.componentIds] } : { ...payload };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function authority() {
  const issuers = new TrustedDesktopIssuerRegistry(new InMemoryTrustedDesktopIssuerStore());
  issuers.register({ issuerId: 'desktop-host', displayName: 'Trusted Host', platform: 'windows', at: 1 });
  issuers.setStatus('desktop-host', 'trusted', 2);
  const provenances = new ComponentProvenanceRegistry(new InMemoryComponentProvenanceStore());
  const lockfiles = new ComponentLockfileLedger(new InMemoryComponentLockfileStore());
  const receipts = new InMemoryComponentManagementReceiptStore();
  return { authority: new ComponentManagementAuthority(issuers, provenances, lockfiles, receipts, () => NOW), provenances, lockfiles, receipts };
}

function intent(operationId: string, action: ComponentManagementAction, componentId: string, payload: ComponentManagementPayload, issuerId = 'desktop-host', issuedAt = NOW) {
  return {
    schemaVersion: 1 as const,
    attestation: { schemaVersion: 1 as const, issuerId, operationId, action, componentId, payloadDigest: digest(payload), issuedAt, expiresAt: issuedAt + 30_000 },
    payload,
  };
}

test('可信本地宿主只能按候选、摘要核验、人工评审与显式锁定顺序推进构件 metadata', () => {
  const { authority: management, provenances, lockfiles } = authority();
  const candidate = {
    componentId: 'reviewed-extension', componentKind: 'extension' as const, version: '1.2.3', sourceKind: 'npm' as const,
    sourceRef: 'npm:@awo/reviewed-extension@1.2.3', contentDigest: DIGEST, licenseId: 'Apache-2.0', at: 0,
  };
  assert.deepEqual(management.manage(intent('op-register', 'register-candidate', 'reviewed-extension', candidate)), {
    schemaVersion: 1, operationId: 'op-register', issuerId: 'desktop-host', action: 'register-candidate', componentId: 'reviewed-extension',
    payloadDigest: digest(candidate), outcome: 'applied', rejectionCode: undefined, recordedAt: NOW, canExecute: false, canAutoRemediate: false,
  });
  const verification = { componentId: 'reviewed-extension', expectedDigest: DIGEST };
  assert.equal(management.manage(intent('op-verify', 'verify-digest', 'reviewed-extension', verification)).outcome, 'applied');
  const review = { componentId: 'reviewed-extension', reviewer: 'operator-1', expectedDigest: DIGEST };
  assert.equal(management.manage(intent('op-review', 'review-provenance', 'reviewed-extension', review)).outcome, 'applied');
  const lock = { componentIds: ['reviewed-extension'] };
  const lockReceipt = management.manage(intent('op-lock', 'record-lockfile', 'component-lockfile', lock));
  assert.equal(lockReceipt.outcome, 'applied');
  assert.equal(lockReceipt.canExecute, false);
  assert.equal(provenances.list()[0].reviewStatus, 'reviewed');
  assert.equal(lockfiles.latest()?.revision, 1);
});

test('未受信 issuer、过期 attestation 或 payload 篡改都会拒绝并留下不可执行回执', () => {
  const { authority: management } = authority();
  const candidate = {
    componentId: 'rejected-extension', componentKind: 'extension' as const, version: '1.0.0', sourceKind: 'manual' as const,
    sourceRef: 'manual:operator-1', contentDigest: DIGEST, licenseId: 'MIT', at: 0,
  };
  const issuerRejected = management.manage(intent('op-untrusted', 'register-candidate', 'rejected-extension', candidate, 'unknown-host'));
  assert.deepEqual([issuerRejected.outcome, issuerRejected.rejectionCode, issuerRejected.canExecute], ['rejected', 'issuer-untrusted', false]);

  const expired = intent('op-expired', 'register-candidate', 'rejected-extension', candidate, 'desktop-host', 1);
  expired.attestation.expiresAt = 2;
  const expiredRejected = management.manage(expired);
  assert.deepEqual([expiredRejected.outcome, expiredRejected.rejectionCode, expiredRejected.canAutoRemediate], ['rejected', 'attestation-expired', false]);

  const tampered = intent('op-tampered', 'register-candidate', 'rejected-extension', candidate);
  tampered.attestation.payloadDigest = 'b'.repeat(64);
  const payloadRejected = management.manage(tampered);
  assert.deepEqual([payloadRejected.outcome, payloadRejected.rejectionCode], ['rejected', 'payload-mismatch']);
});

test('管理 operationId 不能重放，评审无法跳过同摘要的宿主核验，撤销不可恢复', () => {
  const { authority: management, provenances } = authority();
  const candidate = {
    componentId: 'revocable-extension', componentKind: 'extension' as const, version: '1.0.0', sourceKind: 'manual' as const,
    sourceRef: 'manual:operator-1', contentDigest: DIGEST, licenseId: 'MIT', at: 0,
  };
  const register = intent('op-register-once', 'register-candidate', 'revocable-extension', candidate);
  management.manage(register);
  assert.throws(() => management.manage(register), /重放/);
  const review = { componentId: 'revocable-extension', reviewer: 'operator-1', expectedDigest: DIGEST };
  assert.equal(management.manage(intent('op-review-no-verify', 'review-provenance', 'revocable-extension', review)).rejectionCode, 'precondition-failed');
  management.manage(intent('op-verify-once', 'verify-digest', 'revocable-extension', { componentId: 'revocable-extension', expectedDigest: DIGEST }));
  assert.equal(management.manage(intent('op-review-once', 'review-provenance', 'revocable-extension', review)).outcome, 'applied');
  assert.equal(management.manage(intent('op-revoke-once', 'revoke-provenance', 'revocable-extension', { componentId: 'revocable-extension' })).outcome, 'applied');
  assert.equal(provenances.list()[0].reviewStatus, 'revoked');
  assert.equal(management.manage(intent('op-review-revoked', 'review-provenance', 'revocable-extension', review)).outcome, 'rejected');
});
