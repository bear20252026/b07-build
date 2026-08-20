import { useLocale } from '../../i18n/LocaleProvider';

/** 工作区与设置页均是显式前端意图；不授予 Gateway、文件或执行权限。 */
export type WorkbenchPage = 'workspace' | 'models' | 'connections' | 'operations' | 'capabilities' | 'security';

type NavItem = { key: WorkbenchPage; icon: string; label: string; description: string };

const WORKSPACE_NAV: readonly NavItem[] = [
  { key: 'workspace', icon: '◌', label: '工作区', description: '任务对话、当前状态与交付预览' },
  { key: 'models', icon: '◇', label: '模型连接', description: '设置第三方 API 并开始对话' },
];

const SETTINGS_NAV: readonly { group: string; items: readonly NavItem[] }[] = [
  {
    group: 'AI CORE',
    items: [
      { key: 'models', icon: '◇', label: '模型连接', description: '第三方 API 的新手连接向导' },
      { key: 'connections', icon: '✓', label: '已连接模型', description: '状态、显式测试与受限文本试用' },
    ],
  },
  {
    group: 'WORKSPACE',
    items: [
      { key: 'operations', icon: '◷', label: '运行记录', description: '检查点、产出账本与只读轨迹' },
      { key: 'capabilities', icon: '◇', label: '扩展与能力', description: '扩展中心、本地模型健康与控制面摘要' },
    ],
  },
  {
    group: 'SYSTEM',
    items: [
      { key: 'security', icon: '⚙', label: '安全与系统', description: '只读审计、构件锁定和发布证据' },
    ],
  },
];

export interface SiderProps {
  activePage: WorkbenchPage;
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
export function Sider({ activePage, theme, onThemeToggle, onNewTask, onNavigate }: SiderProps) {
  const { locale, messages, setLocale } = useLocale();
  const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';
  const isSettings = activePage !== 'workspace';

  return (
    <nav className={`sider${isSettings ? ' settings-mode' : ''}`} aria-label={messages.navigation.aria}>
      <div className="sider-brand">
        <div className="sider-brand-mark" aria-hidden="true"><span className="sider-brand-initials">AW</span></div>
        <div className="sider-brand-copy"><div className="sider-brand-name">AI Work OS</div><div className="sider-brand-subtitle">{isSettings ? '设置与连接' : messages.navigation.brandSubtitle}</div></div>
      </div>
      {isSettings ? (
        <>
          <button className="sider-back-workspace" onClick={() => onNavigate('workspace')} type="button"><span aria-hidden="true">←</span> 返回工作区</button>
          <div className="sider-settings-nav">
            {SETTINGS_NAV.map((section) => (
              <section className="sider-settings-group" key={section.group} aria-label={section.group}>
                <div className="sider-section-label">{section.group}</div>
                {section.items.map((item) => <NavigationItem activePage={activePage} item={item} key={item.key} onNavigate={onNavigate} />)}
              </section>
            ))}
          </div>
        </>
      ) : (
        <>
          <button className="sider-new-task" onClick={onNewTask} type="button"><span aria-hidden="true">＋</span> {messages.navigation.newTask}</button>
          <div className="sider-section-label">{messages.common.workspace}</div>
          <div className="sider-nav">{WORKSPACE_NAV.map((item) => <NavigationItem activePage={activePage} item={item} key={item.key} onNavigate={onNavigate} />)}</div>
        </>
      )}
      <div className="sider-spacer" />
      <div className="sider-workspace"><div className="sider-workspace-indicator" aria-hidden="true" /><div><div className="sider-workspace-name">b07-build</div><div className="sider-workspace-meta">{isSettings ? '设置不会中断当前任务' : messages.navigation.workspaceMeta}</div></div></div>
      <div className="sider-footer">
        <button className="sider-settings-entry" onClick={() => onNavigate(isSettings ? 'workspace' : 'models')} type="button">{isSettings ? '返回对话' : '打开设置'}</button>
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
