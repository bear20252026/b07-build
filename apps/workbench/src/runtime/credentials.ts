import { invoke } from '@tauri-apps/api/core';

/**
 * SEC-006/007：密钥/令牌统一走操作系统凭据管理器（Windows Credential Manager）。
 *
 * 桌面端经 Tauri invoke 调用原生 `credential_store/load/delete`；WebView 里不再
 * 存明文。非 Tauri 环境（单测、纯浏览器预览）下返回 undefined/空操作，调用方
 * 按没有已保存凭据处理，不抛错——绝不能因为凭据读不到而阻塞 UI。
 */

export const CREDENTIAL_SERVICE_HINT = 'awo-desktop-shell';

/** account 形如 `provider/<providerId>`、`provider/custom`、`github/token`。 */
export type CredentialAccount = string;

function nativeRuntime(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export async function storeCredential(account: CredentialAccount, secret: string): Promise<void> {
  if (!nativeRuntime()) return;
  await invoke('credential_store', { account, secret });
}

export async function loadCredential(account: CredentialAccount): Promise<string | undefined> {
  if (!nativeRuntime()) return undefined;
  try {
    return await invoke<string | null>('credential_load', { account }) ?? undefined;
  } catch {
    // 凭据管理器不可用（策略限制、DPPCA 异常等）按"没有保存过"处理，
    // 用户重新输入一次即可；不要把错误抛进启动路径。
    return undefined;
  }
}

export async function deleteCredential(account: CredentialAccount): Promise<void> {
  if (!nativeRuntime()) return;
  await invoke('credential_delete', { account }).catch(() => undefined);
}

/**
 * 一次性迁移：localStorage 时代的明文密钥搬进凭据管理器。
 * 返回 true 表示存在旧明文并已完成迁移（调用方随后应清掉 localStorage 条目）。
 */
export async function migratePlaintextSecret(account: CredentialAccount, legacy: string): Promise<boolean> {
  if (!legacy) return false;
  await storeCredential(account, legacy);
  return true;
}
