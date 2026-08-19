// packages/provider-sdk/src/router.ts —— 一个文件=一个作用：按任务类型/成本/能力选模型
import type { ModelDriver } from './driver';

export type TaskKind = 'research' | 'document' | 'code' | 'chat';

export class ModelRouter {
  constructor(private readonly drivers: ReadonlyMap<string, ModelDriver>) {}

  register(driver: ModelDriver): void {
    (this.drivers as Map<string, ModelDriver>).set(driver.id(), driver);
  }

  /** 简化策略：research→local/便宜；code→强模型；其余→第一个注册项。
   *  真实实现按 ModelCapability(成本/上下文/能力矩阵)打分。 */
  pick(kind: TaskKind): ModelDriver {
    if (kind === 'research') {
      return this.drivers.get('local') ?? this.first();
    }
    if (kind === 'code') {
      return this.drivers.get('openai') ?? this.first();
    }
    return this.first();
  }

  private first(): ModelDriver {
    const d = this.drivers.values().next();
    if (d.done) throw new Error('no provider registered');
    return d.value;
  }
}
