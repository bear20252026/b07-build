import type { ReactNode } from 'react';

/**
 * 单内容三级 Inspector。每个低频页面独立打开；主工作区与其侧栏只作为背景保留，
 * 不再把第二套导航塞入悬浮窗口。
 */
export function SettingsOverlay({ children, onClose, title }: {
  children: ReactNode;
  onClose(): void;
  title: string;
}) {
  return <div aria-label={`${title} 浮层遮罩`} className="settings-overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
    <section aria-describedby="settings-overlay-description" aria-label={title} aria-modal="true" className="settings-overlay settings-overlay--single" onMouseDown={(event) => event.stopPropagation()} role="dialog">
      <header className="settings-overlay-titlebar"><div><span>AI WORK OS / INSPECTOR</span><h1>{title}</h1><p id="settings-overlay-description">独立工作面。配置只在你明确提交时生效；关闭窗口会回到当前工作区。</p></div><button aria-label={`关闭${title}`} className="settings-overlay-close" onClick={onClose} title="关闭悬浮面板并返回当前工作区。" type="button">×</button></header>
      <div className="settings-overlay-content">{children}</div>
    </section>
  </div>;
}
