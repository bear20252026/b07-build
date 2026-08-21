import type { WorkbenchRunCheckpoint, WorkbenchRunTrajectoryEvent, WorkbenchTaskSnapshot } from '../../runtime/task-client';

export interface RunObservabilityProjection {
  readonly eventCount: number;
  readonly checkpointCount: number;
  readonly lastSequence?: number;
  readonly latestSource?: WorkbenchRunTrajectoryEvent['source'];
  readonly recoveryState: 'not-needed' | 'available' | 'blocked' | 'unavailable';
  readonly summary: string;
}

/** P31：只读运行摘要；输入仅为已水合 metadata，不授予日志读取、恢复或重放能力。 */
export function createRunObservabilityProjection(input: { snapshot: WorkbenchTaskSnapshot; events: readonly WorkbenchRunTrajectoryEvent[]; checkpoints: readonly WorkbenchRunCheckpoint[] }): RunObservabilityProjection {
  const ordered = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const latest = ordered.at(-1);
  const resumable = input.checkpoints.some((checkpoint) => checkpoint.canResume);
  const recoveryState = input.snapshot.status === 'blocked' ? 'blocked' : input.snapshot.status === 'failed' ? (resumable ? 'available' : 'unavailable') : 'not-needed';
  const summary = recoveryState === 'blocked' ? '运行在受控审批点暂停；需要明确人工确认。' : recoveryState === 'available' ? '存在可恢复检查点；恢复仍需用户明确发起。' : recoveryState === 'unavailable' ? '本次失败尚无可恢复检查点；请审查只读轨迹。' : '运行轨迹与检查点仅用于审查，不重放副作用。';
  return { eventCount: ordered.length, checkpointCount: input.checkpoints.length, ...(latest ? { lastSequence: latest.sequence, latestSource: latest.source } : {}), recoveryState, summary };
}
