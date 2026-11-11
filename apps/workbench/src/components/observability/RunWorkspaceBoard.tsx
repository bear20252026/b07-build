import { conversationRunStatusLabel, type ConversationRun } from '../../runtime/conversation-runs';

interface RunWorkspaceBoardProps {
  readonly runs: readonly ConversationRun[];
  /** 打开对应会话（运行 = 一段会话，继续它就是"续跑"）。 */
  readonly onOpen: (conversationId: string) => void;
  readonly error?: string;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

/**
 * 运行记录板。
 *
 * ## 数据来源变了
 *
 * 以前这里显示的是"任务执行"的产出与检查点 —— 那套引擎的后端随
 * `apps/runtime-gateway` 一起被删除，数据永远是空的。
 *
 * 现在**一次运行 = 一段会话**：对话循环本身就在做"目标 → 调工具 → 审批 → 轨迹"，
 * 不需要第二套执行模型。这里只做只读汇总，不改任何东西。
 *
 * 状态只有三种，且都由已有事实推导（见 `conversation-runs.ts`）：
 * 等待回复 / 回合中断 / 可继续。**没有"已完成"** —— 会话是可以随时继续的，
 * 编一个终态只会让用户以为事情结束了。
 */
export function RunWorkspaceBoard({ runs, onOpen, error }: RunWorkspaceBoardProps) {
  const totalFiles = runs.reduce((sum, run) => sum + run.filesChanged, 0);
  return (
    <section className="run-workspace-board" aria-label="运行记录">
      <div className="run-workspace-heading">
        <div>
          <span>RUN RECORDS</span>
          <h2>运行记录</h2>
          <p>一次运行 = 一段会话。这里只读汇总：目标、工具调用次数、改过的文件。点开即继续那段会话。</p>
        </div>
        <div className="run-workspace-counts" aria-label="运行计数">
          <span>{runs.length} 次运行</span>
          <span>{totalFiles} 处文件改动</span>
        </div>
      </div>
      {error ? <p className="run-workspace-error">运行记录暂不可用：{error}</p> : <>
        {runs.length === 0 ? <p className="run-workspace-empty">还没有运行记录。发起一次对话即会产生一条。</p> : (
          <ol className="run-workspace-list">
            {runs.map((run) => (
              <li className="run-workspace-item" key={run.conversationId}>
                <div>
                  <strong>{run.title}</strong>
                  <span className={`run-status status-${run.status}`}>{conversationRunStatusLabel(run.status)}</span>
                </div>
                <p className="run-goal">{run.goal || '（没有用户消息）'}</p>
                <small>{run.messageCount} 条消息 · {run.toolCallCount} 次工具调用 · 改动 {run.filesChanged} 个文件（{run.fileChangeCount} 次写入） · {formatTime(run.updatedAt)}</small>
                <button onClick={() => onOpen(run.conversationId)} type="button" title="打开并继续这段会话。">继续这段运行 →</button>
              </li>
            ))}
          </ol>
        )}
        <p className="run-workspace-note">继续一段运行仍会重新经过既有的工具审批与权限策略；这里没有任何"自动重放"。</p>
      </>}
    </section>
  );
}
