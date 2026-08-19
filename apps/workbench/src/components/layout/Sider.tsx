// 一个文件=一种作用：AionUi 风格侧栏导航（纯展示与本地导航状态）。
import { useState } from 'react';

type NavKey = 'chat' | 'files' | 'schedule' | 'settings';

const NAV: { key: NavKey; label: string; icon: string }[] = [
  { key: 'chat', label: '任务会话', icon: '◇' },
  { key: 'files', label: '产物与文件', icon: '▣' },
  { key: 'schedule', label: '计划任务', icon: '◷' },
  { key: 'settings', label: '工作区设置', icon: '⚙' },
];

export function Sider() {
  const [active, setActive] = useState<NavKey>('chat');

  return (
    <nav className="sider" aria-label="工作台导航">
      <div className="sider-brand">
        <div className="sider-brand-mark" aria-hidden="true">AW</div>
        <div className="sider-brand-copy">
          <div className="sider-brand-name">AI Work OS</div>
          <div className="sider-brand-subtitle">Outcome workspace</div>
        </div>
      </div>
      <button className="sider-new-task" type="button">+ 新建任务</button>
      <div className="sider-section-label">Workspace</div>
      <div className="sider-nav">
        {NAV.map((item) => (
          <button
            className={`sider-item${active === item.key ? ' active' : ''}`}
            key={item.key}
            onClick={() => setActive(item.key)}
            title={item.label}
            type="button"
          >
            <span className="sider-icon" aria-hidden="true">{item.icon}</span>
            <span className="sider-label">{item.label}</span>
          </button>
        ))}
      </div>
      <div className="sider-spacer" />
      <div className="sider-workspace">
        <div className="sider-workspace-name">b07-build</div>
        <div className="sider-workspace-meta">本地优先 · 受控执行</div>
      </div>
    </nav>
  );
}
