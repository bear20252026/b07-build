import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { CompanionPreferencesV1 } from '../../runtime/companion-preferences';
import type { FloatingCompanionPreferencesV1, FloatingCompanionRoute } from '../../runtime/floating-companion-preferences';
import { ProceduralCompanionStage } from '../observability/ProceduralCompanionStage';

type Position = Readonly<{ x: number; y: number }>;
const clamp = (value: number): number => Math.min(94, Math.max(6, value));

/** 应用内正式展示层；不取代 Companion 设置页，也不调用 Provider、桌面自动化或 TTS。 */
export function HomeFloatingCompanion({ desktopCompanionAvailable, preferences, presentation, onOpenDesktopCompanion, onOpenSettings, onPresentationChange }: {
  desktopCompanionAvailable: boolean;
  preferences: CompanionPreferencesV1;
  presentation: FloatingCompanionPreferencesV1;
  onOpenDesktopCompanion(): void;
  onOpenSettings(): void;
  onPresentationChange(next: FloatingCompanionPreferencesV1): void;
}) {
  const [position, setPosition] = useState<Position>({ x: presentation.x, y: presentation.y });
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef<Position>();
  useEffect(() => { if (!dragging) setPosition({ x: presentation.x, y: presentation.y }); }, [presentation.x, presentation.y, dragging]);
  useEffect(() => {
    if (presentation.route === 'still' || dragging) return;
    let frame = 0;
    const started = performance.now();
    const animate = (now: number): void => {
      const time = (now - started) / 1000;
      const offset = presentation.route === 'harbor'
        ? { x: Math.sin(time * 0.52) * 4.4, y: Math.sin(time * 1.04) * 1.35 }
        : { x: Math.cos(time * 0.5) * 4.2, y: Math.sin(time * 0.5) * 3.1 };
      setPosition({ x: clamp(presentation.x + offset.x), y: clamp(presentation.y + offset.y) });
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [dragging, presentation.route, presentation.x, presentation.y]);

  if (!preferences.visualEnabled) return null;
  const commit = (next: Position, route: FloatingCompanionRoute): void => onPresentationChange({ schemaVersion: 1, x: Math.round(next.x * 10) / 10, y: Math.round(next.y * 10) / 10, route });
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOffset.current = { x: event.clientX / window.innerWidth * 100 - position.x, y: event.clientY / window.innerHeight * 100 - position.y };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!dragging || !dragOffset.current) return;
    setPosition({ x: clamp(event.clientX / window.innerWidth * 100 - dragOffset.current.x), y: clamp(event.clientY / window.innerHeight * 100 - dragOffset.current.y) });
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false); dragOffset.current = undefined; commit(position, 'still');
  };
  const shellStyle: CSSProperties = { position: 'fixed', zIndex: 40, left: `${position.x}%`, top: `${position.y}%`, width: 116, transform: 'translate(-50%, -50%)', touchAction: 'none', userSelect: 'none' };
  const stageStyle: CSSProperties = { position: 'relative', display: 'block', width: 108, height: 108, margin: '0 auto', padding: 0, overflow: 'hidden', border: '1px solid color-mix(in srgb, var(--accent) 24%, var(--border))', borderRadius: 18, background: 'linear-gradient(145deg, color-mix(in srgb, var(--accent-soft) 54%, var(--panel)), var(--panel))', boxShadow: '0 10px 26px color-mix(in srgb, var(--shadow) 18%, transparent)', cursor: dragging ? 'grabbing' : 'grab' };
  const tagStyle: CSSProperties = { position: 'absolute', right: 6, bottom: 6, padding: '3px 5px', borderRadius: 999, color: 'var(--muted-strong)', background: 'color-mix(in srgb, var(--panel) 86%, transparent)', fontSize: 7, fontWeight: 800, letterSpacing: '.06em' };
  const controlStyle: CSSProperties = { display: 'flex', gap: 4, justifyContent: 'center', marginTop: 5, padding: 4, borderRadius: 10, background: 'color-mix(in srgb, var(--panel) 90%, transparent)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-soft)' };
  const buttonStyle: CSSProperties = { minHeight: 24, padding: '0 6px', border: 0, borderRadius: 7, background: 'transparent', color: 'var(--muted-strong)', fontSize: 9, fontWeight: 750 };
  return <aside aria-label="首页浮动 Companion" className="home-floating-companion" style={shellStyle}>
    <button aria-label="拖动 3D Companion；支持鼠标、触控与触控笔。拖动后会静止在当前位置。" className={`home-floating-companion-stage${dragging ? ' dragging' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} style={stageStyle} title="拖动角色移动；拖动结束后切换为静止。" type="button">
      <ProceduralCompanionStage compact enabled />
      <span className="home-floating-companion-tag" style={tagStyle}>ORBIT · {presentation.route === 'still' ? '静止' : presentation.route === 'harbor' ? '漫步' : '环绕'}</span>
    </button>
    <div aria-label="角色路线控制" className="home-floating-companion-controls" style={controlStyle}>
      <button aria-pressed={presentation.route === 'still'} onClick={() => commit(position, 'still')} style={buttonStyle} title="让角色静止在当前位置。" type="button">静止</button>
      <button aria-pressed={presentation.route === 'harbor'} onClick={() => commit(position, 'harbor')} style={buttonStyle} title="让角色沿港湾路线在应用内缓慢漫步。" type="button">漫步</button>
      <button aria-pressed={presentation.route === 'orbit'} onClick={() => commit(position, 'orbit')} style={buttonStyle} title="让角色沿环绕路线在应用内移动。" type="button">环绕</button>
      <button onClick={onOpenSettings} style={buttonStyle} title="打开现有 Companion 设置页；配置不会堆在首页。" type="button">设置</button>
      {desktopCompanionAvailable && <button onClick={onOpenDesktopCompanion} style={buttonStyle} title="显式打开 Windows 原生桌面 Companion；主工作台会隐藏而不会退出。" type="button">留在桌面</button>}
    </div>
  </aside>;
}
