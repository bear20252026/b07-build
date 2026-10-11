import type { DirectProviderProtocol } from './direct-provider-client';
import { loadCredential, storeCredential } from './credentials';

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

export interface DirectProviderAccountMetadata extends Omit<DirectProviderAccount, 'apiKey'> {
  readonly apiKey?: string;
  readonly credential?: 'keyring';
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

interface SecretStore {
  store(account: string, secret: string): Promise<void>;
  load(account: string): Promise<string | undefined>;
}

const defaultSecrets: SecretStore = {
  store: (account, secret) => storeCredential(account, secret),
  load: (account) => loadCredential(account),
};

const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function isProtocol(value: unknown): value is DirectProviderProtocol {
  return value === 'openai-compatible' || value === 'anthropic-compatible';
}

/** SEC-006：apiKey 本体只进系统凭据管理器；localStorage 只留元数据 + keyring 标记。 */
export function providerCredentialAccount(providerId: string): string {
  return `provider/${providerId}`;
}

function parseMetadata(value: unknown): DirectProviderAccountMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || typeof candidate.providerId !== 'string' || !providerIdPattern.test(candidate.providerId)
    || typeof candidate.displayName !== 'string' || !candidate.displayName.trim() || candidate.displayName.length > 80
    || !isProtocol(candidate.protocol) || typeof candidate.baseUrl !== 'string' || !candidate.baseUrl.trim() || candidate.baseUrl.length > 512
    || typeof candidate.model !== 'string' || !modelPattern.test(candidate.model)) return undefined;
  const legacyKey = typeof candidate.apiKey === 'string' ? candidate.apiKey : '';
  const keyringFlag = candidate.credential === 'keyring';
  // 新格式：credential === 'keyring'，apiKey 为空；旧格式：带明文 apiKey（只用于迁移）。
  if (!keyringFlag && !legacyKey.trim()) return undefined;
  if (legacyKey.length > 4096) return undefined;
  return {
    schemaVersion: 1,
    providerId: candidate.providerId,
    displayName: candidate.displayName.trim(),
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl.trim(),
    model: candidate.model,
    ...(keyringFlag ? { credential: 'keyring' as const } : { apiKey: legacyKey }),
  };
}

function parseAccount(metadata: DirectProviderAccountMetadata, apiKey: string): DirectProviderAccount {
  return {
    schemaVersion: 1,
    providerId: metadata.providerId,
    displayName: metadata.displayName,
    protocol: metadata.protocol,
    baseUrl: metadata.baseUrl,
    model: metadata.model,
    apiKey,
  };
}

function localStorageOrUndefined(): StorageLike | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

function loadMetadata(storage: StorageLike): readonly DirectProviderAccountMetadata[] {
  try {
    const raw: unknown = JSON.parse(storage.getItem(DIRECT_PROVIDER_ACCOUNTS_STORAGE) ?? '[]');
    if (!Array.isArray(raw)) return [];
    const accounts = raw.map(parseMetadata).filter((account): account is DirectProviderAccountMetadata => Boolean(account));
    return accounts.filter((account, index) => accounts.findIndex((candidate) => candidate.providerId === account.providerId) === index).slice(0, 32);
  } catch { return []; }
}

/** 同步读取账户元数据（apiKey 一律为空串）；诊断面板等只关心元数据的调用方使用。 */
export function loadDirectProviderAccounts(storage: StorageLike | undefined = localStorageOrUndefined()): readonly DirectProviderAccount[] {
  if (!storage) return [];
  return loadMetadata(storage).map((metadata) => parseAccount(metadata, ''));
}

/** 旧版明文记录一次性搬进凭据管理器，然后把 localStorage 重写为纯元数据。 */
async function migrateLegacyPlaintextAccounts(storage: StorageLike, secrets: SecretStore): Promise<void> {
  const records = loadMetadata(storage);
  const legacy = records.filter((record) => record.apiKey);
  if (legacy.length === 0) return;
  for (const record of legacy) {
    await secrets.store(providerCredentialAccount(record.providerId), record.apiKey ?? '');
  }
  storage.setItem(DIRECT_PROVIDER_ACCOUNTS_STORAGE, JSON.stringify(
    records.map(({ apiKey: _apiKey, ...metadata }) => ({ ...metadata, credential: 'keyring' as const })),
  ));
}

/**
 * 恢复已保存的账户：先迁移旧明文，再从凭据管理器取回每个账户的 apiKey。
 * 凭据缺失（用户清过凭据管理器）时返回 apiKey 为空的记录——调用方按需重新连接。
 */
export async function restoreDirectProviderAccounts(
  storage: StorageLike | undefined = localStorageOrUndefined(),
  secrets: SecretStore = defaultSecrets,
): Promise<readonly DirectProviderAccount[]> {
  if (!storage) return [];
  await migrateLegacyPlaintextAccounts(storage, secrets);
  return Promise.all(loadMetadata(storage).map(async (metadata) => {
    const secret = await secrets.load(providerCredentialAccount(metadata.providerId));
    return parseAccount(metadata, secret ?? '');
  }));
}

/** 保存账户：密钥写入系统凭据管理器，localStorage 只落元数据（不含 apiKey）。 */
export async function saveDirectProviderAccount(
  account: DirectProviderAccount,
  storage: StorageLike | undefined = localStorageOrUndefined(),
  secrets: SecretStore = defaultSecrets,
): Promise<void> {
  if (!storage) return;
  const candidate = parseMetadata({ ...account, credential: 'keyring' });
  if (!candidate || !account.apiKey.trim()) return;
  // 先把可能存在的旧明文记录迁走，避免下面重写 localStorage 时把明文 key 直接抹掉。
  await migrateLegacyPlaintextAccounts(storage, secrets);
  await secrets.store(providerCredentialAccount(candidate.providerId), account.apiKey);
  const { apiKey: _apiKey, ...metadata } = candidate;
  const existing = loadMetadata(storage)
    .filter((record) => record.providerId !== candidate.providerId)
    .map(({ apiKey: _legacy, ...rest }) => ({ ...rest, credential: 'keyring' as const }));
  storage.setItem(DIRECT_PROVIDER_ACCOUNTS_STORAGE, JSON.stringify([...existing, metadata].slice(-32)));
}
