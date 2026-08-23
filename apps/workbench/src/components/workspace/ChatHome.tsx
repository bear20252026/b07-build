import type { AgentProfileId } from '@awo/protocol';
import type { Translation } from '../../i18n/catalog';
import { WORKBENCH_PROFILE_IDS } from './agent-profiles';
import { createWorkModeAuditProjection } from './work-mode-projection';
import type { DirectConversation } from '../../runtime/use-direct-conversations';

export interface ChatHomeProps {
  activeProfile: AgentProfileId;
  authorityMode: 'plan' | 'review' | 'automate';
  connectedProviderCount: number;
  gatewayAttached: boolean;
  taskModelLabel?: string;
  directResponse?: Readonly<{ output: string; model?: string; complete: boolean }>;
  directError?: string;
  restoringProviderSession?: boolean;
  draftActive?: boolean;
  activeConversation?: DirectConversation;
  messages: Translation;
  profiles: Readonly<Record<AgentProfileId, { label: string; description: string }>>;
  onOpenModels(): void;
  onProfileChange(profileId: AgentProfileId): void;
  onSuggestion(goal: string): void;
}

/**
 * 原创聊天首页视觉层。
 *
 * 本轮参考 Unsloth Studio 的公开桌面 UI 组织（薄荷背景、圆角窗口、轻量侧栏、居中工作区），
 * 不复用其源码、品牌、图标或资产。该组件只有本地 UI 意图，不读取 Provider、SQLite、文件或凭据。
 */
export function ChatHome({
  activeProfile,
  authorityMode,
  connectedProviderCount,
  gatewayAttached,
  taskModelLabel,
  directResponse,
  directError,
  restoringProviderSession = false,
  draftActive = false,
  activeConversation,
  messages,
  profiles,
  onOpenModels,
  onProfileChange,
  onSuggestion,
}: ChatHomeProps) {
  const home = messages.home;
  const hasTaskModel = Boolean(taskModelLabel);
  const modelTitle = restoringProviderSession ? '正在恢复本地模型会话…' : (hasTaskModel ? taskModelLabel! : (gatewayAttached && connectedProviderCount > 0 ? home.providerReady(connectedProviderCount) : home.providerWaiting));
  const workMode = createWorkModeAuditProjection({ profileId: activeProfile, authorityMode, connectedProviderCount });
  const hasConversationContent = Boolean(directResponse?.output) || Boolean(activeConversation && activeConversation.messages.length > 0);

  return (
    <section className={`chat-home chat-home--studio${hasConversationContent ? ' chat-home--conversation-active' : ' chat-home--conversation-idle'}${draftActive && !hasConversationContent ? ' chat-home--drafting' : ''}`} aria-label={messages.task.title}>
      <div className="chat-home-workbench">
        <div className="chat-home-canvas">
          {!hasConversationContent && <div className="chat-home-hero">
            <span className="chat-home-appmark" aria-hidden="true">
              <svg viewBox="0 0 40 40" focusable="false"><rect x="4.5" y="4.5" width="31" height="31" rx="10" fill="currentColor" opacity=".12" /><path d="M12 13.5h16v13H12zM16 18h8M16 22h5M12 27.5h16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <span>{home.eyebrow}</span>
            <h1>{hasTaskModel ? 'What’s on your mind today?' : home.title}</h1>
            <p>{hasTaskModel ? taskModelLabel : home.description}</p>
          </div>}
          {hasConversationContent && activeConversation && <section className="chat-home-message-timeline" aria-live="polite" aria-label="当前对话消息">
            {activeConversation.messages.map((message) => <article className={`chat-home-message chat-home-message--${message.role}`} key={message.id}>
              <span className="chat-home-message-label">{message.role === 'user' ? 'YOU' : message.model ?? taskModelLabel ?? 'AI WORK OS'}</span>
              {message.activities?.map((activity) => <details className="chat-home-message-process" key={`${message.id}-${activity.kind}`}><summary>{activity.kind === 'reasoning' ? '模型过程（供应商实际返回）' : activity.kind === 'web-search' ? '联网检索（本轮明确启用）' : activity.kind === 'research' ? '近 30 天研究（本轮明确启用）' : activity.kind === 'hybrid-search' ? '混合检索（并行后端）' : activity.kind === 'searxng' ? '本地 SearXNG（本轮明确启用）' : '附件上下文与图片（本轮传递状态）'}</summary><pre>{activity.text}</pre>{activity.sources && activity.sources.length > 0 && <ol className="chat-home-search-sources">{activity.sources.map((source) => <li key={source.url}><a href={source.url} rel="noreferrer" target="_blank">{source.title}</a></li>)}</ol>}</details>)}
              <p>{message.text}</p>
            </article>)}
          </section>}
          {directResponse && !activeConversation?.messages.length && <section className="chat-home-direct-response" aria-live="polite"><div><span>DIRECT MODEL RESPONSE</span><strong>{directResponse.model ?? taskModelLabel ?? '已选模型'}</strong><small>{directResponse.complete ? '流式回答完成' : '正在接收第三方文本分块…'}</small></div><pre>{directResponse.output || '正在等待模型返回首个文本分块…'}</pre></section>}
          {directError && <p className="chat-home-direct-error" role="alert">{directError}</p>}
          {!hasConversationContent && <section className="chat-home-profile" aria-label={home.profileLabel}>
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
          </section>}
        </div>
        {!hasConversationContent && <aside className={`chat-home-context${hasTaskModel ? ' chat-home-context--connected' : ''}`} aria-label="当前任务上下文">
          <section className={`chat-home-provider${hasTaskModel ? ' ready' : ''}`} aria-label="第三方模型连接状态">
            <div>
              <span>MODEL CONNECTION</span>
              <strong>{modelTitle}</strong>
              <p>{restoringProviderSession ? '仅在本地重建已保存的原生 Provider 会话，不会自动探测、查询模型或发送第三方请求。' : taskModelLabel ? `当前任务模型：${taskModelLabel}。发送对话将只调用此选择。` : `${home.providerDescription} 请在 API 连接中明确选择一个任务模型。`}</p>
            </div>
            <button onClick={onOpenModels} type="button">{taskModelLabel ? '管理 API' : home.openModels}</button>
          </section>
          <section className="chat-home-work-mode" aria-label="工作方式审计摘要"><span>WORK MODE · EXPLICIT</span><strong>{profiles[workMode.profileId].label} · {messages.authority.mode[authorityMode].label}</strong><p>{workMode.connectionSummary}</p><small>{workMode.boundarySummary}</small></section>
          <section className="chat-home-suggestions chat-home-suggestions--context" aria-label={home.suggestionLabel}>
            <span>{home.suggestionLabel}</span>
            <div>{home.suggestions.map((suggestion) => <button key={suggestion} onClick={() => onSuggestion(suggestion)} type="button">{suggestion}</button>)}</div>
          </section>
          <p className="chat-home-settings-note">{home.settingsHint}</p>
        </aside>}
      </div>
    </section>
  );
}
