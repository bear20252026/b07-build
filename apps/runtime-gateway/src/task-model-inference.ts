import type { ProviderConnectionService, ProviderInferenceService } from '@awo/provider-sdk';
import type { TaskModelInferencePort } from './task-runtime-composition.js';

/**
 * 将已激活的内置 Provider 作为 task/run 的唯一模型端口。
 * 连接、密钥、地址与协议仍由 Provider 服务在 Gateway 内部处理；任务 runner 只取得受限文本输出。
 */
export function createTaskModelInferencePort(
  connections: ProviderConnectionService,
  inference: ProviderInferenceService,
): TaskModelInferencePort {
  return {
    async infer({ goal }) {
      const active = connections.list()
        .filter((connection) => connection.profileStatus === 'active' && connection.credentialAvailability === 'available')
        .sort((left, right) => left.providerId.localeCompare(right.providerId));
      if (active.length === 0) return undefined;
      if (active.length > 1) throw new Error('已连接多个模型；请先在模型设置中只保留一个活动内置连接再开始任务');
      const connection = active[0]!;
      return inference.infer({ providerId: connection.providerId, model: connection.defaultModel, prompt: goal });
    },
  };
}
