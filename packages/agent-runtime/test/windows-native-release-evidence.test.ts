import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  InMemoryWindowsNativeHostReleaseEvidenceStore,
  WindowsNativeHostReleaseEvidenceLedger,
  WindowsNativeHostReleaseGate,
  type WindowsNativeHostReleaseEvidenceV1,
  type WindowsNativeHostReleaseExpectationV1,
} from '../src/index.js';

const BINARY_DIGEST = 'a'.repeat(64);
const SIGNER_DIGEST = 'b'.repeat(64);
const NOW = 1_000_000;

function evidence(overrides: Partial<WindowsNativeHostReleaseEvidenceV1> = {}): WindowsNativeHostReleaseEvidenceV1 {
  return {
    schemaVersion: 1,
    evidenceId: 'windows-evidence-1',
    platform: 'windows',
    architecture: 'x64',
    issuerId: 'desktop-host',
    bridgeId: 'windows-native-host',
    helperId: 'awo-native-helper',
    protocolVersion: 'native-auth.v1',
    binaryDigest: BINARY_DIGEST,
    signerThumbprintDigest: SIGNER_DIGEST,
    authenticodeStatus: 'valid',
    capturedAt: NOW - 1,
    canExecute: false,
    canAutoTrust: false,
    ...overrides,
  };
}

function expected(overrides: Partial<WindowsNativeHostReleaseExpectationV1> = {}): WindowsNativeHostReleaseExpectationV1 {
  return {
    issuerId: 'desktop-host',
    bridgeId: 'windows-native-host',
    helperId: 'awo-native-helper',
    protocolVersion: 'native-auth.v1',
    expectedBinaryDigest: BINARY_DIGEST,
    expectedSignerThumbprintDigest: SIGNER_DIGEST,
    maxEvidenceAgeMs: 60_000,
    ...overrides,
  };
}

test('Windows x64 的有效 Authenticode 证据仅生成 release-ready metadata，不自动登记、信任或执行', () => {
  const gate = new WindowsNativeHostReleaseGate(() => NOW);
  const decision = gate.inspect(evidence(), expected());
  assert.deepEqual(decision, {
    schemaVersion: 1,
    evidenceId: 'windows-evidence-1',
    issuerId: 'desktop-host',
    bridgeId: 'windows-native-host',
    helperId: 'awo-native-helper',
    status: 'release-ready',
    rejectionCodes: [],
    canRegisterBridge: false,
    canTrustBridge: false,
    canExecute: false,
  });
});

test('Windows release gate 对非 x64、无效签名、摘要漂移、身份错配与陈旧证据失败关闭并稳定排序原因', () => {
  const gate = new WindowsNativeHostReleaseGate(() => NOW);
  const decision = gate.inspect(evidence({ architecture: 'arm64', authenticodeStatus: 'invalid', binaryDigest: 'c'.repeat(64), issuerId: 'other-host', capturedAt: NOW - 60_001 }), expected());
  assert.deepEqual(decision.rejectionCodes, ['architecture-not-x64', 'authenticode-not-valid', 'binary-digest-mismatch', 'evidence-expired', 'identity-mismatch']);
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.canTrustBridge, false);
});

test('Windows release evidence ledger 是 append-only，按受控身份可重开审查并防御性复制', () => {
  const store = new InMemoryWindowsNativeHostReleaseEvidenceStore();
  const ledger = new WindowsNativeHostReleaseEvidenceLedger(store, new WindowsNativeHostReleaseGate(() => NOW));
  const result = ledger.record(evidence(), expected());
  assert.equal(result.status, 'release-ready');
  assert.throws(() => ledger.record(evidence(), expected()), /不可重放/);
  const view = ledger.list('desktop-host', 'windows-native-host')[0]!;
  (view as { binaryDigest: string }).binaryDigest = 'f'.repeat(64);
  assert.equal(ledger.list('desktop-host', 'windows-native-host')[0]?.binaryDigest, BINARY_DIGEST);
});
