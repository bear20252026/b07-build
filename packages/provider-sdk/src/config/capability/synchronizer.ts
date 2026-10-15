// 一个文件=一种作用：provider「外部会话同步」能力面契约（纯类型，零 IO）。

/**
 * 外部会话同步能力面：扫描 provider 自己写在磁盘上的会话产物，
 * 把归一化后的会话元数据归并进应用侧。
 *
 * 供两类调用：全量重扫，以及文件监听触发的单文件增量归并。
 */
export interface ProviderSessionSynchronizerFacet {
  /** 全量扫描并归并；`since` 为起始时间（毫秒），缺席表示不限。返回本次归并数量。 */
  synchronize(since?: number): Promise<number>;
  /** 只归并单个产物文件，返回归并出的会话 id；无法识别时返回 null。 */
  synchronizeFile(filePath: string): Promise<string | null>;
}
