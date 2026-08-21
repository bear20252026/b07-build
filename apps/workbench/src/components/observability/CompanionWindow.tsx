import type { CompanionPreferencesV1 } from '../../runtime/companion-preferences';
import { ProceduralCompanionStage } from './ProceduralCompanionStage';

export function CompanionWindow({ gatewayAttached, preferences, onOpenApi, onOpenControls }: {
  gatewayAttached: boolean;
  preferences: CompanionPreferencesV1;
  onOpenApi(): void;
  onOpenControls(): void;
}) {
  const voiceStatus = !preferences.voiceEnabled
    ? '语音输出关闭'
    : gatewayAttached
      ? '等待一次明确试听'
      : '需要先连接 MiMo TTS';
  const visualStatus = !preferences.visualEnabled
    ? '角色呈现关闭'
    : preferences.visualMode === 'three-dimensional'
      ? '程序化 3D 可见 · VRM 待导入'
      : '程序化 3D 可见';

  return <section className="companion-window" aria-label="Companion 独立窗口">
    <div className="companion-window-stage" aria-label={visualStatus}>
      <div className="companion-window-halo" aria-hidden="true" />
      <ProceduralCompanionStage enabled={preferences.visualEnabled} />
      <span className="companion-window-status"><i aria-hidden="true" />{preferences.visualEnabled ? 'PRESENT' : 'OFFLINE'}</span>
    </div>
    <div className="companion-window-summary">
      <span className="panel-eyebrow">COMPANION / SEPARATE SURFACE</span>
      <h2>{preferences.visualEnabled ? 'Orbit · 角色窗口' : 'Companion 已关闭'}</h2>
      <p>{preferences.visualEnabled ? '这是独立于对话和 API 配置的角色工作面。当前可见的是本地程序化 CSS 3D Companion；没有已审查 VRM 资产时不会将其误称为 VRM 人物。' : '角色窗口已关闭；任务、对话和已连接模型不会受影响。'}</p>
      <div className="companion-window-metrics"><span><b>视觉</b>{visualStatus}</span><span><b>MiMo TTS</b>{voiceStatus}</span></div>
    </div>
    <div className="companion-window-actions">
      <button className="companion-window-secondary" onClick={onOpenApi} title="打开独立 API 连接浮层；连接操作只在用户明确提交时发生。" type="button">配置语音 API</button>
      <button className="companion-window-primary" onClick={onOpenControls} title="打开角色控制三级页面，管理 2D/VRM、角色卡和受控语音。" type="button">角色控制</button>
    </div>
    <p className="companion-window-boundary">不会自动使用麦克风、读取屏幕、控制桌面或在后台说话。</p>
  </section>;
}
