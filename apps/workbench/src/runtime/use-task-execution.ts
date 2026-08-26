import { useCallback, useState } from 'react';
import type { AgentProfileId } from '@awo/protocol';
import {
  HttpWorkbenchTaskClient,
  type WorkbenchAuthorityMode,
  type WorkbenchRunCheckpoint,
  type WorkbenchRunTrajectoryEvent,
  type WorkbenchRunWorkspaceArtifact,
  type WorkbenchTaskDeliveryReceipt,
  type WorkbenchTaskFile,
  type WorkbenchTaskSnapshot,
  type WorkbenchTaskUpload,
} from './task-client';

export interface PendingChatUpload {
  readonly id: string;
  readonly name: string;
  readonly file: File;
}

async function encodeChatUploads(attachments: readonly PendingChatUpload[]): Promise<readonly WorkbenchTaskUpload[]> {
  if (attachments.length > 8) throw new Error('聊天每次最多上传 8 个文件');
  const uploads = await Promise.all(attachments.map(async (attachment) => {
    if (attachment.file.size === 0 || attachment.file.size > 256 * 1024) throw new Error(`文件 ${attachment.name} 为空或超过 256KiB 任务输入上限`);
    const bytes = new Uint8Array(await attachment.file.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return { id: attachment.id, name: attachment.name, contentBase64: btoa(binary) };
  }));
  if (new Set(uploads.map((upload) => upload.id)).size !== uploads.length) throw new Error('聊天上传文件标识重复');
  return uploads;
}

export interface TaskExecutionMessages {
  readonly localServiceRequired: string;
  readonly submitFailed: string;
  readonly resumeFailed: string;
  readonly approvalFailed: string;
}

export interface TaskExecutionController {
  readonly snapshot: WorkbenchTaskSnapshot | undefined;
  readonly events: readonly import('@awo/protocol').TaskEvent[];
  readonly trajectory: readonly WorkbenchRunTrajectoryEvent[];
  readonly workspaceArtifacts: readonly WorkbenchRunWorkspaceArtifact[];
  readonly checkpoints: readonly WorkbenchRunCheckpoint[];
  readonly taskFiles: readonly WorkbenchTaskFile[];
  readonly deliveries: readonly WorkbenchTaskDeliveryReceipt[];
  readonly pending: boolean;
  readonly deliveryPending: boolean;
  readonly error: string | undefined;
  submit(goal: string, profileId: AgentProfileId, authorityMode: WorkbenchAuthorityMode, uploads?: readonly PendingChatUpload[]): Promise<boolean>;
  resume(): Promise<void>;
  approveAndResume(actionId: string): Promise<void>;
  loadFilePreview(taskFileId: string): ReturnType<HttpWorkbenchTaskClient['filePreview']>;
  loadFileDiff(taskFileId: string): ReturnType<HttpWorkbenchTaskClient['fileDiff']>;
  createDelivery(): Promise<void>;
  requestDelivery(): void;
  deliveryDownloadUrl(deliveryId: string): string;
  reset(): void;
}

/**
 * task/run 的所有网络操作都保留在这个 renderer controller 中，并只通过本机 本机能力服务 client 访问。
 * 它不保存 API key、端点、文件绝对路径或工具权限；所有副作用仍由 本机能力服务 的任务和文件账本执行。
 */
export function useTaskExecution(
  localServiceReady: boolean,
  messages: TaskExecutionMessages,
  client = new HttpWorkbenchTaskClient(),
): TaskExecutionController {
  const [snapshot, setSnapshot] = useState<WorkbenchTaskSnapshot>();
  const [events, setEvents] = useState<readonly import('@awo/protocol').TaskEvent[]>([]);
  const [trajectory, setTrajectory] = useState<readonly WorkbenchRunTrajectoryEvent[]>([]);
  const [workspaceArtifacts, setWorkspaceArtifacts] = useState<readonly WorkbenchRunWorkspaceArtifact[]>([]);
  const [checkpoints, setCheckpoints] = useState<readonly WorkbenchRunCheckpoint[]>([]);
  const [taskFiles, setTaskFiles] = useState<readonly WorkbenchTaskFile[]>([]);
  const [deliveries, setDeliveries] = useState<readonly WorkbenchTaskDeliveryReceipt[]>([]);
  const [pending, setPending] = useState(false);
  const [deliveryPending, setDeliveryPending] = useState(false);
  const [error, setError] = useState<string>();

  const hydrate = useCallback(async (nextSnapshot: WorkbenchTaskSnapshot): Promise<void> => {
    const [nextEvents, nextTrajectory, nextArtifacts, nextCheckpoints, nextTaskFiles, nextDeliveries] = await Promise.all([
      client.events(nextSnapshot.taskId, nextSnapshot.runId),
      client.trajectory(nextSnapshot.taskId, nextSnapshot.runId),
      client.workspaceArtifacts(nextSnapshot.taskId, nextSnapshot.runId),
      client.checkpoints(nextSnapshot.taskId, nextSnapshot.runId),
      client.files(nextSnapshot.taskId, nextSnapshot.runId),
      client.deliveries(nextSnapshot.taskId, nextSnapshot.runId),
    ]);
    setSnapshot(nextSnapshot);
    setEvents(nextEvents);
    setTrajectory(nextTrajectory);
    setWorkspaceArtifacts(nextArtifacts);
    setCheckpoints(nextCheckpoints);
    setTaskFiles(nextTaskFiles);
    setDeliveries(nextDeliveries);
  }, [client]);

  const submit = useCallback(async (goal: string, profileId: AgentProfileId, authorityMode: WorkbenchAuthorityMode, uploads: readonly PendingChatUpload[] = [], modelSelection?: Readonly<{ providerId: string; model?: string }>): Promise<boolean> => {
    if (!goal.trim() || pending) return false;
    if (!localServiceReady) {
      setError(messages.localServiceRequired);
      return false;
    }
    setPending(true);
    setError(undefined);
    try {
      await hydrate(await client.submit({ goal: goal.trim(), profileId, authorityMode, uploads: await encodeChatUploads(uploads), ...(modelSelection === undefined ? {} : { modelSelection }) }));
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : messages.submitFailed);
      return false;
    } finally {
      setPending(false);
    }
  }, [client, localServiceReady, hydrate, messages.localServiceRequired, messages.submitFailed, pending]);

  const resume = useCallback(async (): Promise<void> => {
    if (!snapshot || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await hydrate(await client.resume(snapshot.taskId, snapshot.runId));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : messages.resumeFailed);
    } finally {
      setPending(false);
    }
  }, [client, hydrate, messages.resumeFailed, pending, snapshot]);

  const approveAndResume = useCallback(async (actionId: string): Promise<void> => {
    if (!snapshot || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await hydrate(await client.approve(snapshot.taskId, snapshot.runId, actionId));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : messages.approvalFailed);
    } finally {
      setPending(false);
    }
  }, [client, hydrate, messages.approvalFailed, pending, snapshot]);

  const loadFilePreview = useCallback((taskFileId: string): ReturnType<HttpWorkbenchTaskClient['filePreview']> => {
    if (!snapshot) return Promise.reject(new Error('当前没有可预览的任务文件。'));
    return client.filePreview(snapshot.taskId, snapshot.runId, taskFileId);
  }, [client, snapshot]);

  const loadFileDiff = useCallback((taskFileId: string): ReturnType<HttpWorkbenchTaskClient['fileDiff']> => {
    if (!snapshot) return Promise.reject(new Error('当前没有可比较的任务文件。'));
    return client.fileDiff(snapshot.taskId, snapshot.runId, taskFileId);
  }, [client, snapshot]);

  const createDelivery = useCallback(async (): Promise<void> => {
    if (!snapshot) throw new Error('当前没有可打包的任务文件。');
    const receipt = await client.createDelivery(snapshot.taskId, snapshot.runId);
    setDeliveries((current) => [receipt, ...current.filter((item) => item.deliveryId !== receipt.deliveryId)]);
  }, [client, snapshot]);

  const requestDelivery = useCallback((): void => {
    if (!snapshot || taskFiles.length === 0 || deliveryPending) return;
    setDeliveryPending(true);
    setError(undefined);
    void createDelivery()
      .catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '创建 ZIP 交付包失败。'))
      .finally(() => setDeliveryPending(false));
  }, [createDelivery, deliveryPending, snapshot, taskFiles.length]);

  const deliveryDownloadUrl = useCallback((deliveryId: string): string => {
    if (!snapshot) throw new Error('当前没有可下载的交付包。');
    return client.deliveryDownloadUrl(snapshot.taskId, snapshot.runId, deliveryId);
  }, [client, snapshot]);

  const reset = useCallback((): void => {
    setSnapshot(undefined);
    setEvents([]);
    setTrajectory([]);
    setWorkspaceArtifacts([]);
    setCheckpoints([]);
    setTaskFiles([]);
    setDeliveries([]);
    setPending(false);
    setDeliveryPending(false);
    setError(undefined);
  }, []);

  return {
    snapshot,
    events,
    trajectory,
    workspaceArtifacts,
    checkpoints,
    taskFiles,
    deliveries,
    pending,
    deliveryPending,
    error,
    submit,
    resume,
    approveAndResume,
    loadFilePreview,
    loadFileDiff,
    createDelivery,
    requestDelivery,
    deliveryDownloadUrl,
    reset,
  };
}
