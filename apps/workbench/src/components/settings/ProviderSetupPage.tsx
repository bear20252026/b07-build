import { useMemo, useState } from 'react';
import type { WorkbenchProviderConnection } from '../../runtime/task-client';
import './ProviderSetupPage.css';

type Protocol = 'openai-compatible' | 'anthropic-compatible';

type ProviderPreset = {
  id: string;
  title: string;
  description: string;
  defaultModel: string;
  defaultBaseUrl: string;
};

const PRESETS: readonly ProviderPreset[] = [
  { id: 'deepseek', title: 'DeepSeek', description: '默认推荐', defaultModel: 'deepseek-v4-pro', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  { id: 'mimo', title: 'Xiaomi MiMo（按量）', description: 'sk- 密钥', defaultModel: 'mimo-v2.5-pro', defaultBaseUrl: 'https://api.xiaomimimo.com/v1' },
  { id: 'mimo-token-plan-cn', title: 'MiMo Token Plan（中国）', description: 'tp- 订阅密钥', defaultModel: 'mimo-v2.5-pro', defaultBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
  { id: 'longcat', title: 'LongCat', description: '美团龙猫', defaultModel: 'LongCat-2.0', defaultBaseUrl: 'https://api.longcat.chat/openai/v1' },
  { id: 'kimi', title: 'Kimi', description: 'Moonshot AI', defaultModel: 'kimi-k3', defaultBaseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', title: '智谱 GLM', description: 'GLM 系列', defaultModel: 'glm-5.3', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'openai', title: 'OpenAI', description: 'Chat Completions', defaultModel: 'gpt-5.6', defaultBaseUrl: 'https://api.openai.com/v1' },
  { id: 'google-gemini', title: 'Google Gemini', description: 'OpenAI-compatible', defaultModel: 'gemini-3.7-flash', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'mistral', title: 'Mistral AI', description: 'OpenAI-compatible', defaultModel: 'mistral-large-latest', defaultBaseUrl: 'https://api.mistral.ai/v1' },
  { id: 'openrouter', title: 'OpenRouter', description: '多模型路由', defaultModel: 'openrouter/auto', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'anthropic', title: 'Anthropic Claude', description: 'Messages API', defaultModel: 'claude-opus-5', defaultBaseUrl: 'https://api.anthropic.com' },
];

export interface ProviderSetupPageProps {
  gatewayAttached: boolean;
  attachingGateway: boolean;
  gatewayError?: string;
  connections?: readonly WorkbenchProviderConnection[];
  error?: string;
  pendingProviderId?: string;
  onAttach(): void;
  onConfigure(providerId: string, input: { displayName?: string; model?: string; baseUrl?: string; apiKey: string }): void;
  onConfigureCustom(input: { displayName: string; protocol: Protocol; baseUrl: string; model: string; apiKey: string }): void;
  onManageConnections(): void;
}

/** 原有模型设置页：预置地址仅作为可编辑默认值，提交时与密钥一起写入当前 Gateway 会话。 */
export function ProviderSetupPage({ gatewayAttached, attachingGateway, gatewayError, error, pendingProviderId, onAttach, onConfigure, onConfigureCustom, onManageConnections }: ProviderSetupPageProps) {
  const firstPreset = PRESETS[0];
  const [providerId, setProviderId] = useState(firstPreset.id);
  const [customMode, setCustomMode] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>('openai-compatible');
  const [displayName, setDisplayName] = useState(`我的 ${firstPreset.title}`);
  const [model, setModel] = useState(firstPreset.defaultModel);
  const [baseUrl, setBaseUrl] = useState(firstPreset.defaultBaseUrl);
  const [apiKey, setApiKey] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selected = useMemo(() => PRESETS.find((item) => item.id === providerId) ?? firstPreset, [providerId]);
  const isSubmitting = pendingProviderId === (customMode ? 'custom' : providerId);

  const choosePreset = (nextProviderId: string) => {
    const next = PRESETS.find((item) => item.id === nextProviderId) ?? firstPreset;
    setCustomMode(false);
    setProviderId(next.id);
    setDisplayName(`我的 ${next.title}`);
    setModel(next.defaultModel);
    setBaseUrl(next.defaultBaseUrl);
    setApiKey('');
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
    if (!apiKey.trim() || !baseUrl.trim() || !model.trim()) return;
    if (customMode) {
      if (!displayName.trim()) return;
      onConfigureCustom({ displayName: displayName.trim(), protocol, baseUrl: baseUrl.trim(), model: model.trim(), apiKey });
    } else {
      onConfigure(providerId, { displayName: displayName.trim(), model: model.trim(), baseUrl: baseUrl.trim(), apiKey });
    }
    setApiKey('');
  };

  return (
    <div className="provider-setup-page provider-setup-page--focused provider-setup-page--three-step">
      <header className="settings-page-header provider-setup-header">
        <div><span>THIRD-PARTY API</span><h1>三步连接模型</h1><p>预置地址可直接更正。填写地址和密钥后立即连接并测试，第三方响应只回到本机工作台。</p></div>
        <div className={`settings-gateway-status${gatewayAttached ? ' attached' : ''}`}><strong>{gatewayAttached ? 'Gateway 已就绪' : attachingGateway ? '正在准备 Gateway' : '连接时自动准备 Gateway'}</strong><span>{gatewayAttached ? '连接只在当前会话有效。' : '无需先手动启动；点击“连接并测试”后会先启动固定本机回环服务。'}</span></div>
      </header>
      {gatewayError && <div className="provider-onboarding-error" role="alert"><strong>本机 Gateway 尚未准备好。</strong><span>{gatewayError}</span><button type="button" onClick={onAttach} disabled={attachingGateway}>{attachingGateway ? '正在准备…' : '重新准备 Gateway'}</button></div>}
      {error && <div className="provider-onboarding-error" role="alert"><strong>模型连接未完成。</strong><span>{error}</span></div>}
      <section className="provider-onboarding provider-onboarding--compact provider-three-step" aria-label="Third-party API setup">
        <div className="onboarding-step"><span>1</span><div><strong>选择服务</strong><p>选择预置服务，或连接自己的兼容模型。</p></div></div>
        <div className="provider-preset-grid provider-preset-grid--compact provider-preset-grid--simple">
          {PRESETS.map((item) => <button key={item.id} type="button" title={`选择 ${item.title}；地址和模型名称可编辑。`} className={`provider-preset${!customMode && providerId === item.id ? ' active' : ''}`} onClick={() => choosePreset(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}
          <button type="button" title="连接符合 OpenAI 或 Anthropic 标准的自有 HTTPS 服务。" className={`provider-preset provider-preset--custom${customMode ? ' active' : ''}`} onClick={chooseCustom}><strong>自定义 API</strong><small>OpenAI 或 Anthropic-compatible</small></button>
        </div>
        <div className="onboarding-step"><span>2</span><div><strong>填写连接</strong><p>地址位于密钥上方；预置值来自服务目录，但你可以按供应商控制台自由修改。</p></div></div>
        <div className="provider-onboarding-form provider-onboarding-form--simple">
          {customMode && <><div className="provider-protocol-inline" role="radiogroup" aria-label="选择自定义 API 协议"><button className={protocol === 'openai-compatible' ? 'active' : ''} title="使用 OpenAI Chat Completions 兼容格式；只接受 HTTPS Base URL。" type="button" role="radio" aria-checked={protocol === 'openai-compatible'} onClick={() => setProtocol('openai-compatible')}>OpenAI-compatible</button><button className={protocol === 'anthropic-compatible' ? 'active' : ''} title="使用 Anthropic Messages 兼容格式；只接受 HTTPS Base URL。" type="button" role="radio" aria-checked={protocol === 'anthropic-compatible'} onClick={() => setProtocol('anthropic-compatible')}>Anthropic-compatible</button></div><label><span>模型名称</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder="my-compatible-model" /></label><label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder="我的兼容模型" /></label></>}
          {!customMode && providerId.startsWith('mimo') && <p className="provider-compatibility-note">`sk-` 请使用“MiMo（按量）”；`tp-` 请使用“MiMo Token Plan（中国）”。两类密钥不可混用。</p>}
          {!customMode && <button className="provider-model-adjust" title="可选地修改默认模型标识或本地显示名称；不会改变地址或密钥。" type="button" onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? '收起模型调整' : '调整模型或名称（可选）'}</button>}
          {!customMode && advancedOpen && <div className="provider-advanced-fields"><label><span>模型名称</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder={selected.defaultModel} /></label><label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder={`我的 ${selected.title}`} /></label></div>}
          <label className="provider-base-url-field"><span>连接地址 / Base URL</span><input value={baseUrl} inputMode="url" maxLength={512} onChange={(event) => setBaseUrl(event.target.value)} placeholder={customMode ? 'https://api.example.com/v1' : selected.defaultBaseUrl} /><small>填写供应商控制台给出的基础地址；不要输入完整 chat completion 或 messages 路径。</small></label>
          <label className="provider-key-field"><span>API key</span><input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴 API key" /><small>仅在当前 Gateway 进程内存中保存；关闭 Gateway 后自动失效。</small></label>
        </div>
        <div className="onboarding-step onboarding-step--final"><span>3</span><div><strong>连接并测试</strong><p>本次点击会按需启动本机 Gateway，将地址和密钥仅写入当前会话内存，并发起一次模型列表探测；不会自动发送聊天内容或保存密钥。</p></div></div>
        <div className="provider-submit-row"><button className="provider-onboarding-submit" title="按需启动固定本机 Gateway，并以当前地址和密钥发起一次模型列表测试。" type="button" disabled={!apiKey.trim() || !baseUrl.trim() || !model.trim() || (customMode && !displayName.trim()) || isSubmitting || attachingGateway} onClick={submit}>{isSubmitting ? '正在连接并测试…' : attachingGateway ? '正在准备 Gateway…' : '连接并测试'}</button><button type="button" title="前往已连接模型页，查看测试结果或发送一次文本请求。" className="provider-next-link" onClick={onManageConnections}>查看已连接模型 →</button></div>
      </section>
      <p className="provider-compatibility-note">自定义连接使用 HTTPS 公网服务地址；本机或内网模型请使用本地模型端点管理，避免将桌面应用变成访问内网资源的代理。</p>
    </div>
  );
}
