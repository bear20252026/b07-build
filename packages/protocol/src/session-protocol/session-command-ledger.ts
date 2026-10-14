// 一个文件=一种作用：客户端命令幂等表——未决登记 + 有界已裁决 LRU。
//
// 借 ZCode `bootstrap/src/zcode-protocol-v4/command-inbox.ts` 的键控纪律（幂等键 =
// {sessionId, commandId}、在途命令常驻、已裁决进有界表），落到**调用方**一侧：
// b07 的会话客户端必须能回答「这条命令我到底提交过没有、结果是什么」，
// 而不是把重试做成第二次副作用。

import { SESSION_COMMAND_LEDGER_CAPACITY } from './session-limits.js';
import type { SessionCommand, SessionCommandAck, SessionCommandBegin } from './session-command.js';

interface LedgerEntry {
  readonly command: SessionCommand;
  /** 载荷指纹：同 id 换内容即串号，必须拒发。 */
  readonly fingerprint: string;
  readonly ack?: SessionCommandAck;
}

const UNSERIALIZABLE = 'session-command-payload-unserializable';
const ID_REUSED = 'session-command-id-reused-with-different-payload';
const STALE_BASE_REUSED = 'session-command-stale-base-reused';

function payloadFingerprint(payload: unknown): string | undefined {
  try {
    return JSON.stringify(payload ?? null);
  } catch {
    return undefined;
  }
}

/** 幂等键：sessionId 为 null（建会话命令）归全局桶，与会话内同名命令天然隔离。 */
export function sessionCommandKey(command: { sessionId: string | null; commandId: string }): string {
  return String(command.sessionId ?? 'null') + ':' + command.commandId;
}

/**
 * 已裁决但允许重发的状态：结果确定未生效（stale 被拒 / 传输未建立），
 * 复用原 commandId 重试正是幂等键的用途。accepted 不在其列。
 */
const RE_SENDABLE_STATUSES = new Set<SessionCommandAck['status']>(['stale', 'failed', 'rejected']);

export class SessionCommandLedger {
  private readonly pending = new Map<string, LedgerEntry>();
  /** 插入序即 LRU 序：超限淘汰最早裁决。 */
  private readonly settledEntries = new Map<string, LedgerEntry>();
  private readonly capacity: number;

  constructor(capacity: number = SESSION_COMMAND_LEDGER_CAPACITY) {
    this.capacity = capacity;
  }

  /**
   * 提交前登记：`send` 才允许写线；`settled` 表示直接复用原裁决（零副作用）；
   * `in-flight` 表示同 id 还在等应答，重复提交会把一次抖动变成两次执行。
   */
  begin(command: SessionCommand): SessionCommandBegin {
    const fingerprint = payloadFingerprint(command.payload);
    if (fingerprint === undefined) {
      return { kind: 'conflict', command, reason: UNSERIALIZABLE };
    }
    const key = sessionCommandKey(command);
    const settled = this.settledEntries.get(key);
    if (settled) {
      if (settled.fingerprint !== fingerprint) {
        return { kind: 'conflict', command, reason: ID_REUSED };
      }
      const ack = settled.ack;
      if (ack === undefined || !RE_SENDABLE_STATUSES.has(ack.status)) {
        return { kind: 'settled', ack: ack ?? { commandId: command.commandId, status: 'failed', reasonCode: 'proto.invalidEnvelope' } };
      }
      if (ack.status === 'stale' && command.baseRevision === settled.command.baseRevision) {
        // 过期基准原地重放必然再次 stale：先收敛再带新基准重试，不在这里空转。
        return { kind: 'conflict', command, reason: STALE_BASE_REUSED };
      }
      // 结果确定未生效：复用原 commandId 重发（幂等键不变）。
      this.settledEntries.delete(key);
      this.pending.set(key, { command, fingerprint });
      return { kind: 'send', command };
    }
    const inFlight = this.pending.get(key);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        return { kind: 'conflict', command, reason: ID_REUSED };
      }
      return { kind: 'in-flight', command: inFlight.command };
    }
    this.pending.set(key, { command, fingerprint });
    return { kind: 'send', command };
  }

  /** 落裁决：未决项移出、进有界表；未在途的 id 忽略（返回 false，不伪造裁决）。 */
  settle(command: SessionCommand, ack: SessionCommandAck): boolean {
    const key = sessionCommandKey(command);
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    this.settledEntries.set(key, { command: entry.command, fingerprint: entry.fingerprint, ack });
    while (this.settledEntries.size > this.capacity) {
      const oldest = this.settledEntries.keys().next();
      if (oldest.done === true) break;
      this.settledEntries.delete(oldest.value);
    }
    return true;
  }

  /** 裁决读数（不区分在途/已裁决）：调用方据此展示与对账。 */
  find(command: { sessionId: string | null; commandId: string }): SessionCommandAck | undefined {
    return this.settledEntries.get(sessionCommandKey(command))?.ack;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get settledCount(): number {
    return this.settledEntries.size;
  }

  /** 会话关闭/重开：清空两张表，历史裁决不再为新会话复用。 */
  clear(): void {
    this.pending.clear();
    this.settledEntries.clear();
  }
}
