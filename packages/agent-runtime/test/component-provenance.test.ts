import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  ComponentLockEnforcementService,
  ComponentLockfileLedger,
  ComponentProvenanceRegistry,
  createComponentLockfile,
  InMemoryComponentLockfileStore,
  InMemoryComponentProvenanceStore,
  provenanceDigest,
} from '../src/index.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function observed(contentDigest = DIGEST_A) {
  return [{ componentId: 'local-reader', componentKind: 'extension' as const, version: '1.2.3', contentDigest }];
}

test('构件 provenance 必须经显式 review 与绑定 revision 的 lockfile 后才可 eligible', () => {
  const provenance = new ComponentProvenanceRegistry(new InMemoryComponentProvenanceStore());
  const locks = new ComponentLockfileLedger(new InMemoryComponentLockfileStore());
  const enforcement = new ComponentLockEnforcementService();
  provenance.registerCandidate({
    componentId: 'local-reader', componentKind: 'extension', version: '1.2.3', sourceKind: 'npm',
    sourceRef: 'npm:@awo/local-reader@1.2.3', contentDigest: DIGEST_A, licenseId: 'Apache-2.0', at: 1,
  });

  assert.deepEqual(enforcement.inspect(observed(), provenance.list(), undefined)[0], {
    componentId: 'local-reader', componentKind: 'extension', eligibility: 'quarantined', lockRevision: undefined,
    reasons: ['missing-lockfile', 'provenance-not-reviewed'], canActivate: false, canAutoRepair: false,
  });

  const reviewed = provenance.review('local-reader', 'operator-1', 2, DIGEST_A);
  locks.record(createComponentLockfile(1, [{ componentId: 'local-reader', contentDigest: DIGEST_A, provenanceDigest: provenanceDigest(reviewed) }], 3));
  assert.deepEqual(enforcement.inspect(observed(), provenance.list(), locks.latest())[0], {
    componentId: 'local-reader', componentKind: 'extension', eligibility: 'eligible', lockRevision: 1,
    reasons: [], canActivate: false, canAutoRepair: false,
  });
});

test('构件摘要、provenance revision 或撤销任何一项漂移都会 fail-closed 隔离', () => {
  const provenance = new ComponentProvenanceRegistry(new InMemoryComponentProvenanceStore());
  const locks = new ComponentLockfileLedger(new InMemoryComponentLockfileStore());
  const enforcement = new ComponentLockEnforcementService();
  provenance.registerCandidate({
    componentId: 'trusted-skill', componentKind: 'skill-pack', version: '2.0.0', sourceKind: 'git',
    sourceRef: 'git:awo/trusted-skill@a1b2c3d4', contentDigest: DIGEST_A, licenseId: 'MIT', at: 1,
  });
  const reviewed = provenance.review('trusted-skill', 'operator-1', 2, DIGEST_A);
  locks.record(createComponentLockfile(1, [{ componentId: 'trusted-skill', contentDigest: DIGEST_A, provenanceDigest: provenanceDigest(reviewed) }], 3));

  assert.deepEqual(enforcement.inspect([{ componentId: 'trusted-skill', componentKind: 'skill-pack', version: '2.0.0', contentDigest: DIGEST_B }], provenance.list(), locks.latest())[0].reasons,
    ['lock-content-digest-mismatch', 'provenance-digest-mismatch']);

  provenance.revoke('trusted-skill', 4);
  assert.deepEqual(enforcement.inspect([{ componentId: 'trusted-skill', componentKind: 'skill-pack', version: '2.0.0', contentDigest: DIGEST_A }], provenance.list(), locks.latest())[0].reasons,
    ['lock-provenance-digest-mismatch', 'provenance-revoked']);
  assert.throws(() => provenance.review('trusted-skill', 'operator-2', 5, DIGEST_A), /只有 candidate/);
});

test('lockfile 拒绝重复条目、非法摘要与不连续修订，且返回对象不可篡改内部状态', () => {
  const locks = new ComponentLockfileLedger(new InMemoryComponentLockfileStore());
  assert.throws(() => createComponentLockfile(1, [
    { componentId: 'same', contentDigest: DIGEST_A, provenanceDigest: DIGEST_A },
    { componentId: 'same', contentDigest: DIGEST_A, provenanceDigest: DIGEST_A },
  ], 1), /重复/);
  locks.record(createComponentLockfile(1, [], 1));
  const latest = locks.latest()!;
  (latest.entries as unknown as { componentId: string }[]).push({ componentId: 'mutated' });
  assert.equal(locks.latest()!.entries.length, 0);
  assert.throws(() => locks.record(createComponentLockfile(3, [], 2)), /连续递增/);
});
