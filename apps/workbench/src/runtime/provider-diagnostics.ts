import { loadDirectProviderAccounts } from './direct-provider-accounts';
import type { DirectProviderProtocol } from './direct-provider-client';

export type ProviderDiagnosticStage = 'configured' | 'probe' | 'stream-test' | 'chat';
export type ProviderDiagnosticOutcome = 'succeeded' | 'failed';

export interface ProviderDiagnosticEntry {
  readonly schemaVersion: 1;
  readonly at: number;
  readonly elapsedMs: number;
  readonly firstByteMs?: number;
  readonly providerId: string;
  readonly displayName: string;
  readonly protocol: DirectProviderProtocol | 'unknown';
  readonly baseUrl: string;
  readonly model: string;
  readonly stage: ProviderDiagnosticStage;
  readonly outcome: ProviderDiagnosticOutcome;
  readonly errorCode?: string;
  readonly includedImages: boolean;
  readonly sharedNativeSession: true;
}

export interface SearxngDiagnosticStatus {
  readonly schemaVersion: 1;
  readonly state: 'not-started' | 'running';
  readonly port?: number;
  readonly startupTimeoutSeconds: number;
  readonly requestTimeoutSeconds: number;
}

const MAX_ENTRIES = 32;
let entries: readonly ProviderDiagnosticEntry[] = [];
const listeners = new Set<() => void>();

function safeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return '无效 Base URL';
  }
}

function errorCode(value: unknown): string | undefined {
  const text = value instanceof Error ? value.message : String(value ?? '');
  const match = text.match(/\b(provider|api-key|base-url|model|messages|message-images)-[a-z0-9-]+\b/i);
  return match?.[0].toLowerCase();
}

function accountFor(providerId: string) {
  return loadDirectProviderAccounts().find((account) => account.providerId === providerId);
}

export function recordProviderDiagnostic(input: Readonly<{
  providerId: string;
  model?: string;
  stage: ProviderDiagnosticStage;
  outcome: ProviderDiagnosticOutcome;
  startedAt: number;
  firstByteAt?: number;
  error?: unknown;
  includedImages?: boolean;
}>): void {
  const account = accountFor(input.providerId);
  const entry: ProviderDiagnosticEntry = {
    schemaVersion: 1,
    at: Date.now(),
    elapsedMs: Math.max(0, Date.now() - input.startedAt),
    ...(input.firstByteAt === undefined ? {} : { firstByteMs: Math.max(0, input.firstByteAt - input.startedAt) }),
    providerId: input.providerId,
    displayName: account?.displayName ?? input.providerId,
    protocol: account?.protocol ?? 'unknown',
    baseUrl: safeBaseUrl(account?.baseUrl ?? ''),
    model: input.model?.trim() || account?.model || '未记录模型',
    stage: input.stage,
    outcome: input.outcome,
    ...(input.outcome === 'failed' && errorCode(input.error) ? { errorCode: errorCode(input.error) } : {}),
    includedImages: Boolean(input.includedImages),
    sharedNativeSession: true,
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  listeners.forEach((listener) => listener());
}

export function providerDiagnosticEntries(): readonly ProviderDiagnosticEntry[] {
  return entries;
}

export function subscribeProviderDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function providerDiagnosticReport(input: Readonly<{
  desktopVersion?: string;
  sourceRevision?: string;
  providerEntries: readonly ProviderDiagnosticEntry[];
  searxng?: SearxngDiagnosticStatus;
  workspaceSelected?: boolean;
}>): string {
  const lines = [
    'AI Work OS 本地诊断报告',
    `生成时间：${new Date().toISOString()}`,
    `桌面版本：${input.desktopVersion ?? '未知'}`,
    `来源提交：${input.sourceRevision ?? '未嵌入'}`,
    `工作区：${input.workspaceSelected ? '已选择' : '未选择'}`,
    '会话存储：当前 Windows WebView 的本地会话账本；本报告不导出聊天正文。',
  ];
  if (input.searxng) lines.push(`本地 SearXNG：${input.searxng.state}${input.searxng.port ? `（127.0.0.1:${input.searxng.port}）` : ''}；启动预算 ${input.searxng.startupTimeoutSeconds}s；请求预算 ${input.searxng.requestTimeoutSeconds}s。`);
  else lines.push('本地 SearXNG：状态未读取。');
  lines.push('', 'Provider 最近操作（不包含 API key、提示词、回复或图片数据）：');
  if (input.providerEntries.length === 0) lines.push('- 暂无本会话诊断记录。');
  for (const entry of input.providerEntries) {
    lines.push(`- ${new Date(entry.at).toISOString()} | ${entry.displayName} | ${entry.protocol} | ${entry.baseUrl} | ${entry.model} | ${entry.stage} | ${entry.outcome}${entry.errorCode ? ` | ${entry.errorCode}` : ''}${entry.includedImages ? ' | 含图片' : ''}${entry.firstByteMs === undefined ? '' : ` | 首 token ${entry.firstByteMs}ms`} | 总计 ${entry.elapsedMs}ms | 同一原生会话=${entry.sharedNativeSession ? '是' : '否'}`);
  }
  return lines.join('\n');
}

export function resetProviderDiagnosticsForTest(): void {
  entries = [];
}
