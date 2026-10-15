// 一个文件=一种作用：provider「凭据 / 认证状态」能力面契约（纯类型，零 IO）。
// 只描述「能被问及认证状态」这一件事，不承载任何凭据本体。

/** 认证状态三态。`unconfigured` 与 `unauthenticated` 分开，便于区分「没填」与「填了但没通过」。 */
export type ProviderAuthState = 'authenticated' | 'unauthenticated' | 'unconfigured';

export interface ProviderAuthStatus {
  readonly state: ProviderAuthState;
  /** 可公开展示的账号标签（如掩码后的地址）；不得包含凭据本体。 */
  readonly accountLabel?: string;
}

/**
 * 凭据 / 认证状态能力面。
 * 约定：正常的「未配置」「未登录」是状态而非错误，实现不应抛异常。
 */
export interface ProviderAuthFacet {
  /** 读取安装 / 凭据状态。 */
  getStatus(): Promise<ProviderAuthStatus>;
}
