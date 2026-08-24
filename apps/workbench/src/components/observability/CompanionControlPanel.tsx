import { useRef, useState } from 'react';
import type { CompanionPreferencesV1 } from '../../runtime/companion-preferences';
import { HttpMimoTtsClient } from '../../runtime/mimo-tts-client';

const ttsClient = new HttpMimoTtsClient();

function visualModeLabel(mode: CompanionPreferencesV1['visualMode']): string {
  return mode === 'three-dimensional' ? '3D 舞台请求（模型未导入）' : '2D 动态玩偶';
}

export function CompanionSummaryCard({ preferences, onOpen }: { preferences: CompanionPreferencesV1; onOpen: () => void }) {
  return <section className="companion-summary-card" aria-label="Companion Agent 摘要">
    <div className="companion-summary-heading"><div><span className="panel-eyebrow">COMPANION AGENT</span><h2>桌面角色</h2><p>3D 舞台请求默认开启，但尚无已导入 VRM 模型；当前可见呈现始终回退到现有 2D 动态玩偶。</p></div><span className={`companion-state-pill${preferences.visualEnabled ? ' enabled' : ' disabled'}`}>{preferences.visualEnabled ? '视觉已启用' : '视觉已关闭'}</span></div>
    <div className="companion-summary-metrics"><div><span>当前可见</span><strong>{preferences.visualEnabled ? '2D 动态玩偶（VRM 待导入）' : '完全关闭'}</strong></div><div><span>语音</span><strong>{preferences.voiceEnabled ? '已单独启用' : '默认关闭'}</strong></div><div><span>高影响能力</span><strong>全部关闭</strong></div></div>
    <div className="companion-safety-note"><strong>默认边界</strong><span>麦克风、屏幕捕获、桌面自动化、游戏控制和后台服务均保持关闭。进入三级页面后可查看且只能按能力分别调整。</span></div>
    <button className="companion-open" onClick={onOpen} title="进入三级 Companion Agent 页面，选择 2D/3D 呈现、关闭角色或审查独立语音能力。" type="button">打开角色控制 <span aria-hidden="true">→</span></button>
  </section>;
}

export function CompanionControlPage({ gatewayAttached, preferences, onBack, onUpdate }: {
  gatewayAttached: boolean;
  preferences: CompanionPreferencesV1;
  onBack: () => void;
  onUpdate(change: Partial<Pick<CompanionPreferencesV1, 'visualEnabled' | 'visualMode' | 'voiceEnabled' | 'proactiveSpeechEnabled'>>): void;
}) {
  const [ttsText, setTtsText] = useState('你好，我是你的 NOVA Companion。');
  const [ttsVoice, setTtsVoice] = useState('mimo_default');
  const [ttsPending, setTtsPending] = useState(false);
  const [ttsStatus, setTtsStatus] = useState<string>();
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const visualStatus = preferences.visualEnabled ? visualModeLabel(preferences.visualMode) : '角色已完全关闭';
  const previewVoice = (): void => {
    if (!gatewayAttached || !preferences.voiceEnabled || ttsPending) return;
    setTtsPending(true); setTtsStatus(undefined);
    void ttsClient.preview({ text: ttsText, voice: ttsVoice }).then((preview) => {
      audioRef.current?.pause();
      const audio = new Audio(`data:${preview.audioMime};base64,${preview.audioBase64}`);
      audioRef.current = audio;
      return audio.play().then(() => setTtsStatus(`正在播放一次性试听 · ${preview.voice} · ${preview.audioBytes} bytes`));
    }).catch((error: unknown) => setTtsStatus(error instanceof Error ? error.message : 'Companion TTS 试听未完成。')).finally(() => setTtsPending(false));
  };
  return <section className="page-stack companion-control-page"><div className="page-heading companion-page-heading"><div><span>CAPABILITIES / COMPANION</span><h1>Companion Agent</h1><p>三级设置页。3D 角色默认作为本地视觉能力启用；关闭后不会加载角色舞台。语音与其它能力独立于角色视觉开关。</p></div><button title="返回二级扩展与能力页面。" onClick={onBack} type="button">← 返回扩展与能力</button></div>
    <section className="companion-control-hero"><div><span className="panel-eyebrow">VISUAL PRESENCE</span><h2>{preferences.visualEnabled && preferences.visualMode === 'three-dimensional' ? 'VRM 模型尚未导入' : visualStatus}</h2><p>{preferences.visualEnabled ? '当前没有可渲染的 VRM 资产，因此不会假装显示 3D 人物；工作台改用已有 2D 动态玩偶。导入经过来源与许可证审查的本地模型后才会显示真实 3D 角色。' : '角色视觉已完全关闭。现有任务、Provider、文件、审计和设置功能不会受到影响。'}</p></div><label className="companion-switch"><input aria-label="启用 Companion 角色视觉" checked={preferences.visualEnabled} onChange={(event) => onUpdate({ visualEnabled: event.target.checked })} type="checkbox" /><span aria-hidden="true" /><strong>{preferences.visualEnabled ? '角色已开启' : '角色已关闭'}</strong></label></section>
    <section className="companion-visual-settings"><div><span className="panel-eyebrow">RENDERER</span><h2>角色呈现方式</h2><p>2D 与 3D 共用受控角色状态；切换只影响界面呈现，不会切换 Agent、模型或执行权限。</p></div><div className="companion-mode-options"><button aria-pressed={preferences.visualMode === 'three-dimensional'} className={preferences.visualMode === 'three-dimensional' ? 'active' : ''} disabled={!preferences.visualEnabled} onClick={() => onUpdate({ visualMode: 'three-dimensional' })} title="请求 3D / VRM 舞台；没有本地已审查模型时始终回退到 2D，不会伪造 3D 显示。" type="button"><span>3D</span><strong>VRM 舞台（待导入模型）</strong><small>当前无资产，使用 2D 回退呈现</small></button><button aria-pressed={preferences.visualMode === 'two-dimensional'} className={preferences.visualMode === 'two-dimensional' ? 'active' : ''} disabled={!preferences.visualEnabled} onClick={() => onUpdate({ visualMode: 'two-dimensional' })} title="保留现有 2D 动态玩偶，不会改变任务或模型。" type="button"><span>2D</span><strong>现有动态玩偶</strong><small>Orbit、Mori、Pixel、Sage 继续可用</small></button></div></section>
    <section className="companion-voice-settings"><div><span className="panel-eyebrow">VOICE / EXPLICIT</span><h2>语音与主动交谈</h2><p>MiMo V2.5 TTS 可作为后续受限 Provider。开启语音只允许用户明确测试或明确播放；不会读取麦克风，也不会自动向 Provider 发送内容。</p></div><div className="companion-permission-list"><label><span><strong>允许 TTS 语音输出</strong><small>默认关闭；需要独立 Provider 连接和每次明确播放。</small></span><input aria-label="允许 TTS 语音输出" checked={preferences.voiceEnabled} disabled={!preferences.visualEnabled} onChange={(event) => onUpdate({ voiceEnabled: event.target.checked })} type="checkbox" /></label><label><span><strong>允许主动语音提示</strong><small>默认关闭；启用前提是 TTS 输出已开启。不会开启后台服务或发送对话内容。</small></span><input aria-label="允许主动语音提示" checked={preferences.proactiveSpeechEnabled} disabled={!preferences.visualEnabled || !preferences.voiceEnabled} onChange={(event) => onUpdate({ proactiveSpeechEnabled: event.target.checked })} type="checkbox" /></label></div></section>
    {preferences.voiceEnabled && <section className="companion-tts-preview"><div><span className="panel-eyebrow">MIMO TTS / EXPLICIT PREVIEW</span><h2>一次性语音试听</h2><p>只会把此处由你明确输入的文本发给已启用的 Xiaomi MiMo 会话连接。点击按钮后才播放；不会发送对话历史、保存音频或在后台自动说话。</p></div><label>试听文本<textarea aria-label="Companion TTS 试听文本" disabled={!gatewayAttached || ttsPending} maxLength={1200} onChange={(event) => setTtsText(event.target.value)} value={ttsText} /></label><label>预置音色<select aria-label="Companion TTS 预置音色" disabled={!gatewayAttached || ttsPending} onChange={(event) => setTtsVoice(event.target.value)} value={ttsVoice}><option value="mimo_default">MiMo 默认</option><option value="冰糖">冰糖</option><option value="茉莉">茉莉</option><option value="苏打">苏打</option><option value="白桦">白桦</option><option value="Mia">Mia</option><option value="Chloe">Chloe</option><option value="Milo">Milo</option><option value="Dean">Dean</option></select></label><button disabled={!gatewayAttached || !ttsText.trim() || ttsPending} onClick={previewVoice} title="明确向已启用的 Xiaomi MiMo 会话连接发起一次语音试听；不会自动播放后续消息或保存音频。" type="button">{ttsPending ? '请求试听中…' : '明确试听并播放'}</button>{!gatewayAttached && <small>请先附着本机 Gateway，并在模型连接中显式配置 Xiaomi MiMo。</small>}{ttsStatus && <p aria-live="polite" role="status">{ttsStatus}</p>}</section>}
    <section className="companion-restricted-capabilities"><div><span className="panel-eyebrow">HIGH-IMPACT CAPABILITIES</span><h2>默认严格关闭</h2><p>这些能力不会跟随 3D 角色、语音或主动提示自动开启；它们要求未来独立的权限设计、平台实现和用户确认。</p></div><div><article><strong>麦克风输入</strong><span>关闭</span><small>不采集音频或启动语音识别。</small></article><article><strong>屏幕捕获</strong><span>关闭</span><small>不读取桌面、窗口或屏幕内容。</small></article><article><strong>桌面自动化</strong><span>关闭</span><small>不控制鼠标、键盘、应用或系统设置。</small></article><article><strong>游戏控制与后台服务</strong><span>关闭</span><small>不连接游戏、不自动启动服务、不维持后台常驻。</small></article></div></section>
  </section>;
}
