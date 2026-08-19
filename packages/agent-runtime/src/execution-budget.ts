// 一个文件=一种作用：执行预算与重复工具调用防护（不执行工具、不处理权限）。

export interface ExecutionAttempt {
  runId: string;
  toolName: string;
  inputHash: string;
}

export interface ExecutionBudgetOptions {
  /** 一个 run 最多可真正执行的工具调用数。 */
  maxToolCalls: number;
  /** 同一 toolName + inputHash 在一个 run 中最多可执行的次数。 */
  maxIdenticalCalls: number;
}

export type ExecutionBudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: 'STEP_BUDGET_EXCEEDED' | 'REPEATED_TOOL_CALL';
      reason: string;
    };

export interface ExecutionBudget {
  tryConsume(attempt: ExecutionAttempt): ExecutionBudgetDecision;
}

interface RunUsage {
  toolCalls: number;
  fingerprints: Map<string, number>;
}

const DEFAULT_OPTIONS: ExecutionBudgetOptions = {
  maxToolCalls: 40,
  maxIdenticalCalls: 2,
};

function validateOptions(options: ExecutionBudgetOptions): void {
  if (!Number.isInteger(options.maxToolCalls) || options.maxToolCalls < 1) {
    throw new Error('maxToolCalls 必须是正整数');
  }
  if (!Number.isInteger(options.maxIdenticalCalls) || options.maxIdenticalCalls < 1) {
    throw new Error('maxIdenticalCalls 必须是正整数');
  }
}

/**
 * 每个 run 独立累计，避免一个任务的长步骤或循环记录影响另一个任务。
 * 只有在策略和审批都允许之后，调用方才应消费预算。
 */
export class InMemoryExecutionBudget implements ExecutionBudget {
  private readonly usageByRun = new Map<string, RunUsage>();
  private readonly options: ExecutionBudgetOptions;

  constructor(options: Partial<ExecutionBudgetOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    validateOptions(this.options);
  }

  tryConsume(attempt: ExecutionAttempt): ExecutionBudgetDecision {
    const usage = this.usageByRun.get(attempt.runId) ?? {
      toolCalls: 0,
      fingerprints: new Map<string, number>(),
    };
    const fingerprint = `${attempt.toolName}:${attempt.inputHash}`;
    const identicalCalls = usage.fingerprints.get(fingerprint) ?? 0;

    if (usage.toolCalls >= this.options.maxToolCalls) {
      return {
        allowed: false,
        code: 'STEP_BUDGET_EXCEEDED',
        reason: `执行预算已耗尽：run ${attempt.runId} 最多允许 ${this.options.maxToolCalls} 次工具调用`,
      };
    }
    if (identicalCalls >= this.options.maxIdenticalCalls) {
      return {
        allowed: false,
        code: 'REPEATED_TOOL_CALL',
        reason: `重复调用已阻断：${attempt.toolName} 使用相同输入最多允许 ${this.options.maxIdenticalCalls} 次`,
      };
    }

    usage.toolCalls += 1;
    usage.fingerprints.set(fingerprint, identicalCalls + 1);
    this.usageByRun.set(attempt.runId, usage);
    return { allowed: true };
  }
}
