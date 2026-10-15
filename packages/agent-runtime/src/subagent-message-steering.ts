// 一个文件=一种作用：父↔子代理消息路由（转向）。
//
// 借 ZCode `apps/zcode-cli/packages/core/src/subagent/message-steering.ts` 与
// `coordinator-response.ts` 的路由语义：父把带 summary 的转向消息投给子，子把结果回投给父，
// summary 与正文以空行分隔。b07 未移植 2145 行的 runner，也不存在 turn steer 运行时，
// 因此这里落地为可注入、可测试的双向队列路由（每个子代理一对独立收件箱），
// 而不是绑定具体 turn 生命周期。

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type SubagentMessageDirection = 'parent-to-child' | 'child-to-parent';

/** 路由后的消息：正文已按协调者格式（summary + 空行 + 正文）拼装。 */
export interface SubagentMessage {
  id: string;
  childId: string;
  direction: SubagentMessageDirection;
  content: string;
  at: number;
}

/** 父侧投递给子侧的消息输入。 */
export interface SubagentMessageInput {
  /** 幂等 id：同一 id 重复投递被拒绝，避免父 turn 重放时重复转向。 */
  id: string;
  childId: string;
  message: string;
  summary?: string;
  at: number;
}

/** 绑定方向的出站消息输入（由 sink 补齐 childId 与方向）。 */
export interface SubagentOutboundMessageInput {
  id: string;
  message: string;
  summary?: string;
  at: number;
}

export interface SubagentMessageSink {
  send(message: SubagentOutboundMessageInput): SubagentMessage;
}

/** summary 非空时按 `summary\n\n正文` 拼装；否则原样返回正文。 */
export function formatCoordinatorMessage(message: { message: string; summary?: string }): string {
  const summary = message.summary?.trim();
  if (!summary) return message.message;
  return [summary, '', message.message].join('\n');
}

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} 必须是 1-128 位安全标识符`);
}

/**
 * 父子双向消息路由。每个子代理持有一对收件箱（toChild / toParent），
 * 必须先 `open` 才能投递；消息 id 全局幂等。
 */
export class SubagentMessageRouter {
  private readonly childInboxes = new Map<string, SubagentMessage[]>();
  private readonly parentInboxes = new Map<string, SubagentMessage[]>();
  private readonly deliveredIds = new Set<string>();

  /** 打开一个子代理的双向通道；重复打开直接拒绝。 */
  open(childId: string): void {
    assertIdentifier(childId, 'childId');
    if (this.childInboxes.has(childId)) throw new Error(`子代理 ${childId} 已打开`);
    this.childInboxes.set(childId, []);
    this.parentInboxes.set(childId, []);
  }

  isOpen(childId: string): boolean {
    return this.childInboxes.has(childId);
  }

  /** 关闭通道并丢弃未取走的排队消息。 */
  close(childId: string): void {
    this.childInboxes.delete(childId);
    this.parentInboxes.delete(childId);
  }

  sendToChild(input: SubagentMessageInput): SubagentMessage {
    return this.deliver(input, 'parent-to-child');
  }

  sendToParent(input: SubagentMessageInput): SubagentMessage {
    return this.deliver(input, 'child-to-parent');
  }

  /** 子侧取走一条父消息（FIFO）；无消息返回 undefined。 */
  takeForChild(childId: string): SubagentMessage | undefined {
    return this.dequeue(this.childInboxes, childId);
  }

  /** 父侧取走一条子消息（FIFO）；无消息返回 undefined。 */
  takeForParent(childId: string): SubagentMessage | undefined {
    return this.dequeue(this.parentInboxes, childId);
  }

  pending(childId: string): { toChild: number; toParent: number } {
    return {
      toChild: this.childInboxes.get(childId)?.length ?? 0,
      toParent: this.parentInboxes.get(childId)?.length ?? 0,
    };
  }

  /** 父侧 sink：send 即投递给指定子代理。 */
  createParentSink(childId: string): SubagentMessageSink {
    this.requireOpen(childId);
    return { send: (message) => this.sendToChild({ ...message, childId }) };
  }

  /** 子侧 sink：send 即回投给父代理。 */
  createChildSink(childId: string): SubagentMessageSink {
    this.requireOpen(childId);
    return { send: (message) => this.sendToParent({ ...message, childId }) };
  }

  private deliver(input: SubagentMessageInput, direction: SubagentMessageDirection): SubagentMessage {
    assertIdentifier(input.id, 'id');
    assertIdentifier(input.childId, 'childId');
    if (!input.message.trim()) throw new Error('子代理消息正文不能为空');
    if (!Number.isSafeInteger(input.at) || input.at < 0) throw new Error('at 必须是非负安全整数');
    if (this.deliveredIds.has(input.id)) throw new Error(`子代理消息 ${input.id} 已投递，拒绝重复`);
    const queue = this.requireOpen(input.childId, direction);
    const message: SubagentMessage = {
      id: input.id,
      childId: input.childId,
      direction,
      content: formatCoordinatorMessage(input),
      at: input.at,
    };
    queue.push(message);
    this.deliveredIds.add(input.id);
    return { ...message };
  }

  private dequeue(
    inboxes: Map<string, SubagentMessage[]>,
    childId: string,
  ): SubagentMessage | undefined {
    assertIdentifier(childId, 'childId');
    const queue = inboxes.get(childId);
    if (!queue) throw new Error(`子代理 ${childId} 未打开`);
    const next = queue.shift();
    return next ? { ...next } : undefined;
  }

  private requireOpen(childId: string, direction?: SubagentMessageDirection): SubagentMessage[] {
    assertIdentifier(childId, 'childId');
    const inboxes = direction === 'child-to-parent' ? this.parentInboxes : this.childInboxes;
    const queue = inboxes.get(childId);
    if (!queue) throw new Error(`子代理 ${childId} 未打开`);
    return queue;
  }
}
