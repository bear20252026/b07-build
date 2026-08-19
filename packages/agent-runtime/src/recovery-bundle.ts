import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const RECOVERY_BUNDLE_SCHEMA_VERSION = 1 as const;

export interface RecoveryBundleSource {
  id: string;
  databasePath: string;
}

export interface RecoveryBundleEntry {
  sourceId: string;
  fileName: string;
  bytes: number;
  sha256: string;
  quickCheck: 'ok';
}

/** 可移植、可审计但不可自动恢复的本地 SQLite 一致快照。 */
export interface RecoveryBundleManifestV1 {
  schemaVersion: typeof RECOVERY_BUNDLE_SCHEMA_VERSION;
  bundleId: string;
  createdAt: number;
  entries: readonly RecoveryBundleEntry[];
  canAutoRestore: false;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function quickCheck(databasePath: string): 'ok' {
  const database = new DatabaseSync(databasePath);
  try {
    const rows = database.prepare('PRAGMA quick_check;').all() as unknown as readonly Record<string, unknown>[];
    const values = rows.flatMap((row) => Object.values(row));
    if (values.length !== 1 || values[0] !== 'ok') throw new Error(`SQLite quick_check 失败：${values.join('; ')}`);
    return 'ok';
  } finally {
    database.close();
  }
}

function copyConsistentSnapshot(sourcePath: string, destinationPath: string): void {
  const source = new DatabaseSync(sourcePath);
  try {
    // SQLite 负责从当前一致视图生成独立文件；禁止用 fs.copyFile 直接复制活动 WAL 数据库。
    source.prepare('VACUUM INTO ?;').run(destinationPath);
  } finally {
    source.close();
  }
}

function copyManifest(manifest: RecoveryBundleManifestV1): RecoveryBundleManifestV1 {
  return { ...manifest, entries: manifest.entries.map((entry) => ({ ...entry })) };
}

/**
 * Operator 明确传入允许备份的本地数据库；没有网络、调度、自动恢复或运行中数据库替换能力。
 * bundle 生成后必须经过 `restoreDrill` 的 digest 与 quick_check 验证才被列为可用。
 */
export class RecoveryBundleService {
  private readonly sources: readonly RecoveryBundleSource[];
  private readonly destinationRoot: string;

  constructor(sources: readonly RecoveryBundleSource[], destinationRoot: string) {
    if (sources.length === 0) throw new Error('Recovery Bundle 至少需要一个预登记 SQLite source');
    const ids = new Set<string>();
    this.sources = sources.map((source) => {
      assertIdentifier(source.id, 'sourceId');
      if (ids.has(source.id)) throw new Error(`重复 recovery source：${source.id}`);
      ids.add(source.id);
      const databasePath = resolve(source.databasePath);
      if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
        throw new Error(`recovery source 不存在或不是文件：${source.id}`);
      }
      return { id: source.id, databasePath };
    });
    this.destinationRoot = resolve(destinationRoot);
    mkdirSync(this.destinationRoot, { recursive: true });
  }

  create(now = Date.now(), bundleId = `bundle-${randomUUID()}`): RecoveryBundleManifestV1 {
    assertIdentifier(bundleId, 'bundleId');
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('createdAt 必须是非负安全整数');
    const finalDirectory = join(this.destinationRoot, bundleId);
    if (existsSync(finalDirectory)) throw new Error(`recovery bundle 已存在：${bundleId}`);
    const temporaryDirectory = join(this.destinationRoot, `.tmp-${bundleId}`);
    mkdirSync(temporaryDirectory, { recursive: false });
    try {
      const entries = this.sources.map((source) => {
        const fileName = `${source.id}.sqlite`;
        const destinationPath = join(temporaryDirectory, fileName);
        copyConsistentSnapshot(source.databasePath, destinationPath);
        return {
          sourceId: source.id,
          fileName,
          bytes: statSync(destinationPath).size,
          sha256: sha256(destinationPath),
          quickCheck: quickCheck(destinationPath),
        } as const;
      });
      const manifest: RecoveryBundleManifestV1 = {
        schemaVersion: RECOVERY_BUNDLE_SCHEMA_VERSION,
        bundleId,
        createdAt: now,
        entries,
        canAutoRestore: false,
      };
      writeFileSync(join(temporaryDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      renameSync(temporaryDirectory, finalDirectory);
      this.restoreDrill(bundleId);
      return copyManifest(manifest);
    } catch (error) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  list(): readonly RecoveryBundleManifestV1[] {
    return readdirSync(this.destinationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.tmp-'))
      .map((entry) => this.loadManifest(entry.name))
      .sort((left, right) => right.createdAt - left.createdAt || left.bundleId.localeCompare(right.bundleId));
  }

  /** 演练只校验 bundle 内容，从不写回或替换 source DB。 */
  restoreDrill(bundleId: string): RecoveryBundleManifestV1 {
    assertIdentifier(bundleId, 'bundleId');
    const manifest = this.loadManifest(bundleId);
    for (const entry of manifest.entries) {
      const databasePath = join(this.destinationRoot, bundleId, entry.fileName);
      if (!existsSync(databasePath) || statSync(databasePath).size !== entry.bytes) {
        throw new Error(`recovery bundle 文件缺失或大小变化：${entry.sourceId}`);
      }
      if (sha256(databasePath) !== entry.sha256) throw new Error(`recovery bundle digest 不匹配：${entry.sourceId}`);
      if (quickCheck(databasePath) !== 'ok') throw new Error(`recovery bundle quick_check 失败：${entry.sourceId}`);
    }
    return copyManifest(manifest);
  }

  private loadManifest(bundleId: string): RecoveryBundleManifestV1 {
    const manifestPath = join(this.destinationRoot, bundleId, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`recovery bundle manifest 不存在：${bundleId}`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RecoveryBundleManifestV1;
    if (manifest.schemaVersion !== RECOVERY_BUNDLE_SCHEMA_VERSION || manifest.bundleId !== bundleId || manifest.canAutoRestore !== false) {
      throw new Error(`recovery bundle manifest 不兼容：${bundleId}`);
    }
    if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error(`recovery bundle entries 无效：${bundleId}`);
    for (const entry of manifest.entries) {
      assertIdentifier(entry.sourceId, 'sourceId');
      if (basename(entry.fileName) !== entry.fileName || !entry.fileName.endsWith('.sqlite') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.quickCheck !== 'ok') {
        throw new Error(`recovery bundle entry 无效：${bundleId}`);
      }
    }
    return copyManifest(manifest);
  }
}
