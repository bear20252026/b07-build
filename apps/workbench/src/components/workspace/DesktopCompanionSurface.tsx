import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { directProviderClient } from '../../runtime/direct-provider-client';
import { ProceduralCompanionStage } from '../observability/ProceduralCompanionStage';

type StoredSelection = { providerId: string; model?: string };

function loadSelection(): StoredSelection | undefined {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem('awo.direct-provider.selection.v1') ?? 'null');
    if (!value || typeof value !== 'object') return undefined;
    const selection = value as Partial<StoredSelection>;
    return typeof selection.providerId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selection.providerId) && (selection.model === undefined || typeof selection.model === 'string') ? { providerId: selection.providerId, ...(selection.model ? { model: selection.model } : {}) } : undefined;
  } catch { return undefined; }
}

/** Windows 专属独立角色窗口：主窗口隐藏后仍可用已明确选择的直接 Provider 流式对话。 */
export function DesktopCompanionSurface() {
  const selection = useMemo(loadSelection, []);
  const [draft, setDraft] = useState('');
  const [output, setOutput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const restoreWorkbench = (): void => { void invoke('close_desktop_companion'); };
  const hideDesktopPet = (): void => { void invoke('hide_desktop_companion'); };
  const exitApplication = (): void => { void invoke('exit_ai_work_os'); };
  const send = (): void => {
    if (!selection || !draft.trim() || pending) return;
    setPending(true); setOutput(''); setError(undefined);
    void directProviderClient.stream({ providerId: selection.providerId, messages: [{ role: 'user', content: draft }], model: selection.model, onText: (text) => setOutput((current) => current + text) })
      .catch((nextError: unknown) => setError(nextError instanceof Error ? nextError.message : '第三方模型未完成响应。'))
      .finally(() => setPending(false));
  };
  return <main data-tauri-drag-region style={{ width: '100vw', height: '100vh', padding: 10, overflow: 'hidden', background: 'transparent', cursor: 'grab', userSelect: 'none' }}>
    <section data-tauri-drag-region style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', border: '1px solid rgba(121, 183, 237, .45)', borderRadius: 22, background: 'radial-gradient(circle at 50% 24%, rgba(131, 199, 245, .3), transparent 40%), rgba(237, 248, 255, .9)', boxShadow: '0 12px 32px rgba(35, 75, 113, .24)' }}>
      <ProceduralCompanionStage enabled />
      <span data-tauri-drag-region style={{ position: 'absolute', left: 10, top: 10, padding: '4px 6px', borderRadius: 999, color: '#456176', background: 'rgba(255,255,255,.72)', fontSize: 8, fontWeight: 800, letterSpacing: '.08em' }}>ORBIT · DESKTOP</span>
      <div style={{ position: 'absolute', right: 9, top: 9, display: 'flex', gap: 4 }}><button onClick={hideDesktopPet} style={{ minHeight: 25, padding: '0 7px', border: '1px solid rgba(69, 97, 118, .22)', borderRadius: 8, color: '#355268', background: 'rgba(255,255,255,.76)', fontSize: 9, fontWeight: 750 }} title="隐藏桌面宠物，不影响工作台、聊天或连接。" type="button">隐藏</button><button onClick={restoreWorkbench} style={{ minHeight: 25, padding: '0 7px', border: '1px solid rgba(69, 97, 118, .22)', borderRadius: 8, color: '#355268', background: 'rgba(255,255,255,.76)', fontSize: 9, fontWeight: 750 }} title="聚焦工作台并隐藏桌面宠物。" type="button">工作台</button><button onClick={exitApplication} style={{ minHeight: 25, padding: '0 7px', border: '1px solid rgba(119, 54, 54, .18)', borderRadius: 8, color: '#873f3f', background: 'rgba(255,255,255,.76)', fontSize: 9, fontWeight: 750 }} title="退出 NOVA。" type="button">退出</button></div>
      <div style={{ position: 'absolute', left: 12, right: 12, bottom: 12, display: 'grid', gap: 6 }}>
        {selection ? <><div style={{ maxHeight: 92, overflow: 'auto', padding: '7px 8px', borderRadius: 10, color: '#355268', background: 'rgba(255,255,255,.72)', fontSize: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{output || (pending ? '正在接收模型文本…' : `已选择 ${selection.model ?? selection.providerId}，可以直接发送消息。`)}</div><div style={{ display: 'flex', gap: 5 }}><input aria-label="向桌面助手发送消息" value={draft} maxLength={24000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); send(); } }} placeholder="对桌面助手说点什么…" style={{ minWidth: 0, flex: 1, padding: '7px 8px', border: '1px solid rgba(69,97,118,.22)', borderRadius: 9, background: 'rgba(255,255,255,.88)', fontSize: 10 }} /><button type="button" onClick={send} disabled={!draft.trim() || pending} style={{ padding: '0 9px', border: 0, borderRadius: 9, color: '#fff', background: '#2879c8', fontSize: 10, fontWeight: 750 }}>{pending ? '…' : '发送'}</button></div></> : <button type="button" onClick={restoreWorkbench} style={{ padding: '8px', border: '1px solid rgba(69,97,118,.22)', borderRadius: 10, color: '#355268', background: 'rgba(255,255,255,.82)', fontSize: 10 }}>请先在工作台连接并选择一个任务模型</button>}
        {error && <span style={{ color: '#9b3845', fontSize: 9 }}>{error}</span>}
      </div>
    </section>
  </main>;
}
