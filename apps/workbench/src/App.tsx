import { useState } from 'react';
import type { AgentProfileId, TaskEvent } from '@awo/protocol';
import { Sider } from './components/layout/Sider';
import { PreviewPanel } from './components/preview/PreviewPanel';
import {
  HttpWorkbenchTaskClient,
  type WorkbenchTaskSnapshot,
} from './runtime/task-client';

const INITIAL_GOAL = '提交一个目标，启动可恢复的本地受控任务。';
const taskClient = new HttpWorkbenchTaskClient();

const PROFILE_UI: Record<AgentProfileId, { label: string; description: string }> = {
  build: { label: 'Build', description: '实现与交付；高影响工具需要审批' },
  plan: { label: 'Plan', description: '分析与规划；不允许写入或执行 Shell' },
  explore: { label: 'Explore', description: '快速只读探索；严格限制步骤和上下文' },
};

function eventPresentation(event: TaskEvent): { title: string; detail: string; tone: string } {
  switch (event.type) {
    case 'task.created':
      return { title: '任务已创建', detail: event.goal, tone: '' };
    case 'agent.profile.selected':
      return { title: 'Agent Profile 已选择', detail: `${PROFILE_UI[event.profileId].label} · ${PROFILE_UI[event.profileId].description}`, tone: 'success' };
    case 'plan.proposed':
      return { title: '执行计划已生成', detail: `${event.steps.length} 个受控步骤已交给本地运行时`, tone: '' };
    case 'approval.required':
      return { title: '需要人工审批', detail: `${event.capability} · ${event.reason}`, tone: 'warn' };
    case 'approval.resolved':
      return { title: event.decision === 'approved' ? '审批已通过' : '审批被拒绝', detail: `操作 ${event.actionId} 由 ${event.resolvedBy} 处理`, tone: event.decision === 'approved' ? 'success' : 'danger' };
    case 'tool.called':
      return { title: `正在调用 ${event.tool.name}`, detail: `${event.tool.capability} · ${event.tool.risk} 风险`, tone: '' };
    case 'tool.result':
      return { title: event.status === 'ok' ? '工具执行完成' : '工具执行未完成', detail: event.reason ?? event.outputRef, tone: event.status === 'ok' ? 'success' : 'danger' };
    case 'artifact.created':
      return { title: '交付产物已生成', detail: `${event.mime} · ${event.path}`, tone: 'success' };
    case 'task.completed':
      return { title: '任务已完成', detail: event.summaryRef, tone: 'success' };
    case 'task.failed':
      return { title: '任务执行失败', detail: `${event.code} · ${event.message}`, tone: 'danger' };
    case 'context.compacted':
      return { title: '上下文已压缩', detail: `${event.estimatedTokensBefore} → ${event.estimatedTokensAfter} tokens`, tone: 'warn' };
    case 'execution.blocked':
      return { title: '执行预算已阻断', detail: `${event.code} · ${event.reason}`, tone: 'warn' };
  }
}

function statusLabel(status: WorkbenchTaskSnapshot['status'] | undefined): string {
  if (!status) return '等待任务';
  return { created: '已创建', running: '运行中', blocked: '等待审批', completed: '已完成', failed: '执行失败' }[status];
}

export function App() {
  const [events, setEvents] = useState<readonly TaskEvent[]>([]);
  const [snapshot, setSnapshot] = useState<WorkbenchTaskSnapshot>();
  const [draft, setDraft] = useState('');
  const [activeGoal, setActiveGoal] = useState(INITIAL_GOAL);
  const [activeProfile, setActiveProfile] = useState<AgentProfileId>('build');
  const [pending, setPending] = useState(false);
  const [serviceError, setServiceError] = useState<string>();
  const profile = PROFILE_UI[activeProfile];
  const blockedNodeId = snapshot && Object.entries(snapshot.nodeOutcomes).find(([, outcome]) => outcome === 'blocked')?.[0];

  const hydrate = async (nextSnapshot: WorkbenchTaskSnapshot): Promise<void> => {
    const nextEvents = await taskClient.events(nextSnapshot.taskId, nextSnapshot.runId);
    setSnapshot(nextSnapshot);
    setEvents(nextEvents);
  };

  const submitIntent = async (): Promise<void> => {
    const goal = draft.trim();
    if (!goal || pending) return;
    setPending(true);
    setServiceError(undefined);
    try {
      const nextSnapshot = await taskClient.submit({ goal, profileId: activeProfile });
      await hydrate(nextSnapshot);
      setActiveGoal(goal);
      setDraft('');
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : '无法连接本地任务服务');
    } finally {
      setPending(false);
    }
  };

  const resume = async (): Promise<void> => {
    if (!snapshot || pending) return;
    setPending(true);
    setServiceError(undefined);
    try {
      await hydrate(await taskClient.resume(snapshot.taskId, snapshot.runId));
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : '恢复任务失败');
    } finally {
      setPending(false);
    }
  };

  const approveAndResume = async (): Promise<void> => {
    if (!snapshot || !blockedNodeId || pending) return;
    setPending(true);
    setServiceError(undefined);
    try {
      await hydrate(await taskClient.approve(snapshot.taskId, snapshot.runId, blockedNodeId));
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : '审批或恢复任务失败');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="workbench-shell">
      <Sider />
      <main className="workbench-main">
        <header className="workbench-titlebar">
          <div>
            <div className="titlebar-kicker">Outcome → Plan → Execute → Deliver</div>
            <div className="titlebar-title">受控任务工作台</div>
          </div>
          <div className="titlebar-actions">
            <div className="profile-switcher" aria-label="选择 Agent Profile">
              {(Object.keys(PROFILE_UI) as AgentProfileId[]).map((profileId) => (
                <button
                  className={`agent-chip${activeProfile === profileId ? ' active' : ''}`}
                  key={profileId}
                  onClick={() => setActiveProfile(profileId)}
                  title={PROFILE_UI[profileId].description}
                  type="button"
                >
                  {PROFILE_UI[profileId].label}
                </button>
              ))}
            </div>
            <span className="context-chip">{snapshot?.stats ? `并发峰值 ${snapshot.stats.maxObservedConcurrency}` : '本地快照'}</span>
            <span className={`status-chip ${snapshot?.status ?? ''}`}><span className="status-dot" />{statusLabel(snapshot?.status)}</span>
          </div>
        </header>
        <section className="conversation-scroll" aria-label="任务事件流">
          <div className="conversation-frame">
            <div className="welcome-card">
              <div className="welcome-eyebrow">AI Work OS · Local Runtime</div>
              <h1>把目标拆解为受控、可解释、可恢复的任务。</h1>
              <p>{activeGoal}</p>
              <div className="capability-row" aria-label="当前能力">
                <span className="capability-badge">事件协议 v1.0</span>
                <span className="capability-badge">最小权限</span>
                <span className="capability-badge">SQLite 快照</span>
                <span className="capability-badge">{profile.label} Profile</span>
              </div>
            </div>
            {serviceError && <div className="runtime-error" role="alert">本地运行时：{serviceError}</div>}
            <section className="runtime-snapshot" aria-label="当前任务快照">
              <div>
                <div className="snapshot-eyebrow">真实运行时快照</div>
                <strong>{snapshot ? statusLabel(snapshot.status) : '尚无任务'}</strong>
                <span>{snapshot ? `第 ${snapshot.attempt} 次尝试 · ${Object.keys(snapshot.nodeOutcomes).length} 个节点` : '提交目标后将在此显示 SQLite 持久化的任务状态。'}</span>
              </div>
              {snapshot && (
                <div className="snapshot-actions">
                  {snapshot.status === 'blocked' && blockedNodeId && (
                    <button className="snapshot-primary" disabled={pending} onClick={approveAndResume} type="button">
                      {pending ? '处理中…' : `批准并恢复 ${blockedNodeId}`}
                    </button>
                  )}
                  {(snapshot.status === 'blocked' || snapshot.status === 'failed') && (
                    <button className="snapshot-secondary" disabled={pending} onClick={resume} type="button">
                      从快照恢复
                    </button>
                  )}
                </div>
              )}
            </section>
            <section className="event-section">
              <div className="section-heading">
                <span>任务活动</span>
                <span className="event-count">{events.length} 条真实事件</span>
              </div>
              <div className="event-timeline">
                {events.length === 0 && <div className="empty-events">尚未接收到运行时事件。启动本地网关后提交一个目标。</div>}
                {events.map((nextEvent) => {
                  const presentation = eventPresentation(nextEvent);
                  return (
                    <article className="event-card" key={nextEvent.eventId}>
                      <span className={`event-marker ${presentation.tone}`} aria-hidden="true" />
                      <div>
                        <div className="event-title">{presentation.title}</div>
                        <div className="event-meta">{presentation.detail}</div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        </section>
        <div className="task-composer">
          <textarea
            aria-label="任务目标"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submitIntent();
            }}
            placeholder="描述你希望交付的结果，例如：审查当前运行时并生成可靠性改进方案"
            value={draft}
          />
          <div className="composer-footer">
            <span className="composer-hint">Ctrl / ⌘ + Enter 提交。高风险动作会进入审批流。</span>
            <div className="composer-actions">
              <span className="composer-mode">{profile.label} Profile</span>
              <button className="composer-submit" disabled={!draft.trim() || pending} onClick={() => void submitIntent()} type="button">
                {pending ? '提交中…' : '生成计划'}
              </button>
            </div>
          </div>
        </div>
      </main>
      <PreviewPanel />
    </div>
  );
}
