// 一个文件=一种作用：外部会话增量反向索引器（游标续跑 + 幂等 + 竞态守卫 + fail closed）。
//
// 设计借鉴（非源码移植）：`synchronize(since?)` / `synchronizeFile(path)` 两段式同步契约，以及
// 「索引器写库必须早于文件监听器把该文件当成无关新会话」的竞态处理思路，借鉴自一个
// AGPL-3.0-or-later 的第三方项目（项目名与许可见 THIRD-PARTY-NOTICES.md「语义借用（非源码移植）」
// 小节）。该许可与本仓库（MIT）不兼容，故本文件为 b07 独立实现，未复制任何上游代码。
//
// 竞态怎么处理（本批次核心借鉴点）：
//   1. 先用会话主键（文件级稳定身份 = 来源 id + 归一化路径）算出 `sessionId`；
//   2. **先占位登记**（`store.claim`）再读内容：读盘之前账本里已有一行，其他发现者立刻看到
//      「该会话已登记」，不会把它当成新会话再插一条；
//   3. 主键唯一 + `commit()` upsert：即使两个发现者并发跑完，也只会落到同一条记录上；
//   4. 读盘失败则 `rollback()` 撤掉占位，绝不留下半条记录。
//
// 幂等怎么保证：稳定身份 = 来源 id + 归一化路径 + 内容摘要（`sessionKey`）；同一文件同一内容
// 重复索引得到同一身份，且 fast path 用 size+mtime 直接跳过，账本上的 `session_key` 唯一索引兜底。
//
// 增量续跑：每轮把扫描到的最大 modifiedAtMs 记为水位存进游标；下一轮以它为 `since` 传给
// `discover()`，只处理新增/已变化文件。`full: true` 可强制全量重扫（应对被回溯改写的 mtime）。

import { statSync } from 'node:fs';
import {
  externalSessionContentIdentity,
  externalSessionIdentity,
  normalizeRelativePath,
  toExternalSessionDiagnostic,
  type ExternalSessionDiagnostic,
  type ExternalSessionIndexCursor,
  type ExternalSessionIndexRecord,
  type ExternalSessionIndexStore,
  type ExternalSessionSourceAdapter,
} from './external-session-index-types.js';

/** 单轮同步报告。 */
export interface ExternalSessionSyncReport {
  sourceId: string;
  /** discover 返回的候选数。 */
  discovered: number;
  /** 本轮真正写入/覆盖的条数。 */
  indexed: number;
  /** 因 size+mtime 或内容摘要未变而跳过的条数。 */
  skippedUnchanged: number;
  /** 因越界/损坏/超大/未知形态被 fail closed 跳过的条数。 */
  skippedInvalid: number;
  /** 本轮处理（写入 + 跳过）的条目数，供增量续跑观测。 */
  processed: number;
  /** 本轮结束后的水位（epoch ms）。 */
  watermarkMs: number;
  diagnostics: readonly ExternalSessionDiagnostic[];
}

/** 单文件同步结果（供文件监听器使用）。 */
export interface ExternalSessionFileSyncResult {
  /** 写入成功时的会话主键；跳过或失败为 null。 */
  sessionId: string | null;
  indexed: boolean;
  skippedUnchanged: boolean;
  diagnostic?: ExternalSessionDiagnostic;
}

export interface ExternalSessionIndexerOptions {
  source: ExternalSessionSourceAdapter;
  store: ExternalSessionIndexStore;
  /** 时钟注入点；默认 Date.now。 */
  now?: () => number;
}

export interface ExternalSessionSyncOptions {
  /** 显式水位（epoch ms）；缺省时用游标里存的上次水位。 */
  since?: number;
  /** 强制全量重扫（忽略游标水位），用于修复被回溯改写的 mtime。 */
  full?: boolean;
}

/**
 * 增量索引器：把外部来源的磁盘会话文件同步进 b07 索引账本。
 * 只做「发现 → 占位 → 读归一化 → 覆盖写入」，不解释会话语义、不执行任何工具。
 */
export class ExternalSessionIndexer {
  private readonly source: ExternalSessionSourceAdapter;
  private readonly store: ExternalSessionIndexStore;
  private readonly now: () => number;

  constructor(options: ExternalSessionIndexerOptions) {
    this.source = options.source;
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  get sourceId(): string {
    return this.source.id;
  }

  /** 全量/增量扫描一轮，返回本轮处理统计。 */
  async synchronize(options: ExternalSessionSyncOptions = {}): Promise<ExternalSessionSyncReport> {
    const sourceId = this.source.id;
    const cursor = this.store.loadCursor(sourceId);
    const since = options.full ? undefined : options.since ?? cursor?.watermarkMs;
    const candidates = await this.source.discover(since);

    const diagnostics: ExternalSessionDiagnostic[] = [];
    let indexed = 0;
    let skippedUnchanged = 0;
    let skippedInvalid = 0;
    let watermarkMs = cursor?.watermarkMs ?? 0;

    for (const candidate of candidates) {
      if (candidate.modifiedAtMs > watermarkMs) watermarkMs = candidate.modifiedAtMs;

      // 越界校验（纵深防御）：候选声明的相对路径必须与从 filePath 归一化出来的一致。
      const relativePath = normalizeRelativePath(this.source.rootDir, candidate.filePath);
      if (relativePath === undefined || relativePath !== candidate.relativePath) {
        diagnostics.push({
          code: 'external_session_path_escaped',
          message: `候选会话文件越出来源根目录：${candidate.filePath}`,
          path: candidate.filePath,
          severity: 'error',
        });
        skippedInvalid += 1;
        continue;
      }

      const sessionId = externalSessionIdentity(sourceId, relativePath);
      const current = this.store.load(sessionId);

      // 增量快路径：size+mtime 均未变 → 不读盘、不写库。
      if (
        current?.status === 'indexed' &&
        current.observedSizeBytes === candidate.sizeBytes &&
        current.observedModifiedAtMs === candidate.modifiedAtMs
      ) {
        skippedUnchanged += 1;
        continue;
      }

      // 竞态守卫：先占位登记再读内容。
      const claimedNew = this.store.claim({
        sessionId,
        sourceId,
        relativePath,
        filePath: candidate.filePath,
        observedSizeBytes: candidate.sizeBytes,
        observedModifiedAtMs: candidate.modifiedAtMs,
        at: this.now(),
      });

      let readResult;
      try {
        readResult = await this.source.read(candidate.filePath);
      } catch (error) {
        // fail closed：撤掉占位，绝不留下半条记录。
        if (claimedNew) {
          this.store.rollback(sessionId, { sizeBytes: candidate.sizeBytes, modifiedAtMs: candidate.modifiedAtMs });
        }
        diagnostics.push(toExternalSessionDiagnostic(error, relativePath));
        skippedInvalid += 1;
        continue;
      }

      const contentDigest = readResult.contentDigest;
      const sessionKey = externalSessionContentIdentity(sourceId, relativePath, contentDigest);

      // 幂等：内容摘要未变（仅 mtime 被触碰）→ 不重复写库。
      if (current?.status === 'indexed' && current.contentDigest === contentDigest) {
        skippedUnchanged += 1;
        continue;
      }

      const session = readResult.session;
      const record: ExternalSessionIndexRecord = {
        sessionId,
        sessionKey,
        sourceId,
        relativePath,
        filePath: candidate.filePath,
        status: 'indexed',
        contentDigest,
        externalSessionId: session.externalSessionId,
        ...(session.title !== undefined ? { title: session.title } : {}),
        messageCount: session.messages.length,
        observedSizeBytes: candidate.sizeBytes,
        observedModifiedAtMs: candidate.modifiedAtMs,
        indexedAtMs: this.now(),
        session,
      };
      this.store.commit(record);
      indexed += 1;
    }

    const report: ExternalSessionSyncReport = {
      sourceId,
      discovered: candidates.length,
      indexed,
      skippedUnchanged,
      skippedInvalid,
      processed: indexed + skippedUnchanged + skippedInvalid,
      watermarkMs,
      diagnostics,
    };
    const nextCursor: ExternalSessionIndexCursor = {
      sourceId,
      watermarkMs,
      lastProcessedCount: report.processed,
      updatedAtMs: this.now(),
    };
    this.store.saveCursor(nextCursor);
    return report;
  }

  /**
   * 单文件增量同步（文件监听器入口）：同样先占位后读，保证与 `synchronize()` 并发时只有一条记录。
   * 返回写入的会话主键，或 null（跳过/失败）。
   */
  async synchronizeFile(filePath: string): Promise<ExternalSessionFileSyncResult> {
    const sourceId = this.source.id;
    const relativePath = normalizeRelativePath(this.source.rootDir, filePath);
    if (relativePath === undefined) {
      return {
        sessionId: null,
        indexed: false,
        skippedUnchanged: false,
        diagnostic: {
          code: 'external_session_path_escaped',
          message: `会话文件越出来源根目录：${filePath}`,
          path: filePath,
          severity: 'error',
        },
      };
    }

    const sessionId = externalSessionIdentity(sourceId, relativePath);

    let sizeBytes = 0;
    let modifiedAtMs = 0;
    try {
      const stat = statSync(filePath);
      sizeBytes = stat.size;
      modifiedAtMs = stat.mtimeMs;
    } catch {
      // 取不到元数据不阻断；交由 read() 产出可读诊断。
    }

    // 增量快路径：已索引且 size+mtime 未变 → 不读盘、不写库。
    const current = this.store.load(sessionId);
    if (
      current?.status === 'indexed' &&
      current.observedSizeBytes === sizeBytes &&
      current.observedModifiedAtMs === modifiedAtMs
    ) {
      return { sessionId, indexed: false, skippedUnchanged: true };
    }

    // 竞态守卫：先占位登记再读内容（与 synchronize() 并发时同样只落一条记录）。
    const claimedNew = this.store.claim({
      sessionId,
      sourceId,
      relativePath,
      filePath,
      observedSizeBytes: sizeBytes,
      observedModifiedAtMs: modifiedAtMs,
      at: this.now(),
    });

    try {
      const readResult = await this.source.read(filePath);
      const contentDigest = readResult.contentDigest;
      const session = readResult.session;
      this.store.commit({
        sessionId,
        sessionKey: externalSessionContentIdentity(sourceId, relativePath, contentDigest),
        sourceId,
        relativePath,
        filePath,
        status: 'indexed',
        contentDigest,
        externalSessionId: session.externalSessionId,
        ...(session.title !== undefined ? { title: session.title } : {}),
        messageCount: session.messages.length,
        observedSizeBytes: sizeBytes,
        observedModifiedAtMs: modifiedAtMs,
        indexedAtMs: this.now(),
        session,
      });
      return { sessionId, indexed: true, skippedUnchanged: false };
    } catch (error) {
      if (claimedNew) this.store.rollback(sessionId, { sizeBytes, modifiedAtMs });
      return {
        sessionId: null,
        indexed: false,
        skippedUnchanged: false,
        diagnostic: toExternalSessionDiagnostic(error, relativePath),
      };
    }
  }
}
