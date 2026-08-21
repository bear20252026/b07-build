export interface WorkbenchApiUsageModelSummary {
  readonly providerId: string;
  readonly model: string;
  readonly callCount: number;
  readonly totalLatencyMs: number;
  readonly totalOutputCharacters: number;
  readonly tokenStatus: 'not-reported';
}

export interface WorkbenchApiUsageSummary {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly totalCalls: number;
  readonly totalLatencyMs: number;
  readonly totalOutputCharacters: number;
  readonly tokenStatus: 'not-reported';
  readonly latestRecordedAt?: number;
  readonly models: readonly WorkbenchApiUsageModelSummary[];
}

export interface WorkbenchApiUsageReceipt {
  readonly schemaVersion: 1;
  readonly usageId: string;
  readonly recordedAt: number;
  readonly providerId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly model: string;
  readonly dataBoundary: 'remote-allowed';
  readonly latencyMs: number;
  readonly outputCharacters: number;
  readonly tokenStatus: 'not-reported';
  readonly canReadSecret: false;
  readonly containsPrompt: false;
  readonly containsOutput: false;
  readonly containsEndpoint: false;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 响应格式无效`);
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

function model(value: unknown): WorkbenchApiUsageModelSummary {
  const item = object(value, '模型用量');
  if (typeof item.providerId !== 'string' || typeof item.model !== 'string' || !safeInteger(item.callCount) || !safeInteger(item.totalLatencyMs) || !safeInteger(item.totalOutputCharacters) || item.tokenStatus !== 'not-reported') throw new Error('模型用量字段无效');
  return { providerId: item.providerId, model: item.model, callCount: item.callCount, totalLatencyMs: item.totalLatencyMs, totalOutputCharacters: item.totalOutputCharacters, tokenStatus: 'not-reported' };
}

function summary(value: unknown): WorkbenchApiUsageSummary {
  const item = object(value, 'API 使用摘要');
  if (item.schemaVersion !== 1 || !safeInteger(item.generatedAt) || !safeInteger(item.totalCalls) || !safeInteger(item.totalLatencyMs) || !safeInteger(item.totalOutputCharacters) || item.tokenStatus !== 'not-reported' || !Array.isArray(item.models) || (item.latestRecordedAt !== undefined && !safeInteger(item.latestRecordedAt))) throw new Error('API 使用摘要字段无效');
  return { schemaVersion: 1, generatedAt: item.generatedAt, totalCalls: item.totalCalls, totalLatencyMs: item.totalLatencyMs, totalOutputCharacters: item.totalOutputCharacters, tokenStatus: 'not-reported', latestRecordedAt: item.latestRecordedAt as number | undefined, models: item.models.map(model) };
}

function receipt(value: unknown): WorkbenchApiUsageReceipt {
  const item = object(value, 'API 使用收据');
  if (item.schemaVersion !== 1 || typeof item.usageId !== 'string' || !safeInteger(item.recordedAt) || typeof item.providerId !== 'string' || typeof item.profileId !== 'string' || !safeInteger(item.profileRevision) || typeof item.model !== 'string' || item.dataBoundary !== 'remote-allowed' || !safeInteger(item.latencyMs) || !safeInteger(item.outputCharacters) || item.tokenStatus !== 'not-reported' || item.canReadSecret !== false || item.containsPrompt !== false || item.containsOutput !== false || item.containsEndpoint !== false) throw new Error('API 使用收据字段无效');
  return {
    schemaVersion: 1, usageId: item.usageId, recordedAt: item.recordedAt, providerId: item.providerId, profileId: item.profileId,
    profileRevision: item.profileRevision, model: item.model, dataBoundary: 'remote-allowed', latencyMs: item.latencyMs,
    outputCharacters: item.outputCharacters, tokenStatus: 'not-reported', canReadSecret: false, containsPrompt: false,
    containsOutput: false, containsEndpoint: false,
  };
}

async function get(url: string): Promise<unknown> {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = object(body, 'API 使用 Gateway');
    throw new Error(typeof error.error === 'string' ? error.error : '无法读取 API 使用记录');
  }
  return body;
}

/** Workbench 只消费本机只读计量投影；没有价格刷新、账单查询或 Provider 调用方法。 */
export class HttpApiUsageClient {
  constructor(private readonly baseUrl = 'http://127.0.0.1:4318') {}
  async summary(limit = 500): Promise<WorkbenchApiUsageSummary> { return summary(await get(`${this.baseUrl}/api/usage/summary?limit=${limit}`)); }
  async receipts(limit = 100): Promise<readonly WorkbenchApiUsageReceipt[]> {
    const body = await get(`${this.baseUrl}/api/usage/receipts?limit=${limit}`);
    if (!Array.isArray(body)) throw new Error('API 使用收据列表格式无效');
    return body.map(receipt);
  }
}
