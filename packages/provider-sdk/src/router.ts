// 一个文件=一种作用：模型选择策略；不发起模型请求、不保存密钥、不处理 UI。
import type { ModelCapabilities, ModelDriver } from './driver.js';
import type { LocalEndpointAvailability } from './local-endpoint-registry.js';

export type TaskKind = 'research' | 'document' | 'code' | 'chat';
export type DataBoundary = 'local-preferred' | 'local-only' | 'remote-allowed';

export interface ModelRouteRequest {
  kind: TaskKind;
  minContextTokens?: number;
  needsTools?: boolean;
  needsVision?: boolean;
  dataBoundary?: DataBoundary;
  /** 将健康判定绑定到调用时刻，方便测试与任务回放。 */
  at?: number;
}

export interface ModelRouteCandidate {
  driverId: string;
  score: number;
  capabilities: ModelCapabilities;
}

export interface ModelRouteDecision {
  driver: ModelDriver;
  reason: string;
  candidates: readonly ModelRouteCandidate[];
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 8_192,
  supportsTools: false,
  supportsVision: false,
  isLocal: false,
  costTier: 'medium',
};

const COST_SCORE = { low: 15, medium: 6, high: 0 } as const;

function requirementsFor(kind: TaskKind): Required<Pick<ModelRouteRequest, 'needsTools' | 'needsVision' | 'minContextTokens'>> {
  switch (kind) {
    case 'code':
      return { needsTools: true, needsVision: false, minContextTokens: 16_384 };
    case 'document':
      return { needsTools: false, needsVision: false, minContextTokens: 12_000 };
    case 'research':
      return { needsTools: false, needsVision: false, minContextTokens: 8_000 };
    case 'chat':
      return { needsTools: false, needsVision: false, minContextTokens: 4_096 };
  }
}

/**
 * MiMo-Code / OpenCode / 本地客户端的共同工程原则：将模型能力、成本与数据边界放在路由层，
 * 而不是散落在 UI 或各个 provider adapter 中。候选按 `score desc, driverId asc` 稳定排序。
 */
export class ModelRouter {
  constructor(
    private readonly drivers: Map<string, ModelDriver> = new Map(),
    private readonly localEndpointAvailability?: LocalEndpointAvailability,
    private readonly now: () => number = () => Date.now(),
  ) {}

  register(driver: ModelDriver): void {
    this.drivers.set(driver.id(), driver);
  }

  /** 兼容早期调用方；新调用方应使用 `decide` 获取可审计的选择理由。 */
  pick(kind: TaskKind): ModelDriver {
    return this.decide({ kind, dataBoundary: kind === 'research' ? 'local-preferred' : 'remote-allowed' }).driver;
  }

  decide(request: ModelRouteRequest): ModelRouteDecision {
    const defaults = requirementsFor(request.kind);
    const minContextTokens = request.minContextTokens ?? defaults.minContextTokens;
    const needsTools = request.needsTools ?? defaults.needsTools;
    const needsVision = request.needsVision ?? defaults.needsVision;
    const dataBoundary = request.dataBoundary ?? 'remote-allowed';
    const routeAt = request.at ?? this.now();
    if (!Number.isSafeInteger(routeAt) || routeAt < 0) throw new Error('route at 必须是非负安全整数');
    const candidates: Array<ModelRouteCandidate & { driver: ModelDriver }> = [];

    for (const driver of this.drivers.values()) {
      const capabilities = { ...DEFAULT_CAPABILITIES, ...driver.capabilities?.() };
      if (capabilities.contextWindow < minContextTokens) continue;
      if (needsTools && !capabilities.supportsTools) continue;
      if (needsVision && !capabilities.supportsVision) continue;
      if (dataBoundary === 'local-only' && !capabilities.isLocal) continue;
      if (capabilities.isLocal && this.localEndpointAvailability && !this.localEndpointAvailability.isRoutable(driver.id(), routeAt)) {
        continue;
      }

      let score = COST_SCORE[capabilities.costTier];
      if (capabilities.isLocal) score += dataBoundary === 'local-preferred' ? 40 : 12;
      if (capabilities.contextWindow >= minContextTokens * 2) score += 5;
      if (needsTools && capabilities.supportsTools) score += 8;
      if (needsVision && capabilities.supportsVision) score += 8;
      if (request.kind === 'code' && capabilities.supportsTools) score += 10;
      candidates.push({ driver, driverId: driver.id(), score, capabilities });
    }

    candidates.sort((left, right) => right.score - left.score || left.driverId.localeCompare(right.driverId));
    const selected = candidates[0];
    if (!selected) {
      throw new Error(`no model satisfies ${request.kind} route: boundary=${dataBoundary}, context=${minContextTokens}`);
    }
    const reason = [
      `${selected.driverId} 得分 ${selected.score}`,
      selected.capabilities.isLocal
        ? this.localEndpointAvailability ? '本地端点健康且受控' : '本地优先'
        : '远程受控',
      `上下文 ${selected.capabilities.contextWindow}`,
      `成本 ${selected.capabilities.costTier}`,
    ].join(' · ');
    return {
      driver: selected.driver,
      reason,
      candidates: candidates.map(({ driver: _driver, ...candidate }) => candidate),
    };
  }
}
