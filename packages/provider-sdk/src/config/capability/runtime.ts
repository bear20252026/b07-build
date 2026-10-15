// 一个文件=一种作用：provider「执行运行时」能力面契约（纯类型，零 IO）。

/** 一个未完成的后台任务摘要。 */
export interface ProviderBackgroundTask {
  readonly taskId: string;
  readonly label?: string;
}

/** 一次运行请求。 */
export interface ProviderRunInput {
  readonly sessionId: string;
  /** provider 原生命令 / 回合文本。 */
  readonly command: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/** 某个会话上仍未完成的后台任务集合。 */
export interface ProviderBackgroundWork {
  readonly sessionId: string;
  readonly tasks: readonly ProviderBackgroundTask[];
}

/**
 * 执行运行时能力面：真正驱动 provider 跑一次回合 / 命令。
 * 运行期上下文（写出口、权限网关）由调用方在调用时注入，不放进契约本体。
 */
export interface ProviderRuntimeFacet {
  /** 运行一次 provider 原生命令 / 回合。 */
  run(input: ProviderRunInput): Promise<unknown>;
  /** 中止一次运行中的会话；返回是否确有在跑的回合被中止。 */
  abort(sessionId: string): boolean | Promise<boolean>;
  /**
   * 列出「回合结束后进程仍存活」的会话及其未完成后台任务。
   *
   * 只有这类 runtime 才有可报告内容；其余留空，缺席即「后台任务面板」不可用。
   */
  listBackgroundWork?(): readonly ProviderBackgroundWork[];
  /**
   * 停止某个未完成后台任务；无存活进程或该进程未跟踪此任务时返回 false。
   * 与 `listBackgroundWork` 配套：存在 list 才谈得上 stop。
   */
  stopBackgroundTask?(sessionId: string, taskId: string): Promise<boolean>;
}
