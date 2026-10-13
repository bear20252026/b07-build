// 一个文件=一种作用：ZCode 反向请求审批队列的同步状态机。
//
// R1 审计 R2 指出：React setState 的更新函数不保证只执行一次，把「消耗 + 应答」
// 放在里面没有恰好一次保证。这里把队列抽成独立的同步状态机——requestId 索引、
// 消耗即移除（天然防重复应答）、denyAll 供会话关闭时对全部未决请求明确拒绝；
// React 只通过 list() 镜像展示，不参与事务语义。

export type ApprovalDecision = 'allow' | 'deny';

export interface ApprovalQueueEntry {
  /** 队列内唯一标识：来自请求参数的 requestId，缺失时由调用方生成。 */
  readonly id: string;
  readonly kind: 'permission' | 'userInput';
  readonly toolName: string;
  readonly reason: string;
  readonly riskLevel: string;
  readonly inputPreview: string;
  /** 用户输入问题的结构化描述（来自 zcodeUserInputQuestionSchema）。 */
  readonly questions?: readonly {
    readonly question: string;
    readonly header?: string;
    readonly options: readonly { readonly value: string; readonly label: string }[];
    readonly multiSelect?: boolean;
  }[];
  resolve(decision: ApprovalDecision, reason?: string, content?: unknown): void;
}

export class ApprovalRequestQueue {
  private readonly entries = new Map<string, ApprovalQueueEntry>();

  /** 入队。requestId 冲突时保留先到者（先到请求可能已被应答，不能被覆盖）。 */
  add(entry: ApprovalQueueEntry): void {
    if (this.entries.has(entry.id)) return;
    this.entries.set(entry.id, entry);
  }

  list(): readonly ApprovalQueueEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * 恰好一次应答：消耗（移除）成功才调用 resolve；重复应答是 no-op 并返回 false。
   */
  respond(id: string, decision: ApprovalDecision, reason?: string, content?: unknown): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    entry.resolve(decision, reason, content);
    return true;
  }

  /** 对全部未决请求明确拒绝（会话关闭时调用），并清空队列。 */
  denyAll(reason: string): void {
    for (const [, entry] of this.entries) {
      entry.resolve('deny', reason);
    }
    this.entries.clear();
  }
}
