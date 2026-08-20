import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ComponentLockfileLedger,
  ComponentProvenanceRegistry,
  createComponentLockfile,
  provenanceDigest,
  SqliteComponentLockfileStore,
  SqliteComponentProvenanceStore,
} from '../src/index.js';

const DIGEST_A = 'a'.repeat(64);

test('SQLite Component provenance 与 lockfile 账本可重开并保留不可变修订历史', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-component-provenance-'));
  const provenancePath = join(root, 'provenance.sqlite');
  const lockfilePath = join(root, 'components-lock.sqlite');
  try {
    const provenanceStore = new SqliteComponentProvenanceStore(provenancePath);
    const lockStore = new SqliteComponentLockfileStore(lockfilePath);
    const provenance = new ComponentProvenanceRegistry(provenanceStore);
    const locks = new ComponentLockfileLedger(lockStore);
    provenance.registerCandidate({
      componentId: 'reviewed-adapter', componentKind: 'agent-adapter', version: '1.0.0', sourceKind: 'git',
      sourceRef: 'git:awo/reviewed-adapter@a1b2c3d4', contentDigest: DIGEST_A, licenseId: 'MIT', at: 1,
    });
    const reviewed = provenance.review('reviewed-adapter', 'operator-1', 2, DIGEST_A);
    locks.record(createComponentLockfile(1, [{ componentId: 'reviewed-adapter', contentDigest: DIGEST_A, provenanceDigest: provenanceDigest(reviewed) }], 3));
    provenanceStore.close();
    lockStore.close();

    const reopenedProvenance = new SqliteComponentProvenanceStore(provenancePath);
    const reopenedLocks = new SqliteComponentLockfileStore(lockfilePath);
    assert.deepEqual(reopenedProvenance.history('reviewed-adapter').map((item) => item.reviewStatus), ['candidate', 'reviewed']);
    assert.equal(reopenedLocks.load()?.revision, 1);
    const view = reopenedLocks.load()!;
    (view.entries as unknown as { contentDigest: string }[])[0].contentDigest = 'b'.repeat(64);
    assert.equal(reopenedLocks.load()!.entries[0].contentDigest, DIGEST_A);
    reopenedProvenance.close();
    reopenedLocks.close();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
