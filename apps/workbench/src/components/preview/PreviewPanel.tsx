// apps/workbench/src/components/preview/PreviewPanel.tsx
// 一个文件=一个作用：宿主级持久预览面板（参照 AionUi Preview/PreviewPanel + PreviewTabs；多 Tab 路由）
import { useState } from 'react';

type ViewKey = 'markdown' | 'pdf' | 'html';

const TABS: { key: ViewKey; label: string }[] = [
  { key: 'markdown', label: 'Markdown' },
  { key: 'pdf', label: 'PDF' },
  { key: 'html', label: 'HTML' },
];

export function PreviewPanel() {
  const [active, setActive] = useState<ViewKey>('markdown');

  return (
    <aside
      style={{
        borderTop: '1px solid #e5e7eb',
        height: 180,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', gap: 4, padding: '6px 8px', borderBottom: '1px solid #e5e7eb' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            style={{
              border: 'none',
              borderRadius: 6,
              padding: '4px 10px',
              cursor: 'pointer',
              background: active === t.key ? '#eef2ff' : 'transparent',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12, fontSize: 13, color: '#6b7280' }}>
        {/* viewer 占位：真实实现按 Tab 挂载对应 viewer（MarkdownViewer/PDFViewer/HTMLViewer） */}
        [{active} viewer 面板 — 产物可编辑/可预览]
      </div>
    </aside>
  );
}
