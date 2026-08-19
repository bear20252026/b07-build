import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { RecoveryBundleService } from '../src/index.js';

function createSourceDatabase(filePath: string): void {
  const database = new DatabaseSync(filePath);
  try {
    database.exec('PRAGMA journal_mode = WAL; CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);');
    database.prepare('INSERT INTO notes (body) VALUES (?)').run('local-first recovery test');
  } finally {
    database.close();
  }
}

test('Recovery Bundle 用 SQLite 一致快照导出、digest/quick_check 验证且不允许自动恢复', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-recovery-'));
  const sourcePath = join(root, 'source.sqlite');
  const bundleRoot = join(root, 'bundles');
  createSourceDatabase(sourcePath);
  const service = new RecoveryBundleService([{ id: 'task-store', databasePath: sourcePath }], bundleRoot);
  const manifest = service.create(100, 'bundle-1');
  assert.equal(manifest.canAutoRestore, false);
  assert.equal(manifest.entries[0].quickCheck, 'ok');
  assert.equal(manifest.entries[0].sha256.length, 64);
  assert.equal(service.restoreDrill('bundle-1').bundleId, 'bundle-1');
  assert.equal(service.list()[0].bundleId, 'bundle-1');

  const copiedPath = join(bundleRoot, 'bundle-1', 'task-store.sqlite');
  const copied = new DatabaseSync(copiedPath);
  try {
    assert.equal((copied.prepare('SELECT body FROM notes').get() as { body: string }).body, 'local-first recovery test');
  } finally {
    copied.close();
  }
  rmSync(root, { recursive: true, force: true });
});

test('Recovery Bundle 恢复演练拒绝被篡改的 bundle，而不接触 source 数据库', () => {
  const root = mkdtempSync(join(tmpdir(), 'awo-recovery-tamper-'));
  const sourcePath = join(root, 'source.sqlite');
  const bundleRoot = join(root, 'bundles');
  createSourceDatabase(sourcePath);
  const service = new RecoveryBundleService([{ id: 'task-store', databasePath: sourcePath }], bundleRoot);
  service.create(100, 'bundle-2');
  const manifestPath = join(bundleRoot, 'bundle-2', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries: Array<{ sha256: string }> };
  manifest.entries[0].sha256 = '0'.repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => service.restoreDrill('bundle-2'), /digest/);
  rmSync(root, { recursive: true, force: true });
});
