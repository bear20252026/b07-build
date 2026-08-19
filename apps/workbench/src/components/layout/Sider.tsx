// apps/workbench/src/components/layout/Sider.tsx
// 一个文件=一个作用：可折叠导航栏（参照 AionUi Sider/SiderItem；纯展示+发意图，不碰业务）
import { useState } from 'react';

type NavKey = 'chat' | 'files' | 'cron' | 'settings';

const NAV: { key: NavKey; label: string; icon: string }[] = [
  { key: 'chat', label: '会话', icon: '💬' },
  { key: 'files', label: '文件', icon: '📁' },
  { key: 'cron', label: '定时', icon: '⏰' },
  { key: 'settings', label: '设置', icon: '⚙️' },
];

export function Sider() {
  const [collapsed, setCollapsed] = useState(false);
  const [active, setActive] = useState<NavKey>('chat');

  return (
    <nav
      style={{
        width: collapsed ? 56 : 160,
        borderRight: '1px solid #e5e7eb',
        padding: 8,
        transition: 'width .15s',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <button onClick={() => setCollapsed((c) => !c)} style={{ marginBottom: 8 }}>
        {collapsed ? '»' : '« 折叠'}
      </button>
      {NAV.map((n) => (
        <button
          key={n.key}
          onClick={() => setActive(n.key)}
          style={{
            textAlign: 'left',
            background: active === n.key ? '#eef2ff' : 'transparent',
            border: 'none',
            borderRadius: 6,
            padding: '6px 8px',
            cursor: 'pointer',
          }}
          title={n.label}
        >
          {n.icon} {collapsed ? '' : n.label}
        </button>
      ))}
    </nav>
  );
}
