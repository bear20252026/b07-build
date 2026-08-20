import { useLocale } from '../../i18n/LocaleProvider';

export type WorkbenchPage = 'workspace' | 'models' | 'operations' | 'security';

const NAV: readonly { key: WorkbenchPage; icon: string; label: string; description: string }[] = [
  { key: 'workspace', icon: '◌', label: '工作区', description: '任务会话、当前状态与交付预览' },
  { key: 'models', icon: '◇', label: '模型连接', description: '第三方 API、模型预设与单次测试' },
  { key: 'operations', icon: '◷', label: '运行记录', description: '运行轨迹、扩展与本地模型观察' },
  { key: 'security', icon: '⚙', label: '安全与系统', description: '只读审计、构件锁定和发布证据' },
];

export interface SiderProps {
  activePage: WorkbenchPage;
  theme: 'light' | 'dark';
  onThemeToggle(): void;
  onNewTask(): void;
  onNavigate(page: WorkbenchPage): void;
}

export function Sider({ activePage, theme, onThemeToggle, onNewTask, onNavigate }: SiderProps) {
  const { locale, messages, setLocale } = useLocale();
  const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';

  return (
    <nav className="sider" aria-label={messages.navigation.aria}>
      <div className="sider-brand">
        <div className="sider-brand-mark" aria-hidden="true">
          <span className="sider-brand-initials">AW</span>
        </div>
        <div className="sider-brand-copy">
          <div className="sider-brand-name">AI Work OS</div>
          <div className="sider-brand-subtitle">{messages.navigation.brandSubtitle}</div>
        </div>
      </div>
      <button className="sider-new-task" onClick={onNewTask} type="button"><span aria-hidden="true">＋</span> {messages.navigation.newTask}</button>
      <div className="sider-section-label">{messages.common.workspace}</div>
      <div className="sider-nav">
        {NAV.map((item) => {
          return (
            <button
              aria-current={activePage === item.key ? 'page' : undefined}
              className={`sider-item${activePage === item.key ? ' active' : ''}`}
              key={item.key}
              onClick={() => onNavigate(item.key)}
              title={item.description}
              type="button"
            >
              <span className="sider-icon" aria-hidden="true">{item.icon}</span>
              <span className="sider-label">{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="sider-spacer" />
      <div className="sider-workspace">
        <div className="sider-workspace-indicator" aria-hidden="true" />
        <div>
          <div className="sider-workspace-name">b07-build</div>
          <div className="sider-workspace-meta">{messages.navigation.workspaceMeta}</div>
        </div>
      </div>
      <div className="sider-footer">
        <span>{messages.common.graphiteTheme}</span>
        <div className="sider-footer-controls">
          <button
            aria-label={`${messages.common.language}: ${messages.localeName}`}
            className="locale-toggle"
            onClick={() => setLocale(nextLocale)}
            title={`${messages.common.language}: ${catalogLabel(nextLocale)}`}
            type="button"
          >
            {locale === 'zh-CN' ? '中' : 'EN'}
          </button>
          <button
            aria-label={theme === 'light' ? messages.common.darkTheme : messages.common.lightTheme}
            aria-pressed={theme === 'dark'}
            className={`theme-switch${theme === 'dark' ? ' active' : ''}`}
            onClick={onThemeToggle}
            type="button"
          >
            <span />
          </button>
        </div>
      </div>
    </nav>
  );
}

function catalogLabel(locale: 'zh-CN' | 'en'): string {
  return locale === 'zh-CN' ? '中文' : 'English';
}
