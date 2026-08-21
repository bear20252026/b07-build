import type { AgentProfileId } from '@awo/protocol';
import type { Translation } from '../../i18n/catalog';
import { WORKBENCH_PROFILE_IDS } from './agent-profiles';

export interface ChatHomeProps {
  activeProfile: AgentProfileId;
  connectedProviderCount: number;
  gatewayAttached: boolean;
  messages: Translation;
  profiles: Readonly<Record<AgentProfileId, { label: string; description: string }>>;
  onOpenModels(): void;
  onProfileChange(profileId: AgentProfileId): void;
  onSuggestion(goal: string): void;
}

/**
 * P20 原创聊天首页。
 *
 * 参考 AionUi 的「首页优先开始工作、复杂控制迁入 Settings」职责分层；不复用其源码、
 * 品牌、图标或资产。该组件只有本地 UI 意图，不读取 Gateway、Provider、SQLite、文件或凭据。
 */
export function ChatHome({
  activeProfile,
  connectedProviderCount,
  gatewayAttached,
  messages,
  profiles,
  onOpenModels,
  onProfileChange,
  onSuggestion,
}: ChatHomeProps) {
  const home = messages.home;
  const modelTitle = gatewayAttached && connectedProviderCount > 0
    ? home.providerReady(connectedProviderCount)
    : home.providerWaiting;

  return (
    <section className="chat-home" aria-label={messages.task.title}>
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
      <section className={`chat-home-provider${gatewayAttached && connectedProviderCount > 0 ? ' ready' : ''}`} aria-label="第三方模型连接状态">
        <div>
          <span>MODEL CONNECTION</span>
          <strong>{modelTitle}</strong>
          <p>{home.providerDescription}</p>
        </div>
        <button onClick={onOpenModels} type="button">{home.openModels}</button>
      </section>
      <section className="chat-home-suggestions" aria-label={home.suggestionLabel}>
        <span>{home.suggestionLabel}</span>
        <div>
          {home.suggestions.map((suggestion) => <button key={suggestion} onClick={() => onSuggestion(suggestion)} type="button">{suggestion}</button>)}
        </div>
      </section>
      <p className="chat-home-settings-note">{home.settingsHint}</p>
    </section>
  );
}
