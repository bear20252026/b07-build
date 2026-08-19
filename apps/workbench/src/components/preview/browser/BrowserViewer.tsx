// apps/workbench/src/components/preview/browser/BrowserViewer.tsx
// 一个文件=一个作用：单 active tab 浏览器桥（参照 AionUi BrowserViewer/BrowserTabLayer；
// 安全=单 target + OS 端口 + token，不暴露整个 Chromium 进程）
export function BrowserViewer({ url }: { url: string | null }) {
  if (!url) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: '#9ca3af' }}>
        浏览器未激活 — 仅允许当前 active tab（单 target 安全策略）
      </div>
    );
  }
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 8px', fontSize: 12, color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
        🔒 active tab: {url}
      </div>
      <iframe src={url} title="awo-active-tab" style={{ flex: 1, border: 'none' }} />
    </div>
  );
}
