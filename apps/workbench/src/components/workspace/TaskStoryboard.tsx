import type { WorkbenchTaskSnapshot } from '../../runtime/task-client';
import {
  createTaskStoryboardProjection,
  type TaskStoryboardBlock,
} from './task-storyboard-projection';

export interface TaskStoryboardProps {
  snapshot: WorkbenchTaskSnapshot | undefined;
  eventCount: number;
  taskFileCount: number;
  deliveryCount: number;
  onOpenInspector(): void;
}

function StoryboardBlock({ block, onOpenInspector }: { block: TaskStoryboardBlock; onOpenInspector(): void }) {
  const canOpenInspector = block.id === 'deliverables';

  return (
    <article className={`task-storyboard-block ${block.tone}`}>
      <div className="task-storyboard-block-header">
        <span>{block.eyebrow}</span>
        <i aria-hidden="true" />
      </div>
      <strong>{block.title}</strong>
      <p>{block.description}</p>
      <footer>
        <small>{block.meta}</small>
        {canOpenInspector && <button onClick={onOpenInspector} type="button">查看成果</button>}
      </footer>
    </article>
  );
}

/**
 * P19 原创任务故事板。
 *
 * 参考块式工作区的阅读顺序与任务细节的职责隔离，但未复制 AFFiNE 或 LobeHub 源码。
 * 输入局限于父组件已经持有的脱敏任务 DTO；组件不能请求 本机能力服务、Provider、SQLite 或文件内容。
 */
export function TaskStoryboard({ snapshot, eventCount, taskFileCount, deliveryCount, onOpenInspector }: TaskStoryboardProps) {
  const projection = createTaskStoryboardProjection({ snapshot, eventCount, taskFileCount, deliveryCount });

  return (
    <section className="task-storyboard" aria-label="当前任务故事板">
      <header className="task-storyboard-heading">
        <div>
          <span>TASK STORYBOARD</span>
          <h2>{projection.heading}</h2>
          <p>{projection.description}</p>
        </div>
        <div className="task-storyboard-scope" title="此区域只显示当前 task/run 的脱敏摘要">
          <span aria-hidden="true" />本机 task/run 范围
        </div>
      </header>
      <div className="task-storyboard-grid">
        {projection.blocks.map((block) => <StoryboardBlock block={block} key={block.id} onOpenInspector={onOpenInspector} />)}
      </div>
      <p className="task-storyboard-note">故事板用于解释当前任务，不会启动 本机能力服务、调用第三方 API、执行文件或绕过审批；成果仍须在右侧检查器中逐项审查。</p>
    </section>
  );
}
