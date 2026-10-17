import type { DirectProviderClient, DirectProviderImage, DirectProviderMessage, DirectProviderTool, DirectProviderToolCall } from './direct-provider-client';

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

/**
 * 一次工具执行的返回值。
 *
 * 允许带图片是因为**有些工具的结果本身就是图片**（浏览器截图就是）。只能返回文本
 * 的话，图片要么被塞进文本（一次截图几十万字符，且截断即损坏），要么只能给模型一句
 * "图没附上"——两种都不算把结果交给了模型。
 */
export interface AgentToolResult {
  /** 作为工具结果回填的文本。 */
  readonly text: string;
  /** 随结果一并交给模型的图片。 */
  readonly images?: readonly DirectProviderImage[];
}

/** 执行结果：纯文本，或文本 + 图片。 */
export type AgentToolExecution = string | AgentToolResult;

export interface AgentTurnInput {
  readonly client: DirectProviderClient;
  readonly providerId: string;
  readonly model?: string;
  /** 进入本回合前的完整对话历史，函数不会修改它。 */
  readonly messages: readonly DirectProviderMessage[];
  readonly tools: readonly DirectProviderTool[];
  /**
   * 执行一次调用。失败应当返回失败描述而不是抛出。
   *
   * 返回 `AgentToolResult` 时可携带图片；返回字符串等价于 `{ text }`。
   */
  execute(name: string, rawArguments: string): Promise<AgentToolExecution>;
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
  /**
   * 回合因模型请求失败而中断。
   *
   * **关键**：中断不代表"什么都没发生"——失败之前可能已经执行过工具，文件真的被改了。
   * 因此本函数**不抛异常**，而是把已经发生的事（`messages` 里的工具结果、
   * `executedCalls`）连同失败原因一起返回，由上层决定如何呈现。
   */
  readonly failure?: AgentTurnFailure;
}

/** 回合中断的原因。 */
export interface AgentTurnFailure {
  /** 出错的轮次（从 1 开始）。 */
  readonly round: number;
  /** 原始错误；翻译成人话是上层的事（见 `streamErrorText`）。 */
  readonly error: unknown;
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const limit = Math.max(1, Math.min(input.maxRounds ?? AGENT_MAX_ROUNDS, 20));
  let history: readonly DirectProviderMessage[] = input.messages;
  let model = input.model;
  let executedCalls = 0;
  let rounds = 0;

  for (let round = 1; round <= limit; round += 1) {
    rounds = round;
    let text = '';
    let completion;
    try {
      completion = await input.client.stream({
        providerId: input.providerId,
        ...(model ? { model } : {}),
        messages: history,
        tools: input.tools,
        onText: (chunk) => { text += chunk; input.onText(chunk); },
        ...(input.onReasoning ? { onReasoning: input.onReasoning } : {}),
        ...(input.onToolCallStart ? { onToolCallStart: input.onToolCallStart } : {}),
      });
    } catch (error: unknown) {
      // **不抛出**：抛出去会让上层丢掉整个回合的执行痕迹。上层若据此删掉流式消息，
      // 用户看到的是"什么都没发生"，而磁盘上的文件已经变了——这会误导重试，
      // 也让事后排查失去唯一依据。
      return {
        ...(model ? { model } : {}),
        messages: history,
        rounds,
        executedCalls,
        stoppedByRoundLimit: false,
        failure: { round, error },
      };
    }
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
      let execution: AgentToolExecution;
      try {
        execution = await input.execute(call.name, call.arguments);
      } catch (error: unknown) {
        // `execute` 的契约是"失败返回描述而不是抛出"。真抛了说明契约被违反，
        // 但**已执行过的调用仍然算数**，同样不能把整回合的痕迹丢掉。
        return {
          ...(model ? { model } : {}),
          messages: history,
          rounds,
          executedCalls,
          stoppedByRoundLimit: false,
          failure: { round, error },
        };
      }
      const result = typeof execution === 'string' ? execution : execution.text;
      const images = typeof execution === 'string' ? undefined : execution.images;
      executedCalls += 1;
      input.onToolResult?.(call, result);
      // 图片与文本一起回填到**同一条** tool 消息上：拆成两条会让上游对不回 call id。
      history = [
        ...history,
        { role: 'tool' as const, content: result, toolCallId: call.id, ...(images?.length ? { images } : {}) },
      ];
    }
  }

  // 跑满上限仍然在要工具：如实标记，让上层提示用户，而不是假装这一轮已经回答完。
  return { ...(model ? { model } : {}), messages: history, rounds, executedCalls, stoppedByRoundLimit: true };
}
