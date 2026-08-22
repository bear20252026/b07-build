import { useMemo, useState } from 'react';
import type { WorkbenchProviderConnection } from '../../runtime/task-client';
import './ProviderSetupPage.css';

type Protocol = 'openai-compatible' | 'anthropic-compatible';

type ProviderPreset = {
  id: string;
  title: string;
  description: string;
  defaultModel: string;
};

const PRESETS: readonly ProviderPreset[] = [
  { id: 'deepseek', title: 'DeepSeek', description: '默认推荐', defaultModel: 'deepseek-v4-pro' },
  { id: 'mimo', title: 'Xiaomi MiMo（按量）', description: 'sk- 密钥', defaultModel: 'mimo-v2.5-pro' },
  { id: 'mimo-token-plan-cn', title: 'MiMo Token Plan（中国）', description: 'tp- 订阅密钥', defaultModel: 'mimo-v2.5-pro' },
  { id: 'mimo-token-plan-sgp', title: 'MiMo Token Plan（新加坡）', description: 'tp- 订阅密钥', defaultModel: 'mimo-v2.5-pro' },
  { id: 'mimo-token-plan-ams', title: 'MiMo Token Plan（欧洲）', description: 'tp- 订阅密钥', defaultModel: 'mimo-v2.5-pro' },
  { id: 'longcat', title: 'LongCat', description: '美团龙猫', defaultModel: 'LongCat-2.0' },
  { id: 'kimi', title: 'Kimi', description: 'Moonshot AI', defaultModel: 'kimi-k3' },
  { id: 'zhipu', title: '智谱 GLM', description: 'GLM 系列', defaultModel: 'glm-5.3' },
  { id: 'openai', title: 'OpenAI', description: 'Chat Completions', defaultModel: 'gpt-5.6' },
  { id: 'google-gemini', title: 'Google Gemini', description: 'OpenAI-compatible', defaultModel: 'gemini-3.7-flash' },
  { id: 'mistral', title: 'Mistral AI', description: 'OpenAI-compatible', defaultModel: 'mistral-large-latest' },
  { id: 'openrouter', title: 'OpenRouter', description: '多模型路由', defaultModel: 'openrouter/auto' },
  { id: 'anthropic', title: 'Anthropic Claude', description: 'Messages API', defaultModel: 'claude-opus-5' },
];

export interface ProviderSetupPageProps {
  gatewayAttached: boolean;
  attachingGateway: boolean;
  gatewayError?: string;
  connections?: readonly WorkbenchProviderConnection[];
  error?: string;
  pendingProviderId?: string;
  onAttach(): void;
  onDetach(): void;
  onConfigure(providerId: string, input: { displayName?: string; model?: string; apiKey: string }): void;
  onConfigureCustom(input: { displayName: string; protocol: Protocol; baseUrl: string; model: string; apiKey: string }): void;
  onManageConnections(): void;
}

/** 三步线性连接页：选择 → 最少字段 → 显式保存；远程请求仍只能由本机 Gateway 在后续手动测试时发起。 */
export function ProviderSetupPage({ gatewayAttached, attachingGateway, gatewayError, error, pendingProviderId, onAttach, onDetach, onConfigure, onConfigureCustom, onManageConnections }: ProviderSetupPageProps) {
  const firstPreset = PRESETS[0];
  const [providerId, setProviderId] = useState(firstPreset.id);
  const [customMode, setCustomMode] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>('openai-compatible');
  const [displayName, setDisplayName] = useState(`我的 ${firstPreset.title}`);
  const [model, setModel] = useState(firstPreset.defaultModel);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selected = useMemo(() => PRESETS.find((item) => item.id === providerId) ?? firstPreset, [providerId]);
  const isSubmitting = pendingProviderId === (customMode ? 'custom' : providerId);
  const actionableError = error ?? gatewayError;

  const choosePreset = (nextProviderId: string) => {
    const next = PRESETS.find((item) => item.id === nextProviderId)!;
    setCustomMode(false);
    setProviderId(next.id);
    setDisplayName(`我的 ${next.title}`);
    setModel(next.defaultModel);
    setApiKey('');
    setBaseUrl('');
    setAdvancedOpen(false);
  };

  const chooseCustom = () => {
    setCustomMode(true);
    setDisplayName('我的兼容模型');
    setModel('my-compatible-model');
    setBaseUrl('');
    setApiKey('');
    setAdvancedOpen(false);
  };

  const submit = () => {
    if (!gatewayAttached || !apiKey.trim()) return;
    if (customMode) {
      if (!baseUrl.trim() || !model.trim() || !displayName.trim()) return;
      onConfigureCustom({ displayName: displayName.trim(), protocol, baseUrl: baseUrl.trim(), model: model.trim(), apiKey });
    } else {
      onConfigure(providerId, advancedOpen ? { displayName: displayName.trim(), model: model.trim(), apiKey } : { apiKey });
    }
    setApiKey('');
  };

  return (
    <div className="provider-setup-page provider-setup-page--focused provider-setup-page--three-step">
      <header className="settings-page-header provider-setup-header">
        <div><span>THIRD-PARTY API</span><h1>三步连接模型</h1><p>所有第三方请求由本机 Gateway 发起，响应只回到本机工作台处理和展示。</p></div>
        <div className={`settings-gateway-status${gatewayAttached ? ' attached' : ''}`}><strong>{gatewayAttached ? 'Gateway 已就绪' : '先启动本机 Gateway'}</strong><span>{gatewayAttached ? '连接只在当前会话有效；不会自动调用模型。' : '点击后启动内置回环服务，不会在后台自动运行。'}</span><button type="button" title={gatewayAttached ? '仅断开 Workbench 与本机 Gateway 的当前附着；不会删除连接资料。' : '显式启动并附着固定 loopback Gateway；不会连接第三方模型。'} onClick={gatewayAttached ? onDetach : onAttach} disabled={attachingGateway}>{attachingGateway ? '正在连接…' : gatewayAttached ? '断开' : '启动 Gateway'}</button></div>
      </header>
      {actionableError && <div className="provider-onboarding-error" role="alert"><strong>连接未保存。</strong><span>{actionableError}</span></div>}
      <section className="provider-onboarding provider-onboarding--compact provider-three-step" aria-label="Third-party API setup">
        <div className="onboarding-step"><span>1</span><div><strong>选择服务</strong><p>选择已审核 Provider；也可以连接自己的兼容模型。</p></div></div>
        <div className="provider-preset-grid provider-preset-grid--compact provider-preset-grid--simple">
          {PRESETS.map((item) => <button key={item.id} type="button" title={`选择 ${item.title}；默认模型 ${item.defaultModel}。保存后仍需在已连接模型中显式启用和测试。`} className={`provider-preset${!customMode && providerId === item.id ? ' active' : ''}`} onClick={() => choosePreset(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}
          <button type="button" title="连接符合 OpenAI 或 Anthropic 标准的自有 HTTPS 服务；系统会拒绝本机、私网、IP 地址和完整操作路径。" className={`provider-preset provider-preset--custom${customMode ? ' active' : ''}`} onClick={chooseCustom}><strong>自定义 API</strong><small>OpenAI 或 Anthropic-compatible</small></button>
        </div>
        <div className="onboarding-step"><span>2</span><div><strong>填写连接</strong><p>{customMode ? '填写自有服务的最少信息。' : `${selected.title} 的默认模型是 ${selected.defaultModel}；通常只需粘贴 API key。`}</p></div></div>
        <div className="provider-onboarding-form provider-onboarding-form--simple">
          {customMode && <>
            <div className="provider-protocol-inline" role="radiogroup" aria-label="选择自定义 API 协议"><button className={protocol === 'openai-compatible' ? 'active' : ''} title="使用 OpenAI Chat Completions 兼容格式；只接受 HTTPS Base URL。" type="button" role="radio" aria-checked={protocol === 'openai-compatible'} onClick={() => setProtocol('openai-compatible')}>OpenAI-compatible</button><button className={protocol === 'anthropic-compatible' ? 'active' : ''} title="使用 Anthropic Messages 兼容格式；只接受 HTTPS Base URL。" type="button" role="radio" aria-checked={protocol === 'anthropic-compatible'} onClick={() => setProtocol('anthropic-compatible')}>Anthropic-compatible</button></div>
            <label><span>HTTPS Base URL</span><input value={baseUrl} inputMode="url" maxLength={512} onChange={(event) => setBaseUrl(event.target.value)} placeholder={protocol === 'openai-compatible' ? 'https://api.example.com/v1' : 'https://api.example.com'} /><small>你的提示会发送到此服务。仅接受公开 HTTPS Base URL。</small></label>
            <label><span>模型名称</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder="my-compatible-model" /></label>
            <label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder="我的兼容模型" /></label>
          </>}
          {!customMode && providerId.startsWith('mimo') && <p className="provider-compatibility-note">`sk-` 使用“MiMo（按量）”；`tp-` 请按 Token Plan 控制台显示的区域选择中国、新加坡或欧洲。当前 `tp-` 密钥已在中国集群验证可访问。</p>}
          {!customMode && <button className="provider-model-adjust" title="可选地修改默认模型标识或本地显示名称；不会改变 API key、端点或权限。" type="button" onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? '收起模型调整' : `调整模型或名称（可选）`}</button>}
          {!customMode && advancedOpen && <div className="provider-advanced-fields"><label><span>模型名称</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder={selected.defaultModel} /></label><label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder={`我的 ${selected.title}`} /></label></div>}
          <label className="provider-key-field"><span>API key</span><input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴 API key" /><small>仅在当前 Gateway 进程内存中保存；关闭 Gateway 后自动失效。</small></label>
        </div>
        <div className="onboarding-step onboarding-step--final"><span>3</span><div><strong>连接并测试</strong><p>本次点击会把密钥仅写入当前 Gateway 内存并发起一次模型列表探测；不会自动发送聊天内容、调用工具或保存密钥。</p></div></div>
        <div className="provider-submit-row"><button className="provider-onboarding-submit" title="将连接仅保存到当前 Gateway 内存，并按本次明确操作发起一次模型列表测试；不会自动发送聊天内容或执行工具。" type="button" disabled={!gatewayAttached || !apiKey.trim() || (customMode && (!baseUrl.trim() || !model.trim() || !displayName.trim())) || isSubmitting} onClick={submit}>{isSubmitting ? '正在连接并测试…' : '连接并测试'}</button><button type="button" title="前往二级控制页，按状态显式登记、启用、测试或发送一次受限文本请求。" className="provider-next-link" onClick={onManageConnections}>查看已连接模型 →</button></div>
      </section>
      <p className="provider-compatibility-note">自定义连接会拒绝 HTTP、本机、私网、IP 地址、完整操作路径和任意 header。自托管本地模型请使用本地模型端点管理。</p>
    </div>
  );
}
