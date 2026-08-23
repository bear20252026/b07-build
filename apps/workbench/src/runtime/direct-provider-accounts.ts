import type { DirectProviderProtocol } from './direct-provider-client';

export const DIRECT_PROVIDER_ACCOUNTS_STORAGE = 'awo.direct-provider-accounts.v1';

export interface DirectProviderAccount {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly displayName: string;
  readonly protocol: DirectProviderProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function isProtocol(value: unknown): value is DirectProviderProtocol {
  return value === 'openai-compatible' || value === 'anthropic-compatible';
}

function parseAccount(value: unknown): DirectProviderAccount | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || typeof candidate.providerId !== 'string' || !providerIdPattern.test(candidate.providerId)
    || typeof candidate.displayName !== 'string' || !candidate.displayName.trim() || candidate.displayName.length > 80
    || !isProtocol(candidate.protocol) || typeof candidate.baseUrl !== 'string' || !candidate.baseUrl.trim() || candidate.baseUrl.length > 512
    || typeof candidate.model !== 'string' || !modelPattern.test(candidate.model)
    || typeof candidate.apiKey !== 'string' || !candidate.apiKey.trim() || candidate.apiKey.length > 4096) return undefined;
  return {
    schemaVersion: 1,
    providerId: candidate.providerId,
    displayName: candidate.displayName.trim(),
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl.trim(),
    model: candidate.model,
    apiKey: candidate.apiKey,
  };
}

function localStorageOrUndefined(): StorageLike | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

/** 账户配置仅在当前 Windows 用户的 localStorage 中保存；用于重建原生内存会话，不会写入聊天或诊断数据。 */
export function loadDirectProviderAccounts(storage: StorageLike | undefined = localStorageOrUndefined()): readonly DirectProviderAccount[] {
  if (!storage) return [];
  try {
    const raw: unknown = JSON.parse(storage.getItem(DIRECT_PROVIDER_ACCOUNTS_STORAGE) ?? '[]');
    if (!Array.isArray(raw)) return [];
    const accounts = raw.map(parseAccount).filter((account): account is DirectProviderAccount => Boolean(account));
    return accounts.filter((account, index) => accounts.findIndex((candidate) => candidate.providerId === account.providerId) === index).slice(0, 32);
  } catch { return []; }
}

export function saveDirectProviderAccount(account: DirectProviderAccount, storage: StorageLike | undefined = localStorageOrUndefined()): void {
  if (!storage) return;
  const next = parseAccount(account);
  if (!next) return;
  const existing = loadDirectProviderAccounts(storage).filter((candidate) => candidate.providerId !== next.providerId);
  storage.setItem(DIRECT_PROVIDER_ACCOUNTS_STORAGE, JSON.stringify([...existing, next].slice(-32)));
}
