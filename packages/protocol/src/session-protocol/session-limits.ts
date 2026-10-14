// 一个文件=一种作用：会话协议要素（日志收敛、命令幂等）的有界常量收口。
//
// 借 ZCode `packages/shared/src/zcode-protocol-v4/core.ts` 的 PROTOCOL_V4_LIMITS 模式：
// 缓冲上限、时限、表容量集中声明，业务代码不散落字面量。数值按 b07 桌面链路取。

/** 会话协议要素版本（与 TaskEvent 的 1.0 各自独立演进）。 */
export const SESSION_PROTOCOL_VERSION = 1 as const;
export type SessionProtocolVersion = typeof SESSION_PROTOCOL_VERSION;

/** 标识符（clientId / sessionId / commandId）字符上限。 */
export const SESSION_MAX_ID_CHARS = 128;

/** 缺口期间最多缓存的条目数：超过即判定补齐无望，流标记为不完整。 */
export const SESSION_RESYNC_PENDING_CAP = 256;
/** 单次补齐请求的应答等待上限（毫秒）：不可取消的底层请求由世代护栏丢弃迟到结果。 */
export const SESSION_RESYNC_REQUEST_TIMEOUT_MS = 30_000;
/** 补齐退避间隔（毫秒）：失败或仍有缺口时按它重试。 */
export const SESSION_RESYNC_RETRY_MS = 1_500;
/** 同一缺口允许的最大连续补齐轮数：超过即 fail-closed，不再无限重订阅。 */
export const SESSION_RESYNC_MAX_ATTEMPTS = 8;

/** 命令幂等表容量：只登记已裁决命令，超出按最早裁决淘汰。 */
export const SESSION_COMMAND_LEDGER_CAPACITY = 512;
