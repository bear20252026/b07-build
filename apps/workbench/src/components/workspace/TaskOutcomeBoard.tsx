import type { WorkbenchTaskDeliveryReceipt, WorkbenchTaskFile } from '../../runtime/task-client';
import { createTaskOutcomeProjection } from './task-outcome-projection';

export interface TaskOutcomeBoardProps {
  files: readonly WorkbenchTaskFile[];
  deliveries: readonly WorkbenchTaskDeliveryReceipt[];
  deliveryPending: boolean;
  onOpenInspector(): void;
  onCreateDelivery(): void;
}

/**
 * P21 原创任务成果块。
 *
 * 参考块式工作区的可扫描成果组织，但只显示 App 已持有的 task/run metadata。此组件不能读取
 * 文件、创建网络请求、下载/执行 ZIP，且把全部有副作用动作交回父组件的显式 intent。
 */
export function TaskOutcomeBoard({ files, deliveries, deliveryPending, onOpenInspector, onCreateDelivery }: TaskOutcomeBoardProps) {
  const outcome = createTaskOutcomeProjection(files, deliveries);

  return (
    <section className="task-outcomes" aria-label="当前任务成果">
      <header className="task-outcomes-heading">
        <div>
          <span>TASK OUTCOMES</span>
          <h2>当前任务成果</h2>
          <p>只显示此 task/run 的受控文件与交付收据 metadata；详细内容仍在右侧检查器逐项审查。</p>
        </div>
        <div className="task-outcomes-scope"><span aria-hidden="true" />受控成果范围</div>
      </header>
      <div className="task-outcomes-grid">
        <article className="task-outcomes-files">
          <div className="task-outcomes-card-heading"><span>FILES</span><strong>{outcome.hasFiles ? `${files.length} 个可审查文件` : '尚未产生文件'}</strong></div>
          {outcome.hasFiles ? (
            <ul>
              {outcome.visibleFiles.map((file) => (
                <li key={file.id}>
                  <span className="task-outcomes-file-mark" aria-hidden="true">□</span>
                  <div><strong>{file.displayName}</strong><small title={file.logicalPath}>{file.logicalPath}</small><em>{file.detail}</em></div>
                </li>
              ))}
            </ul>
          ) : <p className="task-outcomes-empty">任务运行生成受控文件后，会在这里出现可审查的 metadata。</p>}
          {outcome.hiddenFileCount > 0 && <small className="task-outcomes-more">另有 {outcome.hiddenFileCount} 个文件，可在检查器中查看。</small>}
        </article>
        <article className={`task-outcomes-delivery${outcome.latestDelivery ? ' ready' : ''}`}>
          <div className="task-outcomes-card-heading"><span>DELIVERY</span><strong>{outcome.latestDelivery ? '最新 ZIP 收据' : '尚未创建 ZIP'}</strong></div>
          <p>{outcome.latestDelivery?.detail ?? '文件就绪后，由你明确创建 ZIP；系统不会自动下载、解压或执行。'}</p>
          <small>{outcome.latestDelivery ? 'ZIP 仍须在检查器中审查并手动下载。' : '创建操作只收集当前 task/run 的受控文件。'}</small>
        </article>
      </div>
      <footer className="task-outcomes-actions">
        <button className="task-outcomes-review" onClick={onOpenInspector} type="button">审查成果</button>
        {outcome.hasFiles && <button className="task-outcomes-delivery-action" disabled={deliveryPending} onClick={onCreateDelivery} type="button">{deliveryPending ? '正在创建 ZIP…' : '创建 ZIP 交付包'}</button>}
      </footer>
    </section>
  );
}
