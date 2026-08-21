import type { ReactNode } from 'react';
import type { WorkbenchTaskSnapshot } from '../../runtime/task-client';
import { createTaskPageProjection, type TaskPageBlock } from './task-page-projection';

export interface TaskPageProps {
  snapshot: WorkbenchTaskSnapshot;
  activeGoal: string | undefined;
  eventCount: number;
  taskFileCount: number;
  deliveryCount: number;
  profileLabel: string;
  authorityLabel: string;
  pending: boolean;
  blockedNodeId: string | undefined;
  onBackToChat(): void;
  onOpenInspector(): void;
  onApproveAndResume(): void;
  onResume(): void;
  children: ReactNode;
}

function WorkBlock({ block, onOpenInspector }: { block: TaskPageBlock; onOpenInspector(): void }) {
  return (
    <article className={`task-page-block ${block.tone}`}>
      <header><span>{block.label}</span><i aria-hidden="true" /></header>
      <strong>{block.title}</strong>
      <p>{block.description}</p>
      {block.id === 'outcomes' && <button onClick={onOpenInspector} type="button">审查成果</button>}
    </article>
  );
}

/**
 * P22 原创任务页。
 *
 * 此页把已有 task/run 投影为稳定工作块。它不持有 HTTP client，也不读取文件或创建 Provider
 * 调用；所有状态改变都由父组件传入的既有受控 intent 完成。
 */
export function TaskPage({
  snapshot,
  activeGoal,
  eventCount,
  taskFileCount,
  deliveryCount,
  profileLabel,
  authorityLabel,
  pending,
  blockedNodeId,
  onBackToChat,
  onOpenInspector,
  onApproveAndResume,
  onResume,
  children,
}: TaskPageProps) {
  const projection = createTaskPageProjection({ snapshot, activeGoal, eventCount, taskFileCount, deliveryCount });
  const canResume = snapshot.status === 'blocked' || snapshot.status === 'failed';

  return (
    <section className="task-page" aria-label="当前任务页面">
      <header className="task-page-heading">
        <div>
          <button className="task-page-back" onClick={onBackToChat} type="button"><span aria-hidden="true">←</span> 返回聊天</button>
          <span className="task-page-kicker">TASK PAGE · LOCAL CONTROL PLANE</span>
          <h1>{projection.heading}</h1>
          <p>{projection.description}</p>
        </div>
        <div className="task-page-context"><span>{profileLabel}</span><span>{authorityLabel}</span><span className={`status-chip ${snapshot.status}`}><i className="status-dot" />{snapshot.status}</span></div>
      </header>
      <div className="task-page-block-grid">
        {projection.blocks.map((block) => <WorkBlock block={block} key={block.id} onOpenInspector={onOpenInspector} />)}
      </div>
      {(snapshot.status === 'blocked' || snapshot.status === 'failed') && <section className="task-page-recovery" aria-label="任务恢复操作">
        <div><span>EXPLICIT RECOVERY</span><strong>{snapshot.status === 'blocked' ? '需要人工确认后才能继续' : '可从受控检查点恢复'}</strong><p>恢复与审批是显式运行意图；任务页不会替你自动批准、重放或执行副作用。</p></div>
        <div className="task-page-recovery-actions">
          {snapshot.status === 'blocked' && blockedNodeId && <button className="task-page-primary" disabled={pending} onClick={onApproveAndResume} type="button">{pending ? '正在处理…' : `批准并继续 ${blockedNodeId}`}</button>}
          {canResume && <button className="task-page-secondary" disabled={pending} onClick={onResume} type="button">从检查点恢复</button>}
        </div>
      </section>}
      <div className="task-page-content">{children}</div>
    </section>
  );
}
