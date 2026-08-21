import type { AgentProfileId } from '@awo/protocol';
import type { Translation } from '../../i18n/catalog';
import { WORKBENCH_PROFILE_IDS } from './agent-profiles';
import { createWorkModeAuditProjection } from './work-mode-projection';
import { TASK_TEMPLATES, type TaskTemplate } from './task-templates-and-closeout';

export interface ChatHomeProps {
  activeProfile: AgentProfileId;
  authorityMode: 'plan' | 'review' | 'automate';
  connectedProviderCount: number;
  gatewayAttached: boolean;
  messages: Translation;
  profiles: Readonly<Record<AgentProfileId, { label: string; description: string }>>;
  onOpenModels(): void;
  onProfileChange(profileId: AgentProfileId): void;
  onSuggestion(goal: string): void;
  onTemplate(template: TaskTemplate): void;
}

/**
 * P20 原创聊天首页。
 *
 * 参考 AionUi 的「首页优先开始工作、复杂控制迁入 Settings」职责分层；不复用其源码、
 * 品牌、图标或资产。该组件只有本地 UI 意图，不读取 Gateway、Provider、SQLite、文件或凭据。
 */
export function ChatHome({
  activeProfile,
  authorityMode,
  connectedProviderCount,
  gatewayAttached,
  messages,
  profiles,
  onOpenModels,
  onProfileChange,
  onSuggestion,
  onTemplate,
}: ChatHomeProps) {
  const home = messages.home;
  const modelTitle = gatewayAttached && connectedProviderCount > 0
    ? home.providerReady(connectedProviderCount)
    : home.providerWaiting;
  const workMode = createWorkModeAuditProjection({ profileId: activeProfile, authorityMode, connectedProviderCount });

  return (
    <section className="chat-home" aria-label={messages.task.title}>
      <div className="chat-home-workbench">
        <div className="chat-home-canvas">
          <div className="chat-home-hero">
            <span>{home.eyebrow}</span>
            <h1>{home.title}</h1>
            <p>{home.description}</p>
          </div>
          <section className="chat-home-profile" aria-label={home.profileLabel}>
            <div className="chat-home-section-heading"><span>{home.profileLabel}</span><small>{profiles[activeProfile].label}</small></div>
            <div className="chat-home-profile-grid">
              {WORKBENCH_PROFILE_IDS.map((profileId) => {
                const profile = profiles[profileId];
                return (
                  <button
                    aria-pressed={activeProfile === profileId}
                    className={`chat-home-profile-card${activeProfile === profileId ? ' active' : ''}`}
                    key={profileId}
                    onClick={() => onProfileChange(profileId)}
                    title={profile.description}
                    type="button"
                  >
                    <strong>{profile.label}</strong>
                    <span>{profile.description}</span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="chat-home-template-board" aria-label="任务模板"><div className="chat-home-section-heading"><span>任务模板</span><small>选择后会填入任务输入框</small></div><div>{TASK_TEMPLATES.map((template) => <button key={template.id} onClick={() => onTemplate(template)} type="button"><strong>{template.title}</strong><span>{profiles[template.profileId].label} · {messages.authority.mode[template.authorityMode].label}</span></button>)}</div></section>
        </div>
        <aside className="chat-home-context" aria-label="当前任务上下文">
          <section className={`chat-home-provider${gatewayAttached && connectedProviderCount > 0 ? ' ready' : ''}`} aria-label="第三方模型连接状态">
            <div>
              <span>MODEL CONNECTION</span>
              <strong>{modelTitle}</strong>
              <p>{home.providerDescription}</p>
            </div>
            <button onClick={onOpenModels} type="button">{home.openModels}</button>
          </section>
          <section className="chat-home-work-mode" aria-label="工作方式审计摘要"><span>WORK MODE · EXPLICIT</span><strong>{profiles[workMode.profileId].label} · {messages.authority.mode[authorityMode].label}</strong><p>{workMode.connectionSummary}</p><small>{workMode.boundarySummary}</small></section>
          <section className="chat-home-suggestions chat-home-suggestions--context" aria-label={home.suggestionLabel}>
            <span>{home.suggestionLabel}</span>
            <div>{home.suggestions.map((suggestion) => <button key={suggestion} onClick={() => onSuggestion(suggestion)} type="button">{suggestion}</button>)}</div>
          </section>
          <p className="chat-home-settings-note">{home.settingsHint}</p>
        </aside>
      </div>
    </section>
  );
}
