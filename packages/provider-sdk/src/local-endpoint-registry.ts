import type { ModelCapabilities } from './driver.js';

export type LocalEndpointHealthStatus = 'unknown' | 'healthy' | 'unhealthy';
export type LocalEndpointProbeMethod = 'HEAD' | 'GET';

export interface LocalEndpointCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface LocalEndpointHealth {
  status: LocalEndpointHealthStatus;
  checkedAt?: number;
  probePath?: '/health' | '/v1/models';
  probeMethod?: LocalEndpointProbeMethod;
  /** 仅由 `/v1/models` 的只读响应导出；不是能力或权限声明。 */
  modelIds: readonly string[];
  error?: string;
}

/**
 * 已登记的本地模型端点。capabilities 与 contextWindow 均由操作者显式登记，不从服务响应猜测。
 * `offline` 是操作者开关，与上一次健康检查结果分离；两者任一不满足都会排除路由候选。
 */
export interface LocalModelEndpoint {
  schemaVersion: 1;
  id: string;
  baseUrl: string;
  modelId: string;
  capabilities: Readonly<LocalEndpointCapabilities>;
  contextWindow: number;
  offline: boolean;
  health: Readonly<LocalEndpointHealth>;
}

export interface RegisterLocalModelEndpoint {
  id: string;
  baseUrl: string;
  modelId: string;
  capabilities: LocalEndpointCapabilities;
  contextWindow: number;
  offline?: boolean;
}

export interface LocalEndpointAvailability {
  /** 与 LocalOpenAICompatible 的 driver id 对齐；仅健康、在线且健康记录未过期的端点可路由。 */
  isRoutable(driverId: string, at: number): boolean;
}

export type LocalEndpointFetch = (input: string, init: Readonly<{ method: LocalEndpointProbeMethod }>) => Promise<Response>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} 必须是 1-128 位安全标识符`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负安全整数`);
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('baseUrl 必须是有效的绝对 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('baseUrl 仅允许 http 或 https');
  if (!LOOPBACK_HOSTS.has(url.hostname.toLocaleLowerCase())) {
    throw new Error('baseUrl 仅允许 localhost、127.0.0.1 或 ::1 回环地址');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('baseUrl 不得携带身份信息、查询参数或片段');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname && pathname !== '/v1') throw new Error('baseUrl 仅允许根路径或 /v1 路径');
  url.pathname = '';
  return url.toString().replace(/\/$/, '');
}

function copyEndpoint(endpoint: LocalModelEndpoint): LocalModelEndpoint {
  return {
    ...endpoint,
    capabilities: { ...endpoint.capabilities },
    health: { ...endpoint.health, modelIds: [...endpoint.health.modelIds] },
  };
}

function defaultHealth(): LocalEndpointHealth {
  return { status: 'unknown', modelIds: [] };
}

function parseModelIds(payload: unknown): readonly string[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) return [];
  return (payload as { data: unknown[] }).data.flatMap((model) => {
    if (!model || typeof model !== 'object' || typeof (model as { id?: unknown }).id !== 'string') return [];
    const id = (model as { id: string }).id.trim();
    return id ? [id] : [];
  }).sort((left, right) => left.localeCompare(right));
}

async function probeRequest(
  fetcher: LocalEndpointFetch,
  url: string,
  path: '/health' | '/v1/models',
): Promise<{ response: Response; method: LocalEndpointProbeMethod }> {
  const head = await fetcher(`${url}${path}`, { method: 'HEAD' });
  if (head.status !== 405 && head.status !== 501) return { response: head, method: 'HEAD' };
  return { response: await fetcher(`${url}${path}`, { method: 'GET' }), method: 'GET' };
}

/**
 * 端点注册表不产生模型请求：probe 只使用 HEAD/GET 访问 `/health` 和 `/v1/models`。
 * 其目的仅是为 ModelRouter 提供可回放的健康/离线资格，而不是替代模型 adapter。
 */
export class LocalEndpointRegistry implements LocalEndpointAvailability {
  private readonly endpoints = new Map<string, LocalModelEndpoint>();

  constructor(
    private readonly healthTtlMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    assertNonNegativeInteger(healthTtlMs, 'healthTtlMs');
  }

  register(input: RegisterLocalModelEndpoint): LocalModelEndpoint {
    assertIdentifier(input.id, 'id');
    assertIdentifier(input.modelId, 'modelId');
    assertNonNegativeInteger(input.contextWindow, 'contextWindow');
    if (input.contextWindow === 0) throw new Error('contextWindow 必须大于 0');
    const endpoint: LocalModelEndpoint = {
      schemaVersion: 1,
      id: input.id,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      modelId: input.modelId,
      capabilities: { ...input.capabilities },
      contextWindow: input.contextWindow,
      offline: input.offline ?? false,
      health: defaultHealth(),
    };
    if (this.endpoints.has(endpoint.id)) throw new Error(`本地端点 ${endpoint.id} 已存在；请先显式删除或更新`);
    this.endpoints.set(endpoint.id, endpoint);
    return copyEndpoint(endpoint);
  }

  replace(input: RegisterLocalModelEndpoint): LocalModelEndpoint {
    this.endpoints.delete(input.id);
    return this.register(input);
  }

  remove(id: string): boolean {
    assertIdentifier(id, 'id');
    return this.endpoints.delete(id);
  }

  get(id: string): LocalModelEndpoint | undefined {
    assertIdentifier(id, 'id');
    const endpoint = this.endpoints.get(id);
    return endpoint ? copyEndpoint(endpoint) : undefined;
  }

  list(): readonly LocalModelEndpoint[] {
    return [...this.endpoints.values()].map(copyEndpoint).sort((left, right) => left.id.localeCompare(right.id));
  }

  setOffline(id: string, offline: boolean): LocalModelEndpoint {
    const endpoint = this.require(id);
    endpoint.offline = offline;
    return copyEndpoint(endpoint);
  }

  capabilitiesFor(id: string): ModelCapabilities {
    const endpoint = this.require(id);
    return {
      contextWindow: endpoint.contextWindow,
      supportsTools: endpoint.capabilities.supportsTools,
      supportsVision: endpoint.capabilities.supportsVision,
      isLocal: true,
      costTier: 'low',
    };
  }

  isRoutable(driverId: string, at: number): boolean {
    const endpoint = this.endpoints.get(driverId);
    if (!endpoint || endpoint.offline || endpoint.health.status !== 'healthy' || endpoint.health.checkedAt === undefined) return false;
    return at >= endpoint.health.checkedAt && at - endpoint.health.checkedAt <= this.healthTtlMs;
  }

  async probe(id: string, fetcher: LocalEndpointFetch = (input, init) => fetch(input, init), at = this.now()): Promise<LocalModelEndpoint> {
    assertNonNegativeInteger(at, 'at');
    const endpoint = this.require(id);
    if (endpoint.offline) return copyEndpoint(endpoint);
    const paths: readonly ('/health' | '/v1/models')[] = ['/health', '/v1/models'];
    let lastError = 'endpoint did not return a successful health or model-list response';
    for (const path of paths) {
      try {
        const { response, method } = await probeRequest(fetcher, endpoint.baseUrl, path);
        if (!response.ok) {
          lastError = `http ${response.status} for ${path}`;
          continue;
        }
        let modelIds: readonly string[] = [];
        if (path === '/v1/models' && method === 'GET') {
          try {
            modelIds = parseModelIds(await response.json());
          } catch {
            // 列表解析失败不掩盖成功的 HTTP 健康状态；仅不登记模型名。
          }
        }
        endpoint.health = { status: 'healthy', checkedAt: at, probePath: path, probeMethod: method, modelIds };
        return copyEndpoint(endpoint);
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'endpoint probe failed';
      }
    }
    endpoint.health = { status: 'unhealthy', checkedAt: at, modelIds: [], error: lastError };
    return copyEndpoint(endpoint);
  }

  private require(id: string): LocalModelEndpoint {
    assertIdentifier(id, 'id');
    const endpoint = this.endpoints.get(id);
    if (!endpoint) throw new Error(`本地端点 ${id} 不存在`);
    return endpoint;
  }
}
