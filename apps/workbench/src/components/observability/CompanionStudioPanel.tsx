import type { CompanionBodyModule, CompanionServiceSource, CompanionStudioPreferencesV1, CompanionStudioSection } from '../../runtime/companion-studio-preferences';

const serviceDetails: readonly { id: CompanionServiceSource; title: string; detail: string; runtime: string }[] = [
  { id: 'chat', title: 'Chat', detail: '对话服务来源；复用已审核 Provider 与显式任务调用链。', runtime: '使用“模型连接”中已启用 Provider' },
  { id: 'speech', title: 'Speech', detail: '语音输出服务来源；MiMo TTS 仅支持明确试听与播放。', runtime: '需在 Companion 页面单独开启 TTS' },
  { id: 'transcription', title: 'Transcription', detail: '语音转写服务来源；不会因配置而开启麦克风。', runtime: '等待单独采集权限与 Provider 适配' },
  { id: 'artistry', title: 'Artistry', detail: '视觉/艺术生成服务来源；与角色资产导入保持分离。', runtime: '等待已审核图像 Provider 适配' },
];
const moduleDetails: readonly { id: CompanionBodyModule; title: string; detail: string; runtime: string }[] = [
  { id: 'consciousness', title: '意识', detail: '受控任务和 Agent 上下文投影。', runtime: '不拥有独立管理员或工具权限' },
  { id: 'voice', title: '发声', detail: '通过显式 TTS 试听输出。', runtime: '默认不说话' },
  { id: 'hearing', title: '听觉', detail: '转写模块配置位。', runtime: '麦克风采集仍严格关闭' },
  { id: 'vision', title: '视觉', detail: '视觉理解模块配置位。', runtime: '屏幕捕获仍严格关闭' },
  { id: 'memory', title: '记忆', detail: '会话历史与可审查记忆适配位。', runtime: '当前不导入未知 CINDL 依赖' },
  { id: 'discord', title: 'Discord', detail: '外部频道模块配置位。', runtime: '未连接、未接收消息、未后台运行' },
  { id: 'minecraft', title: 'Minecraft', detail: '游戏集成模块配置位。', runtime: '未连接、未控制游戏' },
  { id: 'factorio', title: 'Factorio', detail: '游戏集成模块配置位。', runtime: '未连接、未控制游戏' },
  { id: 'mcp', title: 'MCP', detail: '现有受控 MCP 注册表的 Companion 投影。', runtime: '仍需单独登记、审核与启用' },
];
const sectionMeta: Record<CompanionStudioSection, { eyebrow: string; title: string; description: string }> = {
  'service-sources': { eyebrow: 'COMPANION / SERVICE SOURCES', title: '服务来源', description: '添加或编辑 Chat、Speech、Transcription 与 Artistry 服务来源。每个入口只投影配置状态，不持有 API key。' },
  'body-modules': { eyebrow: 'COMPANION / BODY MODULES', title: '机体模块', description: '为意识、发声、听觉、视觉、记忆、Discord、Minecraft、Factorio 与 MCP 管理模块开关。配置不等于授予外部执行权限。' },
  'character-models': { eyebrow: 'COMPANION / CHARACTER MODELS', title: '角色模型', description: '切换 Live2D 与 VRM 舞台插槽。导入资产必须经过单独来源、版权、大小和本机扫描流程。' },
  'character-cards': { eyebrow: 'COMPANION / CHARACTER CARDS', title: 'AIRI 角色卡', description: '选择当前角色卡；角色卡只包含显示身份和呈现偏好，不携带密钥、系统提示词、工具或高影响权限。' },
  'companion-system': { eyebrow: 'COMPANION / SYSTEM', title: '系统', description: '管理语言、主题、数据分析偏好与 Windows 桌面端专用选项；网页和移动端仅复用可跨平台的偏好。' },
};

export function CompanionStudioSummary({ preferences, onOpen }: { preferences: CompanionStudioPreferencesV1; onOpen(section: CompanionStudioSection): void }) {
  return <section className="companion-studio-summary"><div><span className="panel-eyebrow">AIRI-STYLE COMPANION STUDIO</span><h2>角色与模块工作室</h2><p>服务来源、机体模块、模型、角色卡与系统设置都保持在三级页面。默认登记为启用；任何模块均可独立关闭。</p></div><div className="companion-studio-summary-grid"><button onClick={() => onOpen('service-sources')} type="button"><strong>服务来源</strong><small>{Object.values(preferences.services).filter(Boolean).length}/4 已配置</small></button><button onClick={() => onOpen('body-modules')} type="button"><strong>机体模块</strong><small>{Object.values(preferences.modules).filter(Boolean).length}/9 已配置</small></button><button onClick={() => onOpen('character-models')} type="button"><strong>角色模型</strong><small>Live2D / VRM</small></button><button onClick={() => onOpen('character-cards')} type="button"><strong>角色卡</strong><small>当前：{preferences.activeCharacterCardId}</small></button><button onClick={() => onOpen('companion-system')} type="button"><strong>系统</strong><small>桌面常驻：{preferences.desktopResidencyMode === 'disabled' ? '关闭' : 'Windows 原生'}</small></button></div></section>;
}

export function CompanionStudioPage({ preferences, section, onBack, onUpdate }: { preferences: CompanionStudioPreferencesV1; section: CompanionStudioSection; onBack(): void; onUpdate(change: Partial<CompanionStudioPreferencesV1>): void }) {
  const meta = sectionMeta[section];
  const toggleService = (id: CompanionServiceSource): void => onUpdate({ services: { ...preferences.services, [id]: !preferences.services[id] } });
  const toggleModule = (id: CompanionBodyModule): void => onUpdate({ modules: { ...preferences.modules, [id]: !preferences.modules[id] } });
  return <section className="page-stack companion-studio-page"><div className="page-heading companion-page-heading"><div><span>{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.description}</p></div><button onClick={onBack} title="返回 Companion Agent 三级页。" type="button">← 返回 Companion Agent</button></div>
    {section === 'service-sources' && <section className="companion-studio-list">{serviceDetails.map((item) => <article key={item.id}><div><h2>{item.title}</h2><p>{item.detail}</p><small>{item.runtime}</small></div><label className="companion-switch"><input aria-label={`启用 ${item.title} 服务来源`} checked={preferences.services[item.id]} onChange={() => toggleService(item.id)} type="checkbox" /><span aria-hidden="true" /><strong>{preferences.services[item.id] ? '已配置' : '已关闭'}</strong></label></article>)}</section>}
    {section === 'body-modules' && <section className="companion-studio-list companion-module-list">{moduleDetails.map((item) => <article key={item.id}><div><h2>{item.title}</h2><p>{item.detail}</p><small>{item.runtime}</small></div><label className="companion-switch"><input aria-label={`启用 ${item.title} 模块`} checked={preferences.modules[item.id]} onChange={() => toggleModule(item.id)} type="checkbox" /><span aria-hidden="true" /><strong>{preferences.modules[item.id] ? '已配置' : '已关闭'}</strong></label></article>)}</section>}
    {section === 'character-models' && <section className="companion-studio-list"><article><div><h2>Live2D 模型插槽</h2><p>保留 AIRI 风格的二维模型选择能力；当前现有 2D 动态玩偶继续可用。</p><small>自定义导入需要独立版权和资产审查，尚未读取用户文件。</small></div><label className="companion-switch"><input aria-label="启用 Live2D 模型插槽" checked={preferences.modelSlots.live2d} onChange={() => onUpdate({ modelSlots: { ...preferences.modelSlots, live2d: !preferences.modelSlots.live2d } })} type="checkbox" /><span aria-hidden="true" /><strong>{preferences.modelSlots.live2d ? '已配置' : '已关闭'}</strong></label></article><article><div><h2>VRM 模型插槽</h2><p>VRM 舞台默认选择；实际模型仅能从已审核的本地资产清单按需加载。</p><small>不会从网络下载模型，也不会加载未经来源验证的资产。</small></div><label className="companion-switch"><input aria-label="启用 VRM 模型插槽" checked={preferences.modelSlots.vrm} onChange={() => onUpdate({ modelSlots: { ...preferences.modelSlots, vrm: !preferences.modelSlots.vrm } })} type="checkbox" /><span aria-hidden="true" /><strong>{preferences.modelSlots.vrm ? '已配置' : '已关闭'}</strong></label></article></section>}
    {section === 'character-cards' && <section className="companion-card-grid">{(['orbit', 'mori', 'pixel', 'sage'] as const).map((id) => <button aria-pressed={preferences.activeCharacterCardId === id} className={preferences.activeCharacterCardId === id ? 'active' : ''} key={id} onClick={() => onUpdate({ activeCharacterCardId: id })} type="button"><span>角色卡</span><strong>{id}</strong><small>{preferences.activeCharacterCardId === id ? '当前角色卡' : '选择此角色卡'}</small></button>)}</section>}
    {section === 'companion-system' && <section className="companion-studio-list"><article><div><h2>语言与主题</h2><p>沿用 Workbench 的语言与浅色/深色主题设置，避免为角色创建不一致的独立主题。</p><small>可以从全局界面立即调整。</small></div></article><article><div><h2>数据分析偏好</h2><p>角色不会分析或上传数据；可观测性仍位于现有只读审计页。</p><small>不记录 TTS 音频、API key 或完整聊天输入。</small></div></article><article><div><h2>Windows 桌面角色常驻</h2><p>默认关闭。启用后可从首页浮动角色的“留在桌面”显式显示独立、透明且置顶的原生宠物窗口；工作台、聊天、搜索和产物面不会被隐藏或接管。</p><small>宠物窗口可单独隐藏；仅 Windows 桌面壳可用，网页、平板和手机仍只使用应用内展示层。</small></div><label className="companion-switch"><input aria-label="启用 Windows 角色常驻模式" checked={preferences.desktopResidencyMode !== 'disabled'} onChange={(event) => onUpdate({ desktopResidencyMode: event.target.checked ? 'windows-native' : 'disabled' })} type="checkbox" /><span aria-hidden="true" /><strong>{preferences.desktopResidencyMode === 'disabled' ? '默认关闭' : 'Windows 原生'}</strong></label></article></section>}
  </section>;
}
