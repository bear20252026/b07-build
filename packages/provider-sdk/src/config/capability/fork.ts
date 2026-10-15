// 一个文件=一种作用：provider「会话分支 fork」能力面契约（纯类型，零 IO）。

/** fork 请求：把一段转写复制成全新的、可续跑的 provider 会话。 */
export interface ProviderForkInput {
  /** 源会话的 provider 原生 id。 */
  readonly providerSessionId: string;
  /** 会话所属工作目录；provider 以此界定会话查找范围。 */
  readonly projectPath: string;
  /** 复制到该锚点（含）为止；缺席表示整段复制。 */
  readonly upToAnchorId?: string;
  readonly title?: string;
}

export interface ProviderForkResult {
  /** 新生成的 provider 原生会话 id。 */
  readonly providerSessionId: string;
}

/**
 * 会话分支能力面。
 * 只有「能把一段对话前缀物化成独立可续跑会话」的 provider 才提供这个面；
 * 该面整体缺席，就是「fork 会话」不可用的原因。
 */
export interface ProviderForkFacet {
  forkSession(input: ProviderForkInput): Promise<ProviderForkResult>;
}
