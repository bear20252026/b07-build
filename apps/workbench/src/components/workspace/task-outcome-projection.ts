import type { WorkbenchTaskDeliveryReceipt, WorkbenchTaskFile } from '../../runtime/task-client';

const MAX_VISIBLE_FILES = 3;

export interface TaskOutcomeFile {
  id: string;
  displayName: string;
  logicalPath: string;
  detail: string;
}

export interface TaskOutcomeDelivery {
  detail: string;
}

export interface TaskOutcomeProjection {
  visibleFiles: readonly TaskOutcomeFile[];
  hiddenFileCount: number;
  latestDelivery: TaskOutcomeDelivery | undefined;
  hasFiles: boolean;
}

/**
 * P21 成果 metadata 的纯投影。
 *
 * 文件正文、哈希、task/run 标识、Gateway client 与任何副作用均不能跨越此模块；它只整理
 * 父组件已水合的 task/run 专属 metadata，以供可扫描的成果块呈现。
 */
export function createTaskOutcomeProjection(
  files: readonly WorkbenchTaskFile[],
  deliveries: readonly WorkbenchTaskDeliveryReceipt[],
): TaskOutcomeProjection {
  const orderedFiles = [...files].sort((left, right) => right.createdAt - left.createdAt || left.displayName.localeCompare(right.displayName));
  const visibleFiles = orderedFiles.slice(0, MAX_VISIBLE_FILES).map((file) => ({
    id: file.taskFileId,
    displayName: file.displayName,
    logicalPath: file.logicalPath,
    detail: `v${file.version} · ${mediaTypeLabel(file.mediaType)} · ${formatByteSize(file.byteSize)}`,
  }));
  const latestDelivery = [...deliveries]
    .sort((left, right) => right.createdAt - left.createdAt || left.deliveryId.localeCompare(right.deliveryId))[0];

  return {
    visibleFiles,
    hiddenFileCount: Math.max(orderedFiles.length - visibleFiles.length, 0),
    latestDelivery: latestDelivery
      ? { detail: `${latestDelivery.fileCount} 个文件 · ${formatByteSize(latestDelivery.byteSize)} · 可供审查` }
      : undefined,
    hasFiles: orderedFiles.length > 0,
  };
}

function mediaTypeLabel(mediaType: WorkbenchTaskFile['mediaType']): string {
  switch (mediaType) {
    case 'text/markdown': return 'Markdown';
    case 'application/json': return 'JSON';
    case 'text/csv': return 'CSV';
    case 'text/x-source': return '代码';
    case 'text/plain': return '文本';
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
