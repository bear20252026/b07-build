// 一个文件=一种作用：权限人工裁决入口（PermissionBroker）与 fail-closed 缺省。
//
// 借鉴 ZCode `permission/broker.ts`：决策链产出 require_approval 后，唯一的
// 放行通道是这个 broker。两条硬规则照搬：
//   1. **未装配人工入口 = 拒绝**（DenyPermissionBroker 是缺省实现）——没有
//      UI 在线的执行路径（CLI、后台任务）不可能悄悄放行 medium/high；
//   2. **no-always-allow 缺省**（ZCode PermissionOptionsPolicy）：询问一次
//      应答一次，"总是允许"必须显式开启 session 级持久化，防止一次手滑把
//      gate 永久关死。收窄方向同样单向：ask 只能被应答为 allow，不存在
//      把 allow 改回 ask 的路径。

import type { Capability, RiskLevel } from '@awo/protocol';

export interface PermissionQuestion {
  readonly actionId: string;
  readonly toolName: string;
  readonly capability: Capability;
  readonly risk: RiskLevel;
  /** 决策链给的理由（含 ruleId 时由调用方附带）。 */
  readonly reason: string;
  /** 输入摘要（调用方裁剪后的预览，绝不在问题里塞全量参数）。 */
  readonly inputPreview: string;
}

export interface PermissionBroker {
  ask(question: PermissionQuestion): Promise<boolean>;
}

/** fail-closed 缺省 broker：一切人工裁决请求都以拒绝收尾。 */
export class DenyPermissionBroker implements PermissionBroker {
  // 问题参数故意不读：没有人工入口时，问什么都是拒绝。
  async ask(_question: PermissionQuestion): Promise<boolean> {
    return false;
  }
}

export type ApprovalPersistence = 'none' | 'session';

export interface ManualBrokerOptions {
  /** 'none'（缺省）：单次应答，UI 不得提供"总是允许"。 */
  readonly persistence?: ApprovalPersistence;
  /** 待答复超时（毫秒）；超时按拒绝，绝不无限挂起执行路径。 */
  readonly pendingTimeoutMs?: number;
}

const DEFAULT_PENDING_TIMEOUT_MS = 120_000;

interface PendingEntry {
  readonly question: PermissionQuestion;
  readonly followers: ((approved: boolean) => void)[];
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/**
 * 人工裁决 broker：pending 表 + 超时拒绝 + 恰好一次应答（重复 respond 是
 * no-op）。React 侧只镜像展示 pending 列表，不参与事务语义（与 b07 既有
 * ApprovalRequestQueue 的"消耗即移除"同一纪律）。
 */
export class ManualPermissionBroker implements PermissionBroker {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly timeoutMs: number;
  private readonly persistence: ApprovalPersistence;
  /** session 级"允许记住"的 capability:toolName 集合（仅 persistence='session' 时生长）。 */
  private readonly sessionAllowed = new Set<string>();

  constructor(options: ManualBrokerOptions = {}) {
    this.timeoutMs = options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
    this.persistence = options.persistence ?? 'none';
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  pendingQuestions(): readonly PermissionQuestion[] {
    return [...this.pending.values()].map((entry) => entry.question);
  }

  ask(question: PermissionQuestion): Promise<boolean> {
    const sessionKey = `${question.capability}:${question.toolName}`;
    if (this.persistence === 'session' && this.sessionAllowed.has(sessionKey)) {
      return Promise.resolve(true);
    }
    const existing = this.pending.get(question.actionId);
    if (existing) {
      // 同 actionId 重复入队：与先到者共命运（先到请求可能已被应答，不能被覆盖）。
      return new Promise<boolean>((resolve) => existing.followers.push(resolve));
    }
    return new Promise<boolean>((resolve) => {
      const entry: PendingEntry = {
        question,
        followers: [resolve],
        timer: setTimeout(() => this.settle(question.actionId, false), this.timeoutMs),
        settled: false,
      };
      this.pending.set(question.actionId, entry);
    });
  }

  /** 恰好一次应答：消耗成功才 resolve；重复应答返回 false。 */
  respond(actionId: string, approved: boolean): boolean {
    const entry = this.pending.get(actionId);
    if (!entry || entry.settled) return false;
    if (approved && this.persistence === 'session') {
      this.sessionAllowed.add(`${entry.question.capability}:${entry.question.toolName}`);
    }
    this.settle(actionId, approved);
    return true;
  }

  /** 对全部未决请求明确拒绝（会话关闭/执行中止时调用）。 */
  denyAll(): void {
    for (const actionId of [...this.pending.keys()]) this.settle(actionId, false);
  }

  private settle(actionId: string, approved: boolean): void {
    const entry = this.pending.get(actionId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(actionId);
    for (const follower of entry.followers) follower(approved);
  }
}
