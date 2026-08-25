import { useEffect, type ReactNode } from 'react';

export type WorkbenchOverlayTone = 'api' | 'artifacts' | 'companion';

export function WorkbenchOverlay({ children, description, onClose, title, tone }: {
  children: ReactNode;
  description: string;
  onClose(): void;
  title: string;
  tone: WorkbenchOverlayTone;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return <div aria-label={`${title} 浮层遮罩`} className="workbench-overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} role="presentation">
    <section aria-describedby="workbench-overlay-description" aria-label={title} aria-modal="true" className={`workbench-overlay workbench-overlay--${tone}`} onMouseDown={(event) => event.stopPropagation()} role="dialog">
      <header className="workbench-overlay-titlebar">
        <div><span>NOVA / INSPECTOR</span><h1>{title}</h1><p id="workbench-overlay-description">{description}</p></div>
        <button aria-label={`关闭${title}`} className="workbench-overlay-close" onClick={onClose} title="关闭悬浮面板并返回当前工作面。" type="button">×</button>
      </header>
      <div className="workbench-overlay-content">{children}</div>
    </section>
  </div>;
}
