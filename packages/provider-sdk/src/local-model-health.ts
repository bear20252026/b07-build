import { LocalEndpointRegistry, type LocalEndpointHealth } from './local-endpoint-registry';

/**
 * 工作台可读取的本地模型健康摘要。它刻意不暴露 baseUrl、凭据引用、能力策略或执行入口。
 */
export interface LocalModelHealthSummaryV1 {
  schemaVersion: 1;
  id: string;
  configuredModelId: string;
  offline: boolean;
  health: Readonly<LocalEndpointHealth>;
}

/**
 * P3 的本地模型健康控制面。
 *
 * 复用 LocalEndpointRegistry 的回环地址验证、HEAD/GET 只读探测和 TTL 路由资格；
 * 此处仅增加面向产品层的脱敏 health view，不注册 Provider Profile、不持有 secret、也不自动 probe。
 */
export class LocalModelHealthRegistry extends LocalEndpointRegistry {
  listHealth(): readonly LocalModelHealthSummaryV1[] {
    return this.list().map((endpoint) => ({
      schemaVersion: 1,
      id: endpoint.id,
      configuredModelId: endpoint.modelId,
      offline: endpoint.offline,
      health: { ...endpoint.health, modelIds: [...endpoint.health.modelIds] },
    }));
  }
}
