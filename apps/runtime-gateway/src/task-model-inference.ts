import type { ProviderConnectionService, ProviderInferenceService, SessionCustomProviderService } from '@awo/provider-sdk';
import type { TaskModelInferencePort } from './task-runtime-composition.js';

/**
 * 将 task/run 明确绑定到用户在 Workbench 选择的单个会话 Provider。
 * 未选择模型时不发出任何远程请求；地址、协议与凭据始终由 Gateway 内部 Provider 服务处理。
 */
export function createTaskModelInferencePort(
  connections: ProviderConnectionService,
  inference: ProviderInferenceService,
  customProviders: SessionCustomProviderService,
): TaskModelInferencePort {
  return {
    async infer({ goal, modelSelection }) {
      if (!modelSelection) return undefined;
      const model = modelSelection.model;
      if (modelSelection.providerId.startsWith('custom-')) {
        const selected = customProviders.list().find((connection) => connection.providerId === modelSelection.providerId);
        if (!selected || selected.profileStatus !== 'active' || selected.credentialAvailability !== 'available') {
          throw new Error('所选自定义模型不在当前 Gateway 会话中，或尚未可用；请重新连接并选择模型');
        }
        return customProviders.infer({ providerId: selected.providerId, model, prompt: goal });
      }
      const selected = connections.list().find((connection) => connection.providerId === modelSelection.providerId);
      if (!selected || selected.profileStatus !== 'active' || selected.credentialAvailability !== 'available') {
        throw new Error('所选模型尚未连接或未启用；请在 API 连接页重新测试并选择模型');
      }
      return inference.infer({ providerId: selected.providerId, model: model ?? selected.defaultModel, prompt: goal });
    },
  };
}
