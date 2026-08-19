// 一个文件=一种作用：AionUi 风格三栏工作台宿主；UI 只产生意图并订阅 TaskEvent。
import { useState } from 'react';
import type { AgentProfileId, EventEnvelope, TaskEvent } from '@awo/protocol';
import { Sider } from './components/layout/Sider';
import { PreviewPanel } from './components/preview/PreviewPanel';

const INITIAL_GOAL = '为 b07-build 设计一个可验证的本地任务执行闭环';

const PROFILE_UI: Record<AgentProfileId, { label: string; description: string }> = {
  build: { label: 'Build', description: '实现与交付；高影响工具需要审批' },
  plan: { label: 'Plan', description: '分析与规划；不允许写入或执行 Shell' },
  explore: { label: 'Explore', description: '快速只读探索；严格限制步骤和上下文' },
};

type TaskEventDraft = TaskEvent extends infer Event
  ? Event extends EventEnvelope
    ? Omit<Event, 'protocolVersion' | 'eventId' | 'at'>
    : never
  : never;

function createEvent(event: TaskEventDraft, suffix: string): TaskEvent {
  const at = Date.now();
  return {
    ...event,
    protocolVersion: '1.0',
    eventId: `${event.runId}:${suffix}:${at}`,
    at,
  } as TaskEvent;
}

function createInitialEvents(): TaskEvent[] {
  return [
    createEvent(
      { type: 'agent.profile.selected', taskId: 'seed-task', runId: 'seed-run', profileId: 'build' },
      'profile',
    ),
    createEvent(
      { type: 'task.created', taskId: 'seed-task', runId: 'seed-run', goal: INITIAL_GOAL },
      'created',
    ),
    createEvent(
      {
        type: 'plan.proposed',
        taskId: 'seed-task',
        runId: 'seed-run',
        steps: [
          { id: 'inspect', description: '核查运行时、协议与现有验证基线', risk: 'low' },
          { id: 'implement', description: '实现受控执行链与可回放事件', risk: 'medium' },
          { id: 'deliver', description: '验证代码并交付可编辑产物', risk: 'low' },
        ],
      },
      'plan',
    ),
  ];
}

function eventPresentation(event: TaskEvent): { title: string; detail: string; tone: string } {
  switch (event.type) {
    case 'task.created':
      return { title: '任务已创建', detail: event.goal, tone: '' };
    case 'agent.profile.selected':
      return { title: 'Agent Profile 已切换', detail: `${PROFILE_UI[event.profileId].label} · ${PROFILE_UI[event.profileId].description}`, tone: 'success' };
    case 'plan.proposed':
      return { title: '执行计划已生成', detail: `${event.steps.length} 个步骤等待运行时调度`, tone: '' };
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

export function App() {
  const [events, setEvents] = useState<TaskEvent[]>(createInitialEvents);
  const [draft, setDraft] = useState('');
  const [activeGoal, setActiveGoal] = useState(INITIAL_GOAL);
  const [activeProfile, setActiveProfile] = useState<AgentProfileId>('build');
  const profile = PROFILE_UI[activeProfile];

  const selectProfile = (profileId: AgentProfileId): void => {
    if (profileId === activeProfile) return;
    setActiveProfile(profileId);
    setEvents((previous) => [
      ...previous.slice(-199),
      createEvent(
        { type: 'agent.profile.selected', taskId: 'workspace-task', runId: 'workspace-run', profileId },
        'profile',
      ),
    ]);
  };

  const submitIntent = (): void => {
    const goal = draft.trim();
    if (!goal) return;
    const taskId = `task-${Date.now()}`;
    const runId = `run-${Date.now()}`;
    const created = createEvent({ type: 'task.created', taskId, runId, goal }, 'created');
    const planned = createEvent(
      {
        type: 'plan.proposed',
        taskId,
        runId,
        steps: [
          { id: 'understand', description: '理解目标、边界与已有材料', risk: 'low' },
          { id: 'execute', description: '在权限与预算约束下执行任务', risk: 'medium' },
          { id: 'deliver', description: '生成可编辑产物并回报验证结果', risk: 'low' },
        ],
      },
      'plan',
    );
    setActiveGoal(goal);
    setEvents((previous) => [...previous.slice(-197), created, planned]);
    setDraft('');
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
                  onClick={() => selectProfile(profileId)}
                  title={PROFILE_UI[profileId].description}
                  type="button"
                >
                  {PROFILE_UI[profileId].label}
                </button>
              ))}
            </div>
            <span className="context-chip">Context 18%</span>
            <span className="status-chip"><span className="status-dot" />运行时就绪</span>
          </div>
        </header>
        <section className="conversation-scroll" aria-label="任务事件流">
          <div className="conversation-frame">
            <div className="welcome-card">
              <div className="welcome-eyebrow">AI Work OS</div>
              <h1>把目标拆解为受控、可解释、可交付的任务。</h1>
              <p>{activeGoal}</p>
              <div className="capability-row" aria-label="当前能力">
                <span className="capability-badge">事件协议 v1.0</span>
                <span className="capability-badge">最小权限</span>
                <span className="capability-badge">执行预算</span>
                <span className="capability-badge">上下文预算</span>
              </div>
            </div>
            <section className="event-section">
              <div className="section-heading">
                <span>任务活动</span>
                <span className="event-count">{events.length} 条事件</span>
              </div>
              <div className="event-timeline">
                {events.map((event) => {
                  const presentation = eventPresentation(event);
                  return (
                    <article className="event-card" key={event.eventId}>
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
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submitIntent();
            }}
            placeholder="描述你希望交付的结果，例如：审查当前运行时并生成可靠性改进方案"
            value={draft}
          />
          <div className="composer-footer">
            <span className="composer-hint">Ctrl / ⌘ + Enter 提交。高风险动作会进入审批流。</span>
            <div className="composer-actions">
              <span className="composer-mode">{profile.label} Profile</span>
              <button className="composer-submit" disabled={!draft.trim()} onClick={submitIntent} type="button">生成计划</button>
            </div>
          </div>
        </div>
      </main>
      <PreviewPanel />
    </div>
  );
}
