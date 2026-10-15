// 一个文件=一种作用：provider「会话列表 / 历史」能力面契约（纯类型，零 IO）。

/** 一条会话摘要。 */
export interface ProviderSessionSummary {
  readonly sessionId: string;
  readonly title?: string;
  /** 最近更新时间的毫秒时间戳；缺席表示 provider 不提供该信息。 */
  readonly updatedAt?: number;
}

/** 归一化后的一条历史消息。 */
export interface ProviderHistoryMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly text: string;
  readonly at?: number;
}

export interface ProviderSessionHistory {
  readonly sessionId: string;
  readonly messages: readonly ProviderHistoryMessage[];
}

/** 编辑锚点的解析结果：`resumeThroughId` 是「保留到哪一行」，`null` 表示从头开始。 */
export interface ProviderEditAnchorResolution {
  readonly found: boolean;
  readonly resumeThroughId: string | null;
}

/**
 * 会话列表 / 历史能力面。
 * 只声明「会话可被枚举、历史可被读取」，不声明存储位置。
 */
export interface ProviderSessionsFacet {
  /** 列出该 provider 已知的会话。 */
  listSessions(): Promise<readonly ProviderSessionSummary[]>;
  /** 读取指定会话的历史消息。 */
  fetchHistory(sessionId: string): Promise<ProviderSessionHistory>;
  /**
   * 把锚点所在回合及其之后的内容整段替换时，需要回退到哪一行。
   *
   * 只有「转写具备稳定行标识」的 provider 才实现；其余留空。
   * 该方法的缺席本身就是「编辑消息」不可用的原因，无需额外的支持标记。
   */
  resolveEditAnchor?(sessionId: string, anchorId: string): Promise<ProviderEditAnchorResolution>;
}
