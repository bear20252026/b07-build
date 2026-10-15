// 一个文件=一种作用：会话命令信封——幂等键、CAS 基准与客户端有界裁决表。
//
// 移植自 ZCode `packages/shared/src/zcode-protocol-v4/command.ts` 与
// `bootstrap/src/zcode-protocol-v4/command-inbox.ts` 的客户端可复用部分
// （见 THIRD-PARTY-NOTICES.md）。三条纪律：
//   1. commandId 由客户端生成，重试**必须复用原 id**（幂等键 = {sessionId, commandId}），
//      否则一次网络抖动就是两次副作用；
//   2. baseRevision 是 CAS 基准：带着过期基准重放没有意义，服务端会拒；
//      重试只允许刷新基准，不允许换命令；
//   3. issuedAt 只作观测，绝不参与裁决（本地时钟不可信，ZCode 同一纪律）。
//
// 服务端侧的准入裁决表等 b07 自己的会话生产者落地时再补，本文件只提供调用方
// 真正用到的形态。

import { SESSION_MAX_ID_CHARS } from './session-limits.js';

/** 命令裁决状态（与 ZCode commandAckSchema 同一闭集）。 */
export const SESSION_COMMAND_STATUSES = ['accepted', 'rejected', 'stale', 'duplicate', 'noop', 'failed'] as const;
export type SessionCommandStatus = (typeof SESSION_COMMAND_STATUSES)[number];

/** 稳定拒绝码：调用方按码分流，不按错误文本猜测。 */
export const SESSION_COMMAND_REASON_CODES = {
  missingBaseRevision: 'proto.missingBaseRevision',
  staleRevision: 'proto.staleRevision',
  staleLogEpoch: 'proto.staleLogEpoch',
  invalidEnvelope: 'proto.invalidEnvelope',
  payloadConflict: 'proto.payloadConflict',
  transportClosed: 'proto.transportClosed',
} as const;

/** 载荷默认是受控记录；调用方可用泛型收窄。 */
export interface SessionCommand<TPayload = Readonly<Record<string, unknown>>> {
  readonly commandId: string;
  readonly clientId: string;
  /** null = 建会话命令（此时还没有会话可归属）。 */
  readonly sessionId: string | null;
  readonly type: string;
  readonly payload: TPayload;
  /** CAS 基准；缺失 = 不做基准校验（调用方明确放弃，而不是忘记传）。 */
  readonly baseRevision?: number;
  readonly baseLogEpoch?: string;
  /** 客户端时钟，仅观测。 */
  readonly issuedAt: number;
}

export interface SessionCommandAck {
  readonly commandId: string;
  readonly status: SessionCommandStatus;
  /** 裁决时对端结构水位；对端未回则缺失（不得用本地推测填充）。 */
  readonly revisionAtDecision?: number;
  readonly reasonCode?: string;
  readonly message?: string;
  readonly result?: unknown;
}

export type SessionCommandInput<TPayload = Readonly<Record<string, unknown>>> =
  Omit<SessionCommand<TPayload>, 'commandId' | 'issuedAt'> & { readonly commandId?: string; readonly issuedAt?: number };

export class SessionCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function isId(value: string): boolean {
  return value.length > 0 && value.length <= SESSION_MAX_ID_CHARS;
}

/** 客户端命令标识：优先用宿主 uuid，缺环境时退化为可关联随机串。 */
export function sessionCommandId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?(): string } }).crypto;
  const id = cryptoRef?.randomUUID?.();
  return typeof id === 'string' && isId(id) ? id : `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 构造命令信封：标识符非法直接抛错，不带着坏信封继续走。 */
export function createSessionCommand<TPayload = Readonly<Record<string, unknown>>>(
  input: SessionCommandInput<TPayload>,
): SessionCommand<TPayload> {
  const commandId = input.commandId ?? sessionCommandId();
  if (!isId(commandId)) throw new SessionCommandError('session-command-id-invalid', `commandId 无效：${commandId}`);
  if (!isId(input.clientId)) throw new SessionCommandError('session-client-id-invalid', `clientId 无效：${input.clientId}`);
  if (input.sessionId !== null && !isId(input.sessionId)) throw new SessionCommandError('session-id-invalid', 'sessionId 无效');
  if (!isId(input.type)) throw new SessionCommandError('session-command-type-invalid', '命令类型无效');
  if (input.baseRevision !== undefined && (!Number.isInteger(input.baseRevision) || input.baseRevision < 0)) {
    throw new SessionCommandError('session-base-revision-invalid', 'baseRevision 必须是非负整数');
  }
  return {
    commandId,
    clientId: input.clientId,
    sessionId: input.sessionId,
    type: input.type,
    payload: input.payload,
    issuedAt: input.issuedAt ?? Date.now(),
    ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
    ...(input.baseLogEpoch === undefined ? {} : { baseLogEpoch: input.baseLogEpoch }),
  };
}

/**
 * 重试形态：**保留 commandId**（幂等键不变），只刷新 CAS 基准。
 * 换新 id 等于第二次提交；沿用过期基准等于必然 stale——两者都不允许。
 */
export function withCommandBase<TPayload>(
  command: SessionCommand<TPayload>,
  base: { revision?: number; logEpoch?: string },
): SessionCommand<TPayload> {
  // 未指定即沿用原基准：重试不得把 CAS 校验悄悄丢掉（丢掉=放弃冲突检测）。
  const revision = base.revision ?? command.baseRevision;
  const logEpoch = base.logEpoch ?? command.baseLogEpoch;
  return {
    commandId: command.commandId,
    clientId: command.clientId,
    sessionId: command.sessionId,
    type: command.type,
    payload: command.payload,
    issuedAt: Date.now(),
    ...(revision === undefined ? {} : { baseRevision: revision }),
    ...(logEpoch === undefined ? {} : { baseLogEpoch: logEpoch }),
  };
}

export function acceptSessionCommand(commandId: string, result?: unknown): SessionCommandAck {
  return { commandId, status: 'accepted', ...(result === undefined ? {} : { result }) };
}

export interface SessionCommandFailure {
  readonly status: Extract<SessionCommandStatus, 'rejected' | 'stale' | 'failed'>;
  readonly reasonCode?: string;
  readonly message?: string;
  readonly revisionAtDecision?: number;
}

/** 失败裁决必须带稳定拒绝码，否则无法对账。 */
export function rejectSessionCommand(commandId: string, failure: SessionCommandFailure): SessionCommandAck {
  return {
    commandId,
    status: failure.status,
    reasonCode: failure.reasonCode ?? SESSION_COMMAND_REASON_CODES.invalidEnvelope,
    ...(failure.message === undefined ? {} : { message: failure.message }),
    ...(failure.revisionAtDecision === undefined ? {} : { revisionAtDecision: failure.revisionAtDecision }),
  };
}

/** 命令是否因基准过期被拒：调用方据此先收敛再重试，不能原地重放。 */
export function isStaleSessionCommand(ack: SessionCommandAck): boolean {
  return ack.status === 'stale';
}

export type SessionCommandBegin =
  /** 可以提交：首次，或上一次以 stale/failed 收口后由调用方主动重试。 */
  | { readonly kind: 'send'; readonly command: SessionCommand }
  /** 同 id 正在等应答：不得重复提交。 */
  | { readonly kind: 'in-flight'; readonly command: SessionCommand }
  /** 同 id 已有裁决：重放直接拿原裁决，不再产生第二次副作用。 */
  | { readonly kind: 'settled'; readonly ack: SessionCommandAck }
  /** 同 id 载荷不同：串号提交，fail-closed 拒绝发出。 */
  | { readonly kind: 'conflict'; readonly command: SessionCommand; readonly reason: string };

