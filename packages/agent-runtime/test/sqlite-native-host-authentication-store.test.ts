import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SqliteNativeHostBridgeTrustStore,
  SqliteNativeHostChallengeStore,
} from '../src/index.js';

const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA1GCJqWjFJdX2AeipqCbJNj10KxElLyAKBiKxFSSr86M=\n-----END PUBLIC KEY-----\n';

function trust(revision: number, status: 'registered' | 'trusted') {
  return {
    schemaVersion: 1 as const, issuerId: 'desktop-host', bridgeId: 'local-bridge', transport: 'desktop-ipc' as const,
    expectedCallerOrigin: 'app://awo-local', keyId: 'host-key-1', publicKeyPem: PUBLIC_KEY, allowedActions: ['register-candidate' as const],
    status, revision, registeredAt: 1, updatedAt: revision, canAuthenticateComponentManagement: true as const, canExecute: false as const,
  };
}

function challenge(revision: number, state: 'issued' | 'consumed') {
  return {
    schemaVersion: 1 as const,
    challenge: {
      schemaVersion: 1 as const, nonce: 'a'.repeat(64), issuerId: 'desktop-host', bridgeId: 'local-bridge', action: 'register-candidate' as const,
      componentId: 'component-a', payloadDigest: 'b'.repeat(64), issuedAt: 1, expiresAt: 60_001, canExecute: false as const,
    },
    state, revision, consumedAt: state === 'consumed' ? 2 : undefined, outcome: state === 'consumed' ? 'verified' as const : undefined, canExecute: false as const,
  };
}

test('SQLite native host trust/challenge store 在关闭重开后保留最新 revision，nonce 消费不可被返回副本篡改', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-native-auth-'));
  const trustPath = join(root, 'trust.sqlite');
  const challengePath = join(root, 'challenges.sqlite');
  try {
    const trustStore = new SqliteNativeHostBridgeTrustStore(trustPath);
    trustStore.append(trust(1, 'registered'));
    trustStore.append(trust(2, 'trusted'));
    trustStore.close();
    const challengeStore = new SqliteNativeHostChallengeStore(challengePath);
    challengeStore.append(challenge(1, 'issued'));
    challengeStore.append(challenge(2, 'consumed'));
    challengeStore.close();

    const reopenedTrust = new SqliteNativeHostBridgeTrustStore(trustPath);
    const reopenedChallenge = new SqliteNativeHostChallengeStore(challengePath);
    assert.equal(reopenedTrust.load('desktop-host', 'local-bridge')?.status, 'trusted');
    assert.equal(reopenedChallenge.load('a'.repeat(64))?.state, 'consumed');
    const view = reopenedChallenge.load('a'.repeat(64))!;
    (view as { state: string }).state = 'issued';
    assert.equal(reopenedChallenge.load('a'.repeat(64))?.state, 'consumed');
    reopenedTrust.close();
    reopenedChallenge.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
