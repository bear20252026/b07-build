import { useEffect, useMemo, useRef, useState } from 'react';
import orbitCompanion from '../../assets/companions/orbit.png';
import moriCompanion from '../../assets/companions/mori.png';
import pixelCompanion from '../../assets/companions/pixel.png';
import sageCompanion from '../../assets/companions/sage.png';
import novaIcon from '../../assets/nova-icon.png';
import { useLocale } from '../../i18n/LocaleProvider';
import type { WorkbenchPage } from './workbench-page';
import type { WorkbenchProject } from '../../runtime/project-client';
import type { DirectConversation } from '../../runtime/use-direct-conversations';

/** 工作区与设置页均是显式前端意图；不授予 Gateway、文件或执行权限。 */
export type { WorkbenchPage } from './workbench-page';

type NavItem = { key: WorkbenchPage; icon: string; label: string; description: string };

const WORKSPACE_NAV: readonly NavItem[] = [
  { key: 'workspace', icon: '◌', label: '工作区', description: '极简任务发起与当前工作方式' },
  { key: 'projects', icon: '▤', label: '项目', description: '本地项目、任务归属与成果组织' },
];

type Companion = { id: 'orbit' | 'mori' | 'pixel' | 'sage'; name: string; role: string; image: string };

/** 原创本地动态角色：只改变 Workbench 阅读体验，不驱动模型、Profile、工具或权限。 */
const COMPANIONS: readonly Companion[] = [
  { id: 'orbit', name: 'Orbit', role: '实现与交付', image: orbitCompanion },
  { id: 'mori', name: 'Mori', role: '分析与规划', image: moriCompanion },
  { id: 'pixel', name: 'Pixel', role: '快速探索', image: pixelCompanion },
  { id: 'sage', name: 'Sage', role: '隔离阅读', image: sageCompanion },
];

export interface SiderProps {
  activePage: WorkbenchPage;
  hasActiveTask: boolean;
  projects: readonly WorkbenchProject[];
  selectedProjectId?: string;
  conversations: readonly DirectConversation[];
  activeConversationId?: string;
  mobileNavigation?: boolean;
  theme: 'light' | 'dark';
  onThemeToggle(): void;
  onNewTask(): void;
  onNavigate(page: WorkbenchPage): void;
  onShowWorkspaceConversations(): void;
  onSelectProject(projectId: string): void;
  onSelectConversation(id: string): void;
  onNewConversation(): void;
  onRenameConversation(id: string, title: string): void;
  onRemoveConversation(id: string): void;
}

function NavigationItem({ activePage, item, onNavigate }: { activePage: WorkbenchPage; item: NavItem; onNavigate(page: WorkbenchPage): void }) {
  return (
    <button
      aria-current={activePage === item.key ? 'page' : undefined}
      className={`sider-item${activePage === item.key ? ' active' : ''}`}
      onClick={() => onNavigate(item.key)}
      title={item.description}
      type="button"
    >
      <span className="sider-icon" aria-hidden="true">{item.icon}</span>
      <span className="sider-label">{item.label}</span>
    </button>
  );
}

function useFreshListItems(projects: readonly WorkbenchProject[], conversations: readonly DirectConversation[]): ReadonlySet<string> {
  const signature = useMemo(() => [...projects.map((project) => `p:${project.projectId}`), ...conversations.map((conversation) => `c:${conversation.id}`)].join('|'), [conversations, projects]);
  const known = useRef<ReadonlySet<string> | undefined>(undefined); const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const next = new Set(signature ? signature.split('|') : []);
    if (!known.current) { known.current = next; return; }
    const added = new Set([...next].filter((id) => !known.current?.has(id)));
    known.current = next; if (!added.size) return;
    setFresh(added); const timer = window.setTimeout(() => setFresh(new Set()), 260); return () => window.clearTimeout(timer);
  }, [signature]);
  return fresh;
}

/**
 * 参考 AionUi 的两态侧栏：主工作区只承载任务入口，设置状态替换为二级设置导航。
 * 这仅改变阅读与跳转层级；所有 Gateway 请求仍必须由用户明确点击的页面动作触发。
 */
export function Sider({ activePage, hasActiveTask, projects, selectedProjectId, conversations, activeConversationId, mobileNavigation = false, theme, onThemeToggle, onNewTask, onNavigate, onShowWorkspaceConversations, onSelectProject, onSelectConversation, onNewConversation, onRenameConversation, onRemoveConversation }: SiderProps) {
  const { locale, messages, setLocale } = useLocale();
  const [companionId, setCompanionId] = useState<Companion['id']>('orbit');
  const [companionMotion, setCompanionMotion] = useState<'idle' | 'attention' | 'celebrate'>('idle');
  const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';
  const workspaceNav = hasActiveTask
    ? [...WORKSPACE_NAV, { key: 'task' as const, icon: '▣', label: '当前任务', description: '类型化任务页面与受控成果' }]
    : WORKSPACE_NAV;
  const companion = COMPANIONS.find((item) => item.id === companionId) ?? COMPANIONS[0];
  const chooseCompanion = (id: Companion['id']): void => { setCompanionId(id); setCompanionMotion('celebrate'); };
  const visibleConversations = conversations.filter((conversation) => conversation.projectId === selectedProjectId);
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId);
  const freshListItems = useFreshListItems(projects, conversations);

  if (mobileNavigation) {
    const mobileButton = { minWidth: 0, flex: '1 1 0', display: 'grid', placeItems: 'center', gap: 2, padding: '7px 2px', color: 'var(--muted-strong)', fontSize: 10, border: 0, borderRadius: 12, background: 'transparent' } as const;
    const mobileActive = { ...mobileButton, color: 'var(--accent-strong)', background: 'var(--accent-soft)' } as const;
    const mobilePanel = { position: 'fixed', zIndex: 2147483645, right: 12, bottom: 72, left: 12, maxHeight: 'min(60dvh, 480px)', overflow: 'auto', padding: 12, border: '1px solid var(--border)', borderRadius: 20, background: 'var(--panel)', boxShadow: 'var(--shadow-float)' } as const;
    return <nav aria-label="NOVA 手机导航" className="sider sider-mobile" style={{ position: 'fixed', zIndex: 2147483644, right: 0, bottom: 0, left: 0, height: 64, minHeight: 64, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, padding: '7px 10px env(safe-area-inset-bottom)', border: 0, borderTop: '1px solid var(--border)', background: 'color-mix(in srgb, var(--sidebar) 94%, transparent)', boxShadow: '0 -8px 24px color-mix(in srgb, var(--text-strong) 7%, transparent)' }}>
      <button aria-current={activePage === 'workspace' ? 'page' : undefined} onClick={onShowWorkspaceConversations} style={activePage === 'workspace' ? mobileActive : mobileButton} type="button"><span aria-hidden="true">◌</span><span>聊天</span></button>
      <details style={{ minWidth: 0, flex: '1 1 0', textAlign: 'center' }}>
        <summary style={{ ...mobileButton, width: '100%', cursor: 'pointer', listStyle: 'none' }}><span aria-hidden="true">☰</span><span>会话</span></summary>
        <div style={mobilePanel}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><strong style={{ color: 'var(--text-strong)', fontSize: 13 }}>本地项目与会话</strong><button onClick={onNewConversation} style={{ minHeight: 30, padding: '0 10px', color: '#fff', border: 0, borderRadius: 10, background: 'var(--accent-strong)' }} type="button">新建会话</button></div>
          <div style={{ display: 'grid', gap: 6, marginTop: 12 }}><button onClick={onShowWorkspaceConversations} style={{ minHeight: 36, padding: '0 10px', color: 'var(--text-strong)', textAlign: 'left', border: '1px solid var(--border)', borderRadius: 11, background: !selectedProjectId ? 'var(--accent-soft)' : 'var(--panel-subtle)' }} type="button">工作区对话</button>{projects.map((project) => <button key={project.projectId} onClick={() => onSelectProject(project.projectId)} style={{ minHeight: 36, padding: '0 10px', color: 'var(--text-strong)', textAlign: 'left', border: '1px solid var(--border)', borderRadius: 11, background: project.projectId === selectedProjectId ? 'var(--accent-soft)' : 'var(--panel-subtle)' }} type="button">▱ {project.title}</button>)}</div>
          <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>{visibleConversations.length === 0 ? <p style={{ margin: 0, color: 'var(--muted)', fontSize: 11 }}>当前范围尚无会话。</p> : visibleConversations.map((conversation) => <button key={conversation.id} onClick={() => onSelectConversation(conversation.id)} style={{ minHeight: 40, padding: '5px 10px', color: 'var(--text-strong)', textAlign: 'left', border: '1px solid var(--border)', borderRadius: 11, background: conversation.id === activeConversationId ? 'var(--accent-soft)' : 'var(--panel-subtle)' }} type="button"><strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>{conversation.title}</strong><small style={{ color: 'var(--muted)', fontSize: 9 }}>{conversation.messages.length} 条消息</small></button>)}</div>
        </div>
      </details>
      <button aria-current={activePage === 'projects' ? 'page' : undefined} onClick={() => onNavigate('projects')} style={activePage === 'projects' ? mobileActive : mobileButton} type="button"><span aria-hidden="true">▤</span><span>项目</span></button>
      <button aria-current={activePage === 'models' ? 'page' : undefined} onClick={() => onNavigate('models')} style={activePage === 'models' ? mobileActive : mobileButton} type="button"><span aria-hidden="true">⌁</span><span>模型</span></button>
      <button onClick={onNewTask} style={mobileButton} type="button"><span aria-hidden="true">＋</span><span>新建</span></button>
    </nav>;
  }

  return (
    <nav className="sider" aria-label={messages.navigation.aria}>
      <div className="sider-brand">
        <div className="sider-brand-mark" aria-hidden="true"><img alt="" src={novaIcon} /></div>
        <div className="sider-brand-copy"><div className="sider-brand-name">NOVA</div><div className="sider-brand-subtitle">{messages.navigation.brandSubtitle}</div></div>
      </div>
      <button className="sider-new-task" onClick={onNewTask} type="button"><span aria-hidden="true">＋</span> {messages.navigation.newTask}</button>
      <div className="sider-section-label">{messages.common.workspace}</div>
      <div className="sider-nav">{workspaceNav.map((item) => <NavigationItem activePage={activePage} item={item} key={item.key} onNavigate={item.key === 'workspace' ? () => onShowWorkspaceConversations() : onNavigate} />)}</div>
      <section className="sider-project-browser" aria-label="项目与聊天会话">
        <div className="sider-browser-heading"><span>项目</span><button onClick={() => onNavigate('projects')} title="新建或管理本地项目。" type="button">＋</button></div>
        <div className="sider-project-list">
          <button className={`sider-project-item${!selectedProjectId ? ' active' : ''}`} onClick={onShowWorkspaceConversations} type="button"><span aria-hidden="true">⌂</span><strong>工作区对话</strong></button>
          {projects.map((project) => <button className={`sider-project-item${project.projectId === selectedProjectId ? ' active' : ''}${freshListItems.has(`p:${project.projectId}`) ? ' sider-list-arrive' : ''}`} key={project.projectId} onClick={() => onSelectProject(project.projectId)} title={project.description || `打开项目：${project.title}`} type="button"><span aria-hidden="true">▱</span><strong>{project.title}</strong><small>{project.taskCount} 项任务</small></button>)}
        </div>
        <div className="sider-browser-heading sider-browser-heading--conversations"><span>{selectedProject ? selectedProject.title : '工作区'} · 聊天</span><button onClick={onNewConversation} title="在当前工作区或项目中新建一个独立聊天会话。" type="button">＋</button></div>
        <div className="sider-conversation-list">
          {visibleConversations.length === 0 && <p>尚无对话。点击 ＋ 新建。</p>}
          {visibleConversations.map((conversation) => <div className={`sider-conversation-row${conversation.id === activeConversationId ? ' active' : ''}${freshListItems.has(`c:${conversation.id}`) ? ' sider-list-arrive' : ''}`} key={conversation.id}><button className="sider-conversation-item" onClick={() => onSelectConversation(conversation.id)} title={`${conversation.messages.length} 条消息 · ${conversation.selection.model ?? conversation.selection.providerId}`} type="button"><strong>{conversation.title}</strong><small>{conversation.messages.length} 条消息</small></button><span className="sider-conversation-actions"><button onClick={() => { const title = window.prompt('重命名本地对话', conversation.title); if (title?.trim()) onRenameConversation(conversation.id, title); }} title="重命名此本地对话。" type="button">✎</button><button onClick={() => { if (window.confirm(`删除“${conversation.title}”及其本地聊天记录？`)) onRemoveConversation(conversation.id); }} title="删除此本地对话及其本地聊天记录。" type="button">×</button></span></div>)}
        </div>
      </section>
      <div className="sider-spacer" />
      <section className="companion-card" aria-label="当前 Agent 小玩偶">
        <button aria-label={`${companion.name} 动态玩偶：${companion.role}`} className="companion-current" data-motion={companionMotion} title="点击让玩偶回应。它只是本地界面动画，不会创建任务、调用模型或改变权限。" onAnimationEnd={() => setCompanionMotion('idle')} onBlur={() => setCompanionMotion('idle')} onClick={() => setCompanionMotion('celebrate')} onFocus={() => setCompanionMotion('attention')} onPointerEnter={() => setCompanionMotion('attention')} onPointerLeave={() => setCompanionMotion('idle')} type="button">
          <span className="companion-portrait-stage" aria-hidden="true"><img alt="" className="companion-portrait" src={companion.image} /><i /></span>
          <span className="companion-current-copy"><span>当前助手 · 动态状态</span><strong>{companion.name}</strong><small>{companion.role}</small></span>
        </button>
        <div aria-label="选择 Agent 小玩偶风格" className="companion-picker" role="group">
          {COMPANIONS.map((item) => <button aria-label={`选择 ${item.name}：${item.role}`} aria-pressed={item.id === companion.id} className={`companion-choice${item.id === companion.id ? ' active' : ''}`} key={item.id} title={`切换为 ${item.name} 视觉风格；不会切换模型、任务 Profile 或权限。`} onClick={() => chooseCompanion(item.id)} type="button"><img alt="" src={item.image} /></button>)}
        </div>
      </section>
      <div className="sider-workspace"><div className="sider-workspace-indicator" aria-hidden="true" /><div><div className="sider-workspace-name">b07-build</div><div className="sider-workspace-meta">{messages.navigation.workspaceMeta}</div></div></div>
      <div className="sider-footer">
        <button className="sider-settings-entry" onClick={() => onNavigate('models')} type="button"><span aria-hidden="true">⚙</span>{messages.navigation.openSettings}</button>
        <div className="sider-footer-controls">
          <button aria-label={`${messages.common.language}: ${messages.localeName}`} className="locale-toggle" onClick={() => setLocale(nextLocale)} title={`${messages.common.language}: ${catalogLabel(nextLocale)}`} type="button">{locale === 'zh-CN' ? '中' : 'EN'}</button>
          <button aria-label={theme === 'light' ? messages.common.darkTheme : messages.common.lightTheme} aria-pressed={theme === 'dark'} className={`theme-switch${theme === 'dark' ? ' active' : ''}`} onClick={onThemeToggle} type="button"><span /></button>
        </div>
      </div>
    </nav>
  );
}

function catalogLabel(locale: 'zh-CN' | 'en'): string {
  return locale === 'zh-CN' ? '中文' : 'English';
}
