import { useState } from 'react';

type NavKey = 'chat' | 'files' | 'schedule' | 'settings';

const NAV: { key: NavKey; label: string; icon: string; description: string }[] = [
  { key: 'chat', label: '任务会话', icon: '◌', description: '受控任务与恢复快照' },
  { key: 'files', label: '产物与引用', icon: '⌑', description: '交付物与知识来源' },
  { key: 'schedule', label: '计划任务', icon: '◷', description: '本地可恢复执行' },
  { key: 'settings', label: '工作区设置', icon: '⚙', description: '本地运行时偏好' },
];

export interface SiderProps {
  theme: 'light' | 'dark';
  onThemeToggle(): void;
  onNewTask(): void;
}

export function Sider({ theme, onThemeToggle, onNewTask }: SiderProps) {
  const [active, setActive] = useState<NavKey>('chat');

  return (
    <nav className="sider" aria-label="工作台导航">
      <div className="sider-brand">
        <div className="sider-brand-mark" aria-hidden="true">AW</div>
        <div className="sider-brand-copy">
          <div className="sider-brand-name">AI Work OS</div>
          <div className="sider-brand-subtitle">个人本地工作台</div>
        </div>
      </div>
      <button className="sider-new-task" onClick={onNewTask} type="button"><span aria-hidden="true">＋</span> 新建任务</button>
      <div className="sider-section-label">工作区</div>
      <div className="sider-nav">
        {NAV.map((item) => (
          <button
            aria-current={active === item.key ? 'page' : undefined}
            className={`sider-item${active === item.key ? ' active' : ''}`}
            key={item.key}
            onClick={() => setActive(item.key)}
            title={item.description}
            type="button"
          >
            <span className="sider-icon" aria-hidden="true">{item.icon}</span>
            <span className="sider-label">{item.label}</span>
          </button>
        ))}
      </div>
      <div className="sider-spacer" />
      <div className="sider-workspace">
        <div className="sider-workspace-indicator" aria-hidden="true" />
        <div>
          <div className="sider-workspace-name">b07-build</div>
          <div className="sider-workspace-meta">本地优先 · 受控执行</div>
        </div>
      </div>
      <div className="sider-footer">
        <span>石墨主题</span>
        <button
          aria-label={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
          aria-pressed={theme === 'dark'}
          className={`theme-switch${theme === 'dark' ? ' active' : ''}`}
          onClick={onThemeToggle}
          type="button"
        >
          <span />
        </button>
      </div>
    </nav>
  );
}
