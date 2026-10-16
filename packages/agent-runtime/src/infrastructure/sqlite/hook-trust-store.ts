// 一个文件=一种作用：Hook 信任记录的持久化存储（授权、吊销、损坏检测）。
//
// 与 `memory-ledger-store.ts` 同款形态：`node:sqlite` 的 `DatabaseSync` + WAL +
// JSON 列。但语义有一处关键不同：**记忆账本是 append-only 的，信任存储不是**——
// 授权与吊销都是"当前状态"，重复授权同一条不应堆积历史版本。因此这里的表以
// 信任键为主键（而非 `(id, revision)` 复合主键），`upsert` 即覆盖。
//
// ## 损坏为什么必须被显式区分
//
// `loadStatus()` 返回 `missing` / `ok` / `corrupt` 三态而不是"有没有记录"：
// 损坏的存储若被解读成"没有记录"，结果就是**全部 Hook 静默退回待授权**——
// 表面上安全（因为默认不可执行），但用户会看到"我明明授权过"的困惑，且无法分辨
// 是"被清空了"还是"读坏了"。显式三态让上层能给出准确诊断。

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type HookTrustRecord,
  type HookTrustStoreStatus,
} from '../../hook-trust-contract.js';
import { decodeHookTrustKey, encodeHookTrustKey, hookTrustKey } from '../../hook-trust.js';

/**
 * 信任记录的持久化接口。
 *
 * 拆成接口是因为判定层只需要"能按信任键查到记录 + 能列出吊销键"，不该依赖 SQLite——
 * 测试可以直接喂内存实现，与 `McpManifestStore` 的拆法一致。
 */
export interface HookTrustStore {
  /** 读取存储状态。**损坏必须报 `corrupt` 而非 `missing`**。 */
  status(): HookTrustStoreStatus;
  /** 全部授权记录，按信任键索引。 */
  records(): ReadonlyMap<string, HookTrustRecord>;
  /** 全部吊销键。 */
  revokedKeys(): ReadonlySet<string>;
  /** 授予信任（已存在则覆盖）。 */
  grant(record: HookTrustRecord): void;
  /** 吊销信任键对应的授权。 */
  revoke(key: string): void;
  /** 是否已授权（供 UI 快捷判断）。 */
  isGranted(key: string): boolean;
  /** 释放底层资源。SQLite 实现为关闭连接；内存实现为空操作。 */
  close(): void;
}

/** 内存实现：供测试与"不落盘"场景使用。**永不损坏**。 */
export class InMemoryHookTrustStore implements HookTrustStore {
  private readonly byKey = new Map<string, HookTrustRecord>();
  private readonly revoked = new Set<string>();

  status(): HookTrustStoreStatus {
    return 'ok';
  }

  records(): ReadonlyMap<string, HookTrustRecord> {
    return new Map(this.byKey);
  }

  revokedKeys(): ReadonlySet<string> {
    return new Set(this.revoked);
  }

  grant(record: HookTrustRecord): void {
    const key = hookTrustKey(record.workspaceIdentity, record.declarationDigest);
    this.byKey.set(key, { ...record });
    // 重新授权应当解除吊销——否则用户"先吊销再授权"会发现授权无效。
    this.revoked.delete(key);
  }

  revoke(key: string): void {
    this.byKey.delete(key);
    this.revoked.add(key);
  }

  isGranted(key: string): boolean {
    return this.byKey.has(key);
  }

  close(): void {
    // 纯内存，无资源可释放。显式实现是为了满足接口——调用方不必区分两种实现。
  }
}

/**
 * SQLite 实现。
 *
 * 两张表：`hook_trust_records`（当前授权，键即主键）与 `hook_trust_revocations`
 * （吊销集合）。吊销独立成表而非在记录上加标记位，是因为吊销应当**在记录不存在时
 * 也生效**——用户可以先吊销一条从未授权过的 Hook（例如从远端配置里看到就拒绝）。
 */
export class SqliteHookTrustStore implements HookTrustStore {
  private readonly db: DatabaseSync;
  private degraded = false;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hook_trust_records (
          trust_key TEXT PRIMARY KEY,
          workspace_identity TEXT NOT NULL,
          declaration_digest TEXT NOT NULL,
          record_json TEXT NOT NULL,
          granted_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hook_trust_revocations (
          trust_key TEXT PRIMARY KEY,
          revoked_at_ms INTEGER NOT NULL
        );
      `);
    } catch {
      // 建表失败（磁盘只读、文件被占、DB 损坏）→ 降级。不抛异常：构造失败不该
      // 让调用方失去"至少在内存里工作"的能力，但必须让 status() 报 corrupt，
      // 使上层按未授权处理。
      this.degraded = true;
    }
  }

  status(): HookTrustStoreStatus {
    if (this.degraded) return 'corrupt';
    try {
      // 主动探一次读：建表成功但数据页损坏的情况，只有真正读才会暴露。
      this.db.prepare('SELECT COUNT(*) AS n FROM hook_trust_records').get();
      return 'ok';
    } catch {
      this.degraded = true;
      return 'corrupt';
    }
  }

  records(): ReadonlyMap<string, HookTrustRecord> {
    const out = new Map<string, HookTrustRecord>();
    if (this.status() === 'corrupt') return out;
    try {
      const rows = this.db
        .prepare('SELECT trust_key, record_json FROM hook_trust_records')
        .all() as unknown as readonly { trust_key: string; record_json: string }[];
      for (const row of rows) {
        const key = decodeHookTrustKey(row.trust_key);
        // 键解不出来（畸形转义）→ 跳过该条，不猜。宁可让用户重授一次。
        if (key === undefined) continue;
        const parsed = parseRecord(row.record_json);
        // 单条损坏只跳过这一条，不作废整库——一条坏记录不该让用户的全部授权失效。
        if (parsed !== undefined) out.set(key, parsed);
      }
    } catch {
      this.degraded = true;
      return new Map();
    }
    return out;
  }

  revokedKeys(): ReadonlySet<string> {
    if (this.status() === 'corrupt') return new Set();
    try {
      const rows = this.db
        .prepare('SELECT trust_key FROM hook_trust_revocations')
        .all() as unknown as readonly { trust_key: string }[];
      const out = new Set<string>();
      for (const row of rows) {
        const key = decodeHookTrustKey(row.trust_key);
        if (key !== undefined) out.add(key);
      }
      return out;
    } catch {
      this.degraded = true;
      return new Set();
    }
  }

  grant(record: HookTrustRecord): void {
    const key = hookTrustKey(record.workspaceIdentity, record.declarationDigest);
    const stored = encodeHookTrustKey(key);
    const grantedMs = Number.isFinite(Date.parse(record.grantedAt))
      ? Date.parse(record.grantedAt)
      : Date.now();
    this.db
      .prepare(
        `INSERT INTO hook_trust_records
           (trust_key, workspace_identity, declaration_digest, record_json, granted_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(trust_key) DO UPDATE SET
           record_json = excluded.record_json,
           granted_at_ms = excluded.granted_at_ms`,
      )
      .run(
        stored,
        record.workspaceIdentity,
        record.declarationDigest,
        JSON.stringify(record),
        grantedMs,
      );
    // 授权即解除吊销（与内存实现同语义）。
    this.db.prepare('DELETE FROM hook_trust_revocations WHERE trust_key = ?').run(stored);
  }

  revoke(key: string): void {
    const stored = encodeHookTrustKey(key);
    this.db.prepare('DELETE FROM hook_trust_records WHERE trust_key = ?').run(stored);
    this.db
      .prepare(
        `INSERT INTO hook_trust_revocations (trust_key, revoked_at_ms) VALUES (?, ?)
         ON CONFLICT(trust_key) DO UPDATE SET revoked_at_ms = excluded.revoked_at_ms`,
      )
      .run(stored, Date.now());
  }

  isGranted(key: string): boolean {
    if (this.status() === 'corrupt') return false;
    const row = this.db
      .prepare('SELECT 1 AS hit FROM hook_trust_records WHERE trust_key = ?')
      .get(encodeHookTrustKey(key)) as unknown as { hit: number } | undefined;
    return row !== undefined;
  }

  /**
   * 关闭底层连接。
   *
   * 与其他 SQLite store 同款约定（`memory-ledger-store` / `administrator-lease-store` 等）：
   * 不关闭会持续占用文件句柄，Windows 上表现为临时目录无法删除、测试互相干扰。
   *
   * **刻意不做幂等**：既有 store 都是裸 `close()`，重复调用会抛 `ERR_INVALID_STATE`。
   * 静默吞掉异常会掩盖调用方真正的生命周期错误，故保持一致。
   */
  close(): void {
    this.db.close();
  }
}

/**
 * 解析记录 JSON。
 *
 * **逐字段校验而非整体断言**：`JSON.parse` + 类型断言会把 `{}` 也当成合法记录，
 * 那样一条损坏记录会伪装成"已授权"（因为键存在）。这里字段不全即返回 undefined。
 */
function parseRecord(raw: string): HookTrustRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const input = value as Partial<HookTrustRecord>;
  if (typeof input.workspaceIdentity !== 'string') return undefined;
  if (typeof input.declarationDigest !== 'string') return undefined;
  if (typeof input.sourcePathAtGrant !== 'string') return undefined;
  if (typeof input.indexAtGrant !== 'number') return undefined;
  if (typeof input.grantedAt !== 'string') return undefined;
  return {
    workspaceIdentity: input.workspaceIdentity,
    declarationDigest: input.declarationDigest,
    sourcePathAtGrant: input.sourcePathAtGrant,
    indexAtGrant: input.indexAtGrant,
    grantedAt: input.grantedAt,
    ...(typeof input.appVersionAtGrant === 'string'
      ? { appVersionAtGrant: input.appVersionAtGrant }
      : {}),
  };
}
