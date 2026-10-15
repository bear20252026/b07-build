// 一个文件=一种作用：插件市场持久化（已知市场记录 + 已安装插件记录）。
//
// 与同包 mcp-registry / extension-registry 的 store 写法对齐：内存实现用于进程内测试，
// SQLite 实现用于跨进程持久化（WAL）。本 store 只保存审核后的元数据 DTO，
// 不持有插件包内容、密钥或运行期句柄。记录是「按 id 覆盖」的可变快照，
// 而非 append-only 修订链——市场与安装状态本身只关心当前值。

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { InstalledPluginRecord, KnownMarketplaceRecord } from './plugin-marketplace-types.js';

export interface PluginMarketplaceStore {
  listMarketplaces(): readonly KnownMarketplaceRecord[];
  saveMarketplaces(records: readonly KnownMarketplaceRecord[]): void;
  listInstalled(): readonly InstalledPluginRecord[];
  saveInstalled(records: readonly InstalledPluginRecord[]): void;
}

function copyMarketplace(record: KnownMarketplaceRecord): KnownMarketplaceRecord {
  return { ...record, source: { ...record.source } };
}

function copyInstalled(record: InstalledPluginRecord): InstalledPluginRecord {
  return { ...record };
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

/** 进程内测试存储。 */
export class InMemoryPluginMarketplaceStore implements PluginMarketplaceStore {
  private marketplaces: KnownMarketplaceRecord[] = [];
  private installed: InstalledPluginRecord[] = [];

  listMarketplaces(): readonly KnownMarketplaceRecord[] {
    return [...this.marketplaces].map(copyMarketplace).sort(byId);
  }

  saveMarketplaces(records: readonly KnownMarketplaceRecord[]): void {
    this.marketplaces = records.map(copyMarketplace);
  }

  listInstalled(): readonly InstalledPluginRecord[] {
    return [...this.installed].map(copyInstalled).sort(byId);
  }

  saveInstalled(records: readonly InstalledPluginRecord[]): void {
    this.installed = records.map(copyInstalled);
  }
}

/** SQLite 覆盖式存储；每次 save 在一个事务内整表替换，避免半写状态被读到。 */
export class SqlitePluginMarketplaceStore implements PluginMarketplaceStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_marketplaces (
        marketplace_id TEXT NOT NULL PRIMARY KEY,
        record_json TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_installations (
        plugin_id TEXT NOT NULL PRIMARY KEY,
        record_json TEXT NOT NULL
      );
    `);
  }

  listMarketplaces(): readonly KnownMarketplaceRecord[] {
    const rows = this.db.prepare('SELECT record_json FROM plugin_marketplaces').all() as unknown as readonly { record_json: string }[];
    return rows.map((row) => copyMarketplace(JSON.parse(row.record_json) as KnownMarketplaceRecord)).sort(byId);
  }

  saveMarketplaces(records: readonly KnownMarketplaceRecord[]): void {
    const insert = this.db.prepare('INSERT INTO plugin_marketplaces (marketplace_id, record_json) VALUES (?, ?)');
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM plugin_marketplaces');
      for (const record of records) insert.run(record.id, JSON.stringify(copyMarketplace(record)));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listInstalled(): readonly InstalledPluginRecord[] {
    const rows = this.db.prepare('SELECT record_json FROM plugin_installations').all() as unknown as readonly { record_json: string }[];
    return rows.map((row) => copyInstalled(JSON.parse(row.record_json) as InstalledPluginRecord)).sort(byId);
  }

  saveInstalled(records: readonly InstalledPluginRecord[]): void {
    const insert = this.db.prepare('INSERT INTO plugin_installations (plugin_id, record_json) VALUES (?, ?)');
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM plugin_installations');
      for (const record of records) insert.run(record.id, JSON.stringify(copyInstalled(record)));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
