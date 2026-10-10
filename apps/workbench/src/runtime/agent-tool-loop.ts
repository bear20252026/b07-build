import type { DirectProviderClient, DirectProviderMessage, DirectProviderTool, DirectProviderToolCall } from './direct-provider-client';

/**
 * Agent 回合：把「模型说话 → 模型要工具 → 执行 → 回填结果 → 模型再说」跑成一个闭环。
 *
 * 单轮 stream 只能拿到文字；这里负责在 tool_calls 出现时继续执行并把结果以
 * role="tool" 回传，直到模型不再要工具或达到轮次上限。
 *
 * 轮次上限不是可选项：模型完全可能在工具报错后无限重试同一个调用，
 * 没有上限就会静默烧掉用户的 token。
 */

/** 默认最多 6 轮。够完成「列目录 → 读文件 → 改文件 → 汇报」，又不至于失控。 */
export const AGENT_MAX_ROUNDS = 6;

export interface AgentTurnInput {
  readonly client: DirectProviderClient;
  readonly providerId: string;
  readonly model?: string;
  /** 进入本回合前的完整对话历史，函数不会修改它。 */
  readonly messages: readonly DirectProviderMessage[];
  readonly tools: readonly DirectProviderTool[];
  /** 执行一次调用，返回要作为工具结果回填的文本。失败应当返回失败描述而不是抛出。 */
  execute(name: string, rawArguments: string): Promise<string>;
  onText(chunk: string): void;
  onReasoning?(chunk: string): void;
  /** 某次调用执行完毕时触发，可用于在界面上留下可审计的痕迹。 */
  onToolResult?(call: DirectProviderToolCall, result: string): void;
  onToolCallStart?(name: string): void;
  readonly maxRounds?: number;
}

export interface AgentTurnResult {
  readonly model?: string;
  /** 追加了本回合 assistant 与工具消息之后的历史，可直接用于持久化。 */
  readonly messages: readonly DirectProviderMessage[];
  readonly rounds: number;
  readonly executedCalls: number;
  /** 达到轮次上限而被截断：模型最后一轮仍在要工具。 */
  readonly stoppedByRoundLimit: boolean;
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const limit = Math.max(1, Math.min(input.maxRounds ?? AGENT_MAX_ROUNDS, 20));
  let history: readonly DirectProviderMessage[] = input.messages;
  let model = input.model;
  let executedCalls = 0;
  let rounds = 0;

  for (let round = 1; round <= limit; round += 1) {
    let text = '';
    const completion = await input.client.stream({
      providerId: input.providerId,
      ...(model ? { model } : {}),
      messages: history,
      tools: input.tools,
      onText: (chunk) => { text += chunk; input.onText(chunk); },
      ...(input.onReasoning ? { onReasoning: input.onReasoning } : {}),
      ...(input.onToolCallStart ? { onToolCallStart: input.onToolCallStart } : {}),
    });
    rounds = round;
    if (completion.model) model = completion.model;

    // 模型不再要工具：这是正常出口，把这一轮说的话原样留下即可。
    if (completion.toolCalls.length === 0) {
      return {
        ...(model ? { model } : {}),
        messages: [...history, { role: 'assistant' as const, content: text }],
        rounds,
        executedCalls,
        stoppedByRoundLimit: false,
      };
    }

    // 有调用就先把 assistant 这一轮连同 tool_calls 写进历史：
    // 少了它，模型下一轮看不到自己做过什么，会重复发起同样的调用。
    history = [...history, { role: 'assistant' as const, content: text, toolCalls: completion.toolCalls }];
    for (const call of completion.toolCalls) {
      const result = await input.execute(call.name, call.arguments);
      executedCalls += 1;
      input.onToolResult?.(call, result);
      history = [...history, { role: 'tool' as const, content: result, toolCallId: call.id }];
    }
  }

  // 跑满上限仍然在要工具：如实标记，让上层提示用户，而不是假装这一轮已经回答完。
  return { ...(model ? { model } : {}), messages: history, rounds, executedCalls, stoppedByRoundLimit: true };
}
