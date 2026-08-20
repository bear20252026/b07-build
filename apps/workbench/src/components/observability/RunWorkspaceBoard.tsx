import type { WorkbenchRunCheckpoint, WorkbenchRunWorkspaceArtifact } from '../../runtime/task-client';

interface RunWorkspaceBoardProps {
  readonly artifacts: readonly WorkbenchRunWorkspaceArtifact[];
  readonly checkpoints: readonly WorkbenchRunCheckpoint[];
  readonly error?: string;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function statusLabel(status: WorkbenchRunCheckpoint['status']): string {
  return ({ created: '已创建', running: '运行中', blocked: '等待审批', completed: '已完成', failed: '需重试' })[status];
}

/**
 * P11 的运行级只读审查板。它不打开 reference、不读取文件、不创建工作区，
 * `canResume` 仅说明现有任务可通过原有显式意图继续，绝不是自动恢复入口。
 */
export function RunWorkspaceBoard({ artifacts, checkpoints, error }: RunWorkspaceBoardProps) {
  return (
    <section className="run-workspace-board" aria-label="运行产出与检查点">
      <div className="run-workspace-heading">
        <div>
          <span>WORKSPACE LEDGER</span>
          <h2>运行产出与检查点</h2>
          <p>仅展示受控引用与脱敏状态摘要；不会读取文件、重放工具或改变权限。</p>
        </div>
        <div className="run-workspace-counts" aria-label="账本计数">
          <span>{artifacts.length} 产出</span>
          <span>{checkpoints.length} 检查点</span>
        </div>
      </div>
      {error ? <p className="run-workspace-error">账本暂不可用：{error}</p> : <>
        <div className="run-workspace-columns">
          <section className="run-workspace-section" aria-label="受控运行产出">
            <div className="run-workspace-section-heading"><strong>受控产出</strong><small>REFERENCE ONLY</small></div>
            {artifacts.length === 0 ? <p className="run-workspace-empty">当前运行尚未产生可审查的受控产出引用。</p> : (
              <ol className="run-workspace-list">
                {artifacts.map((artifact) => (
                  <li className="run-workspace-item" key={artifact.artifactLedgerId}>
                    <div><strong>{artifact.kind === 'tool-output' ? '工具结果引用' : '声明的产出物'}</strong><code>{artifact.reference}</code></div>
                    <small>{artifact.nodeId} · {formatTime(artifact.at)} · SHA-256 已记录</small>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section className="run-workspace-section" aria-label="运行检查点">
            <div className="run-workspace-section-heading"><strong>恢复检查点</strong><small>NO AUTO-RESUME</small></div>
            {checkpoints.length === 0 ? <p className="run-workspace-empty">任务提交后将生成只读检查点，用于审查而非自动执行。</p> : (
              <ol className="run-workspace-list">
                {checkpoints.map((checkpoint) => (
                  <li className="run-workspace-item checkpoint" key={checkpoint.checkpointId}>
                    <div><strong>第 {checkpoint.attempt} 次尝试 · {statusLabel(checkpoint.status)}</strong><span className={checkpoint.canResume ? 'resume-available' : ''}>{checkpoint.canResume ? '可由用户显式继续' : '仅供审查'}</span></div>
                    <small>{checkpoint.artifactCount} 项产出 · {formatTime(checkpoint.createdAt)} · 状态与产出摘要已哈希</small>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
        <p className="run-workspace-note">检查点不是审批、许可证或命令。继续任务仍会重新经过既有 Profile、权限策略和审批链。</p>
      </>}
    </section>
  );
}
