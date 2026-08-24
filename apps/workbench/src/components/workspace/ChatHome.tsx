import type { AgentProfileId } from '@awo/protocol';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Translation } from '../../i18n/catalog';
import { WORKBENCH_PROFILE_IDS } from './agent-profiles';
import { createWorkModeAuditProjection } from './work-mode-projection';
import { messageWindowStart, MESSAGE_RENDER_WINDOW } from './chat-timeline-window';
import { parseMathSegments } from './math-text';
import { useChatAutoScroll } from './use-chat-auto-scroll';
import type { DirectConversation, DirectConversationActivity } from '../../runtime/use-direct-conversations';
import type { WorkbenchProviderConnection, WorkbenchProviderModelDiscovery } from '../../runtime/task-client';
import { homeModelCapabilityHint, homeModelChoices, isSelectableHomeModel } from '../../runtime/home-model-switching';
import { isSearchRunKind, searchRunLabel, searchRunMode, searchRunStatus, type SearchRunMode } from '../../runtime/search-run-card';

export { messageWindowStart } from './chat-timeline-window';

const LazyMathText = lazy(() => import('./MathText'));

function MessageText({ value }: Readonly<{ value: string }>) {
  const hasFormula = parseMathSegments(value).some((segment) => segment.kind !== 'text');
  if (!hasFormula) return <>{value}</>;
  return <Suspense fallback={<span className="math-text-plain">{value}</span>}><LazyMathText value={value} /></Suspense>;
}

async function copyMessageText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

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
  connections: readonly WorkbenchProviderConnection[];
  discoveredModels: Readonly<Record<string, WorkbenchProviderModelDiscovery | undefined>>;
  taskModelSelection?: Readonly<{ providerId: string; model?: string }>;
  messages: Translation;
  profiles: Readonly<Record<AgentProfileId, { label: string; description: string }>>;
  onSelectTaskModel(selection: Readonly<{ providerId: string; model?: string }>): void;
  onPrepareSearchRetry(query: string, mode: SearchRunMode): void;
  onOpenModels(): void;
  onProfileChange(profileId: AgentProfileId): void;
  onSuggestion(goal: string): void;
}

function HomeModelSwitcher({
  connections,
  discoveredModels,
  selection,
  onSelectTaskModel,
  onOpenModels,
}: Readonly<{
  connections: readonly WorkbenchProviderConnection[];
  discoveredModels: Readonly<Record<string, WorkbenchProviderModelDiscovery | undefined>>;
  selection?: Readonly<{ providerId: string; model?: string }>;
  onSelectTaskModel(selection: Readonly<{ providerId: string; model?: string }>): void;
  onOpenModels(): void;
}>) {
  const connection = connections.find((item) => item.providerId === selection?.providerId) ?? connections[0];
  const selectedModel = selection?.providerId === connection?.providerId ? (selection.model ?? connection.defaultModel) : connection?.defaultModel;
  const [modelDraft, setModelDraft] = useState(selectedModel ?? '');
  useEffect(() => setModelDraft(selectedModel ?? ''), [connection?.providerId, selectedModel]);
  if (!connection) return <section className="chat-home-provider" aria-label="第三方模型连接状态"><div><span>MODEL CONNECTION</span><strong>尚未连接模型</strong><p>请先添加任意厂商的 Provider 连接；首页不会回退到旧 Gateway 链路。</p></div><button onClick={onOpenModels} type="button">添加 API 连接</button></section>;
  const choices = homeModelChoices(connection, discoveredModels[connection.providerId]);
  const applyModel = (): void => {
    const model = modelDraft.trim();
    if (isSelectableHomeModel(model)) onSelectTaskModel({ providerId: connection.providerId, model });
  };
  return <section className="chat-home-provider chat-home-provider-switcher ready" aria-label="首页 Provider 与模型切换">
    <div className="chat-home-provider-switcher-heading"><span>MODEL CONNECTION · DIRECT</span><strong>{connection.displayName}</strong><p>切换仅改变后续聊天使用的连接和模型；不会修改地址、密钥或自动改用其他厂商。</p></div>
    <label>厂商连接<select aria-label="首页厂商连接" value={connection.providerId} onChange={(event) => {
      const next = connections.find((item) => item.providerId === event.target.value);
      if (next) onSelectTaskModel({ providerId: next.providerId, model: next.defaultModel });
    }}>
      {connections.map((item) => <option key={item.providerId} value={item.providerId}>{item.displayName} · {item.driverId.replace('desktop-direct.', '')}</option>)}
    </select></label>
    <label>模型标识<input aria-label="首页模型标识" list={`home-model-options-${connection.providerId}`} maxLength={128} onChange={(event) => setModelDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyModel(); } }} value={modelDraft} /><datalist id={`home-model-options-${connection.providerId}`}>{choices.map((model) => <option key={model} value={model} />)}</datalist></label>
    <p className="chat-home-provider-capability">{homeModelCapabilityHint(connection, modelDraft.trim() || connection.defaultModel)}</p>
    <div className="chat-home-provider-switcher-actions"><button disabled={!isSelectableHomeModel(modelDraft)} onClick={applyModel} type="button">使用此模型</button><button className="chat-home-provider-manage" onClick={onOpenModels} type="button">管理 API</button></div>
  </section>;
}

function SearchRunCard({ activity, query, onPrepareSearchRetry }: Readonly<{ activity: DirectConversationActivity; query: string; onPrepareSearchRetry(query: string, mode: SearchRunMode): void }>) {
  const kind = activity.kind;
  if (!isSearchRunKind(kind)) return null;
  const state = searchRunStatus(activity.text);
  const sourceCount = activity.sources?.length ?? 0;
  return <section className={`chat-home-search-run ${state}`} aria-label={`${searchRunLabel(kind, activity.text)}运行状态`}>
    <div className="chat-home-search-run-heading"><div><span>SEARCH RUN</span><strong>{searchRunLabel(kind, activity.text)}</strong></div><b>{state === 'succeeded' ? `完成 · ${sourceCount} 来源` : '失败已隔离'}</b></div>
    <p>{activity.text}</p>
    {sourceCount > 0 && <ol className="chat-home-search-sources">{activity.sources?.map((source) => <li key={source.url}><a href={source.url} rel="noreferrer" target="_blank">{source.title}</a></li>)}</ol>}
    {state === 'failed' && <button onClick={() => onPrepareSearchRetry(query, searchRunMode(kind, activity.text))} type="button">准备以同一后端重试</button>}
  </section>;
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
  connections,
  discoveredModels,
  taskModelSelection,
  messages,
  profiles,
  onSelectTaskModel,
  onPrepareSearchRetry,
  onOpenModels,
  onProfileChange,
  onSuggestion,
}: ChatHomeProps) {
  const timelineRef = useRef<HTMLElement | null>(null);
  const previousMessageCount = useRef(activeConversation?.messages.length ?? 0);
  const [windowStart, setWindowStart] = useState(() => messageWindowStart(activeConversation?.messages.length ?? 0));
  const home = messages.home;
  const hasTaskModel = Boolean(taskModelLabel);
  const modelTitle = restoringProviderSession ? '正在恢复本地模型会话…' : (hasTaskModel ? taskModelLabel! : (gatewayAttached && connectedProviderCount > 0 ? home.providerReady(connectedProviderCount) : home.providerWaiting));
  const workMode = createWorkModeAuditProjection({ profileId: activeProfile, authorityMode, connectedProviderCount });
  const hasConversationContent = Boolean(directResponse?.output) || Boolean(activeConversation && activeConversation.messages.length > 0);
  const messageCount = activeConversation?.messages.length ?? 0;
  const visibleStart = messageWindowStart(messageCount, windowStart);
  const visibleMessages = activeConversation?.messages.slice(visibleStart) ?? [];
  const latestMessage = activeConversation?.messages.at(-1);
  const { onScroll, jumpToLatest, showJumpToLatest } = useChatAutoScroll(timelineRef, `${activeConversation?.id ?? 'none'}:${messageCount}:${latestMessage?.text.length ?? 0}`, activeConversation?.id);

  useEffect(() => {
    setWindowStart((current) => messageWindowStart(messageCount, current));
    previousMessageCount.current = messageCount;
  }, [messageCount]);

  useEffect(() => {
    setWindowStart(messageWindowStart(messageCount));
    previousMessageCount.current = messageCount;
  }, [activeConversation?.id]);

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
          {hasConversationContent && activeConversation && <section className="chat-home-message-timeline" aria-live="polite" aria-label="当前对话消息" onScroll={onScroll} ref={timelineRef}>
            {visibleStart > 0 && <button className="chat-home-load-history" onClick={() => setWindowStart((current) => Math.max(0, current - MESSAGE_RENDER_WINDOW))} type="button">加载更早的 {Math.min(MESSAGE_RENDER_WINDOW, visibleStart)} 条消息</button>}
            {visibleMessages.map((message) => <article className={`chat-home-message chat-home-message--${message.role}`} key={message.id}>
              <div className="chat-home-message-meta"><span className="chat-home-message-label">{message.role === 'user' ? 'YOU' : message.model ?? taskModelLabel ?? 'AI WORK OS'}</span><button className="chat-home-message-copy" onClick={() => { void copyMessageText(message.text); }} title="复制这一条对话的完整文本" type="button">复制</button></div>
              {message.activities?.map((activity) => isSearchRunKind(activity.kind) ? <SearchRunCard activity={activity} key={`${message.id}-${activity.kind}`} onPrepareSearchRetry={onPrepareSearchRetry} query={message.text} /> : <details className="chat-home-message-process" key={`${message.id}-${activity.kind}`}><summary>{activity.kind === 'reasoning' ? '模型过程（供应商实际返回）' : '附件上下文与图片（本轮传递状态）'}</summary><pre>{activity.text}</pre></details>)}
              <div className="chat-home-message-content"><MessageText value={message.text} /></div>
            </article>)}
            {showJumpToLatest && <button aria-label="跳到最新消息" className="chat-home-jump-latest" onClick={jumpToLatest} title="跳到最新消息" type="button">↓</button>}
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
          {restoringProviderSession ? <section className="chat-home-provider" aria-label="第三方模型连接状态"><div><span>MODEL CONNECTION</span><strong>{modelTitle}</strong><p>仅在本地重建已保存的原生 Provider 会话，不会自动探测、查询模型或发送第三方请求。</p></div></section> : <HomeModelSwitcher connections={connections} discoveredModels={discoveredModels} onOpenModels={onOpenModels} onSelectTaskModel={onSelectTaskModel} selection={taskModelSelection} />}
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
