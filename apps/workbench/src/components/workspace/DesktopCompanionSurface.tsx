import { invoke } from '@tauri-apps/api/core';
import { ProceduralCompanionStage } from '../observability/ProceduralCompanionStage';

/** Windows 专属的独立角色窗口。它只呈现角色和明确退出动作，不包含聊天、API、文件或权限控制。 */
export function DesktopCompanionSurface() {
  const restoreWorkbench = (): void => { void invoke('close_desktop_companion'); };
  const exitApplication = (): void => { void invoke('exit_ai_work_os'); };
  return <main data-tauri-drag-region style={{ width: '100vw', height: '100vh', padding: 10, overflow: 'hidden', background: 'transparent', cursor: 'grab', userSelect: 'none' }}>
    <section data-tauri-drag-region style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', border: '1px solid rgba(121, 183, 237, .45)', borderRadius: 22, background: 'radial-gradient(circle at 50% 24%, rgba(131, 199, 245, .3), transparent 40%), rgba(237, 248, 255, .86)', boxShadow: '0 12px 32px rgba(35, 75, 113, .24)' }}>
      <ProceduralCompanionStage enabled />
      <span data-tauri-drag-region style={{ position: 'absolute', left: 10, top: 10, padding: '4px 6px', borderRadius: 999, color: '#456176', background: 'rgba(255,255,255,.72)', fontSize: 8, fontWeight: 800, letterSpacing: '.08em' }}>ORBIT · DESKTOP</span>
      <div style={{ position: 'absolute', right: 9, top: 9, display: 'flex', gap: 4 }}><button onClick={restoreWorkbench} style={{ minHeight: 25, padding: '0 7px', border: '1px solid rgba(69, 97, 118, .22)', borderRadius: 8, color: '#355268', background: 'rgba(255,255,255,.76)', fontSize: 9, fontWeight: 750 }} title="关闭桌面 Companion 并恢复主工作台。" type="button">恢复工作台</button><button onClick={exitApplication} style={{ minHeight: 25, padding: '0 7px', border: '1px solid rgba(119, 54, 54, .18)', borderRadius: 8, color: '#873f3f', background: 'rgba(255,255,255,.76)', fontSize: 9, fontWeight: 750 }} title="退出 AI Work OS，并停止主窗口与桌面 Companion。" type="button">退出</button></div>
    </section>
  </main>;
}
