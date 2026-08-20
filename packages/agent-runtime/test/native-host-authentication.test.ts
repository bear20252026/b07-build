import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  AuthenticatedNativeComponentManagementBridge,
  ComponentLockfileLedger,
  ComponentManagementAuthority,
  ComponentProvenanceRegistry,
  InMemoryComponentLockfileStore,
  InMemoryComponentManagementReceiptStore,
  InMemoryComponentProvenanceStore,
  InMemoryNativeHostBridgeTrustStore,
  InMemoryNativeHostChallengeStore,
  InMemoryTrustedDesktopIssuerStore,
  NativeHostBridgeTrustRegistry,
  NativeHostChallengeIssuer,
  NativeHostEnvelopeVerifier,
  TrustedDesktopIssuerRegistry,
  type NativeHostChallengeV1,
} from '../src/index.js';

const NOW = 10_000;
const CONTENT_DIGEST = 'a'.repeat(64);
const NONCE_A = 'b'.repeat(64);
const NONCE_B = 'c'.repeat(64);

function signedPayload(challenge: NativeHostChallengeV1): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: challenge.schemaVersion,
    nonce: challenge.nonce,
    issuerId: challenge.issuerId,
    bridgeId: challenge.bridgeId,
    action: challenge.action,
    componentId: challenge.componentId,
    payloadDigest: challenge.payloadDigest,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  }), 'utf8');
}

function setup() {
  const keys = generateKeyPairSync('ed25519');
  const issuers = new TrustedDesktopIssuerRegistry(new InMemoryTrustedDesktopIssuerStore());
  issuers.register({ issuerId: 'desktop-host', displayName: 'Trusted Host', platform: 'windows', at: 1 });
  issuers.setStatus('desktop-host', 'trusted', 2);
  const bridges = new NativeHostBridgeTrustRegistry(new InMemoryNativeHostBridgeTrustStore());
  bridges.register({
    issuerId: 'desktop-host', bridgeId: 'local-bridge', transport: 'desktop-ipc', expectedCallerOrigin: 'app://awo-local', keyId: 'host-key-1',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), allowedActions: ['register-candidate', 'verify-digest', 'review-provenance', 'record-lockfile', 'revoke-provenance'], at: 3,
  });
  bridges.setStatus('desktop-host', 'local-bridge', 'trusted', 4);
  const challenges = new InMemoryNativeHostChallengeStore();
  const challengeIssuer = new NativeHostChallengeIssuer(issuers, bridges, challenges, () => NOW, (() => {
    const nonces = [NONCE_A, NONCE_B];
    return () => nonces.shift() ?? 'd'.repeat(64);
  })());
  const verifier = new NativeHostEnvelopeVerifier(issuers, bridges, challenges, () => NOW);
  const management = new ComponentManagementAuthority(
    issuers,
    new ComponentProvenanceRegistry(new InMemoryComponentProvenanceStore()),
    new ComponentLockfileLedger(new InMemoryComponentLockfileStore()),
    new InMemoryComponentManagementReceiptStore(),
    () => NOW,
  );
  return { keys, challenges, bridge: new AuthenticatedNativeComponentManagementBridge(challengeIssuer, verifier, management) };
}

function candidate(componentId = 'native-extension') {
  return {
    componentId, componentKind: 'extension' as const, version: '1.0.0', sourceKind: 'manual' as const,
    sourceRef: 'manual:operator-1', contentDigest: CONTENT_DIGEST, licenseId: 'MIT', at: 0,
  };
}

function envelope(challenge: NativeHostChallengeV1, privateKey: KeyObject, overrides: Partial<{ callerOrigin: string; signatureBase64: string }> = {}) {
  return {
    schemaVersion: 1,
    nonce: challenge.nonce,
    issuerId: challenge.issuerId,
    bridgeId: challenge.bridgeId,
    callerOrigin: overrides.callerOrigin ?? 'app://awo-local',
    keyId: 'host-key-1',
    signatureBase64: overrides.signatureBase64 ?? sign(null, signedPayload(challenge), privateKey).toString('base64'),
  };
}

test('可信 native host 的精确 origin、Ed25519 签名与单次 nonce 可生成受限构件管理 attestation，但不授予执行权', () => {
  const { bridge, challenges, keys } = setup();
  const payload = candidate();
  const challenge = bridge.issueChallenge({ issuerId: 'desktop-host', bridgeId: 'local-bridge', action: 'register-candidate', componentId: 'native-extension', payload });
  const result = bridge.manage(envelope(challenge, keys.privateKey), payload);
  assert.equal(result.decision.allowed, true);
  assert.equal(result.decision.canExecute, false);
  assert.equal(result.receipt?.outcome, 'applied');
  assert.equal(result.receipt?.canExecute, false);
  assert.equal(challenges.load(challenge.nonce)?.state, 'consumed');
  assert.equal(challenges.load(challenge.nonce)?.outcome, 'verified');

  const replay = bridge.manage(envelope(challenge, keys.privateKey), payload);
  assert.deepEqual([replay.decision.allowed, replay.decision.reason, replay.receipt], [false, 'nonce-consumed', undefined]);
});

test('原生认证桥对错误 origin、坏签名和 payload 替换均失败关闭，且每个已定位 challenge 只能消费一次', () => {
  const { bridge, challenges, keys } = setup();
  const payload = candidate('origin-extension');
  const originChallenge = bridge.issueChallenge({ issuerId: 'desktop-host', bridgeId: 'local-bridge', action: 'register-candidate', componentId: 'origin-extension', payload });
  const originRejected = bridge.manage(envelope(originChallenge, keys.privateKey, { callerOrigin: 'app://untrusted-page' }), payload);
  assert.deepEqual([originRejected.decision.allowed, originRejected.decision.reason, challenges.load(originChallenge.nonce)?.outcome], [false, 'origin-mismatch', 'rejected']);

  const badSignatureChallenge = bridge.issueChallenge({ issuerId: 'desktop-host', bridgeId: 'local-bridge', action: 'register-candidate', componentId: 'origin-extension', payload });
  const badSignature = bridge.manage(envelope(badSignatureChallenge, keys.privateKey, { signatureBase64: Buffer.from('wrong signature').toString('base64') }), payload);
  assert.deepEqual([badSignature.decision.allowed, badSignature.decision.reason, challenges.load(badSignatureChallenge.nonce)?.outcome], [false, 'signature-invalid', 'rejected']);

  const { bridge: swapBridge, keys: swapKeys } = setup();
  const swapChallenge = swapBridge.issueChallenge({ issuerId: 'desktop-host', bridgeId: 'local-bridge', action: 'register-candidate', componentId: 'native-extension', payload: candidate('native-extension') });
  const swapped = swapBridge.manage(envelope(swapChallenge, swapKeys.privateKey), candidate('different-extension'));
  assert.equal(swapped.decision.allowed, true);
  assert.deepEqual([swapped.receipt?.outcome, swapped.receipt?.rejectionCode, swapped.receipt?.canAutoRemediate], ['rejected', 'payload-mismatch', false]);
});

test('challenge 发放仅接受受信 issuer 和 bridge 的最小 action scope，未知或浏览器样式来源不可作为可信 bridge 配置', () => {
  const { bridge } = setup();
  assert.throws(() => bridge.issueChallenge({ issuerId: 'desktop-host', bridgeId: 'unknown-bridge', action: 'register-candidate', componentId: 'native-extension', payload: candidate() }), /未受信/);
});
