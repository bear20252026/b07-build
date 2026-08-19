import lobeHubMark from '@lobehub/icons-static-svg/icons/lobehub.svg';
import { useState } from 'react';
import { useLocale } from '../../i18n/LocaleProvider';

type NavKey = 'chat' | 'files' | 'schedule' | 'settings';

const NAV: readonly { key: NavKey; icon: string }[] = [
  { key: 'chat', icon: '◌' },
  { key: 'files', icon: '⌑' },
  { key: 'schedule', icon: '◷' },
  { key: 'settings', icon: '⚙' },
];

export interface SiderProps {
  theme: 'light' | 'dark';
  onThemeToggle(): void;
  onNewTask(): void;
}

export function Sider({ theme, onThemeToggle, onNewTask }: SiderProps) {
  const [active, setActive] = useState<NavKey>('chat');
  const { locale, messages, setLocale } = useLocale();
  const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';

  return (
    <nav className="sider" aria-label={messages.navigation.aria}>
      <div className="sider-brand">
        <div className="sider-brand-mark" aria-hidden="true">
          <img alt="" src={lobeHubMark} />
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
          const copy = messages.navigation[item.key];
          return (
            <button
              aria-current={active === item.key ? 'page' : undefined}
              className={`sider-item${active === item.key ? ' active' : ''}`}
              key={item.key}
              onClick={() => setActive(item.key)}
              title={copy.description}
              type="button"
            >
              <span className="sider-icon" aria-hidden="true">{item.icon}</span>
              <span className="sider-label">{copy.label}</span>
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
