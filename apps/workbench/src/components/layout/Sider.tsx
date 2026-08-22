import { useState } from 'react';
import orbitCompanion from '../../assets/companions/orbit.png';
import moriCompanion from '../../assets/companions/mori.png';
import pixelCompanion from '../../assets/companions/pixel.png';
import sageCompanion from '../../assets/companions/sage.png';
import { useLocale } from '../../i18n/LocaleProvider';
import type { WorkbenchPage } from './workbench-page';

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
  theme: 'light' | 'dark';
  onThemeToggle(): void;
  onNewTask(): void;
  onNavigate(page: WorkbenchPage): void;
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

/**
 * 参考 AionUi 的两态侧栏：主工作区只承载任务入口，设置状态替换为二级设置导航。
 * 这仅改变阅读与跳转层级；所有 Gateway 请求仍必须由用户明确点击的页面动作触发。
 */
export function Sider({ activePage, hasActiveTask, theme, onThemeToggle, onNewTask, onNavigate }: SiderProps) {
  const { locale, messages, setLocale } = useLocale();
  const [companionId, setCompanionId] = useState<Companion['id']>('orbit');
  const [companionMotion, setCompanionMotion] = useState<'idle' | 'attention' | 'celebrate'>('idle');
  const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';
  const workspaceNav = hasActiveTask
    ? [...WORKSPACE_NAV, { key: 'task' as const, icon: '▣', label: '当前任务', description: '类型化任务页面与受控成果' }]
    : WORKSPACE_NAV;
  const companion = COMPANIONS.find((item) => item.id === companionId) ?? COMPANIONS[0];
  const chooseCompanion = (id: Companion['id']): void => { setCompanionId(id); setCompanionMotion('celebrate'); };

  return (
    <nav className="sider" aria-label={messages.navigation.aria}>
      <div className="sider-brand">
        <div className="sider-brand-mark" aria-hidden="true"><span className="sider-brand-initials">AW</span></div>
        <div className="sider-brand-copy"><div className="sider-brand-name">AI Work OS</div><div className="sider-brand-subtitle">{messages.navigation.brandSubtitle}</div></div>
      </div>
      <button className="sider-new-task" onClick={onNewTask} type="button"><span aria-hidden="true">＋</span> {messages.navigation.newTask}</button>
      <div className="sider-section-label">{messages.common.workspace}</div>
      <div className="sider-nav">{workspaceNav.map((item) => <NavigationItem activePage={activePage} item={item} key={item.key} onNavigate={onNavigate} />)}</div>
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
