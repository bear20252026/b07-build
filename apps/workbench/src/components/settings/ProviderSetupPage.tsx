import { useMemo, useState } from 'react';
import type { WorkbenchProviderConnection, WorkbenchProviderModelDiscovery } from '../../runtime/task-client';
import './ProviderSetupPage.css';

type Protocol = 'openai-compatible' | 'anthropic-compatible';

type ProviderPreset = {
  id: string;
  title: string;
  description: string;
  defaultModel: string;
  defaultBaseUrls: Partial<Record<Protocol, string>>;
};

const PRESETS: readonly ProviderPreset[] = [
  { id: 'deepseek', title: 'DeepSeek', description: '默认推荐', defaultModel: 'deepseek-v4-pro', defaultBaseUrls: { 'openai-compatible': 'https://api.deepseek.com' } },
  { id: 'mimo', title: 'Xiaomi MiMo（按量）', description: 'sk- 密钥', defaultModel: 'mimo-v2.5-pro', defaultBaseUrls: { 'openai-compatible': 'https://api.xiaomimimo.com/v1', 'anthropic-compatible': 'https://api.xiaomimimo.com/anthropic' } },
  { id: 'mimo-token-plan-cn', title: 'MiMo Token Plan（中国）', description: 'tp- 订阅密钥', defaultModel: 'mimo-v2.5-pro', defaultBaseUrls: { 'openai-compatible': 'https://token-plan-cn.xiaomimimo.com/v1', 'anthropic-compatible': 'https://token-plan-cn.xiaomimimo.com/anthropic' } },
  { id: 'longcat', title: 'LongCat', description: '美团龙猫', defaultModel: 'LongCat-2.0', defaultBaseUrls: { 'openai-compatible': 'https://api.longcat.chat/openai/v1' } },
  { id: 'kimi', title: 'Kimi', description: 'Moonshot AI', defaultModel: 'kimi-k3', defaultBaseUrls: { 'openai-compatible': 'https://api.moonshot.cn/v1' } },
  { id: 'zhipu', title: '智谱 GLM', description: 'GLM 系列', defaultModel: 'glm-5.3', defaultBaseUrls: { 'openai-compatible': 'https://open.bigmodel.cn/api/paas/v4' } },
  { id: 'openai', title: 'OpenAI', description: 'Chat Completions', defaultModel: 'gpt-5.6', defaultBaseUrls: { 'openai-compatible': 'https://api.openai.com/v1' } },
  { id: 'google-gemini', title: 'Google Gemini', description: 'OpenAI-compatible', defaultModel: 'gemini-3.7-flash', defaultBaseUrls: { 'openai-compatible': 'https://generativelanguage.googleapis.com/v1beta/openai' } },
  { id: 'mistral', title: 'Mistral AI', description: 'OpenAI-compatible', defaultModel: 'mistral-large-latest', defaultBaseUrls: { 'openai-compatible': 'https://api.mistral.ai/v1' } },
  { id: 'openrouter', title: 'OpenRouter', description: '多模型路由', defaultModel: 'openrouter/auto', defaultBaseUrls: { 'openai-compatible': 'https://openrouter.ai/api/v1' } },
  { id: 'anthropic', title: 'Anthropic Claude', description: 'Messages API', defaultModel: 'claude-opus-5', defaultBaseUrls: { 'anthropic-compatible': 'https://api.anthropic.com' } },
];

function baseUrlFor(preset: ProviderPreset, protocol: Protocol): string {
  return preset.defaultBaseUrls[protocol] ?? '';
}

export interface ProviderSetupPageProps {
  connections?: readonly WorkbenchProviderConnection[];
  discoveredModels?: Readonly<Record<string, WorkbenchProviderModelDiscovery | undefined>>;
  error?: string;
  pendingProviderId?: string;
  onConfigure(providerId: string, input: { displayName?: string; model?: string; baseUrl?: string; protocol?: Protocol; apiKey: string }): void;
  onConfigureCustom(input: { displayName: string; protocol: Protocol; baseUrl: string; model: string; apiKey: string }): void;
  onDiscoverModels(providerId: string): void;
  onManageConnections(): void;
}

/** 原模型设置页：协议、地址、密钥和模型都在同一个表单内明确呈现。 */
export function ProviderSetupPage({ error, pendingProviderId, discoveredModels = {}, onConfigure, onConfigureCustom, onDiscoverModels, onManageConnections }: ProviderSetupPageProps) {
  const firstPreset = PRESETS[0]!;
  const [providerId, setProviderId] = useState(firstPreset.id);
  const [customMode, setCustomMode] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>('openai-compatible');
  const [displayName, setDisplayName] = useState(`我的 ${firstPreset.title}`);
  const [model, setModel] = useState(firstPreset.defaultModel);
  const [baseUrl, setBaseUrl] = useState(baseUrlFor(firstPreset, 'openai-compatible'));
  const [baseUrlDirty, setBaseUrlDirty] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selected = useMemo(() => PRESETS.find((item) => item.id === providerId) ?? firstPreset, [providerId, firstPreset]);
  const isSubmitting = pendingProviderId === (customMode ? 'custom' : providerId);
  const discovery = !customMode ? discoveredModels[providerId] : undefined;

  const choosePreset = (nextProviderId: string) => {
    const next = PRESETS.find((item) => item.id === nextProviderId) ?? firstPreset;
    const nextProtocol: Protocol = next.defaultBaseUrls['openai-compatible'] ? 'openai-compatible' : 'anthropic-compatible';
    setCustomMode(false);
    setProviderId(next.id);
    setProtocol(nextProtocol);
    setDisplayName(`我的 ${next.title}`);
    setModel(next.defaultModel);
    setBaseUrl(baseUrlFor(next, nextProtocol));
    setBaseUrlDirty(false);
    setApiKey('');
    setAdvancedOpen(false);
  };
  const chooseCustom = () => {
    setCustomMode(true);
    setProtocol('openai-compatible');
    setDisplayName('我的兼容模型');
    setModel('my-compatible-model');
    setBaseUrl('');
    setBaseUrlDirty(false);
    setApiKey('');
    setAdvancedOpen(false);
  };
  const chooseProtocol = (nextProtocol: Protocol) => {
    setProtocol(nextProtocol);
    if (!customMode && !baseUrlDirty) setBaseUrl(baseUrlFor(selected, nextProtocol));
  };
  const restoreOfficialBaseUrl = () => {
    setBaseUrl(baseUrlFor(selected, protocol));
    setBaseUrlDirty(false);
  };
  const submit = () => {
    if (!apiKey.trim() || !baseUrl.trim() || !model.trim()) return;
    if (customMode) {
      if (!displayName.trim()) return;
      onConfigureCustom({ displayName: displayName.trim(), protocol, baseUrl: baseUrl.trim(), model: model.trim(), apiKey });
    } else {
      onConfigure(providerId, { displayName: displayName.trim(), model: model.trim(), baseUrl: baseUrl.trim(), protocol, apiKey });
    }
    setApiKey('');
  };

  return (
    <div className="provider-setup-page provider-setup-page--focused provider-setup-page--three-step">
      <header className="settings-page-header provider-setup-header">
        <div><span>THIRD-PARTY API</span><h1>三步连接模型</h1><p>先明确 API 协议，再填写可修改的地址、密钥和模型名；测试和任务调用使用同一份会话配置。</p></div>
        <div className="settings-gateway-status attached"><strong>桌面直连已就绪</strong><span>连接时会直接使用您填写的协议、地址、密钥与模型。</span></div>
      </header>
      {error && <div className="provider-onboarding-error" role="alert"><strong>模型连接未完成。</strong><span>{error}</span></div>}
      <section className="provider-onboarding provider-onboarding--compact provider-three-step" aria-label="Third-party API setup">
        <div className="onboarding-step"><span>1</span><div><strong>选择服务</strong><p>选择预置服务，或连接自己的兼容模型。</p></div></div>
        <div className="provider-preset-grid provider-preset-grid--compact provider-preset-grid--simple">
          {PRESETS.map((item) => <button key={item.id} type="button" title={`选择 ${item.title}；协议、地址和模型名称均可修改。`} className={`provider-preset${!customMode && providerId === item.id ? ' active' : ''}`} onClick={() => choosePreset(item.id)}><strong>{item.title}</strong><small>{item.description}</small></button>)}
          <button type="button" title="连接符合 OpenAI 或 Anthropic 标准的自有 HTTPS 服务。" className={`provider-preset provider-preset--custom${customMode ? ' active' : ''}`} onClick={chooseCustom}><strong>自定义 API</strong><small>OpenAI 或 Anthropic-compatible</small></button>
        </div>
        <div className="onboarding-step"><span>2</span><div><strong>填写连接</strong><p>协议选择、连接地址、密钥和模型名共同决定真实请求格式。</p></div></div>
        <div className="provider-onboarding-form provider-onboarding-form--simple">
          <div className="provider-protocol-inline" role="radiogroup" aria-label="选择 API 协议"><button className={protocol === 'openai-compatible' ? 'active' : ''} title="使用 OpenAI Chat Completions 格式。MiMo Token Plan 中国区默认地址为 /v1。" type="button" role="radio" aria-checked={protocol === 'openai-compatible'} onClick={() => chooseProtocol('openai-compatible')}>OpenAI-compatible</button><button className={protocol === 'anthropic-compatible' ? 'active' : ''} title="使用 Anthropic Messages 格式。MiMo Token Plan 中国区默认地址为 /anthropic。" type="button" role="radio" aria-checked={protocol === 'anthropic-compatible'} onClick={() => chooseProtocol('anthropic-compatible')}>Anthropic-compatible</button></div>
          {!customMode && providerId.startsWith('mimo') && <p className="provider-compatibility-note">MiMo 中国区按协议使用不同基础地址：OpenAI 为 `/v1`，Anthropic 为 `/anthropic`；`sk-` 与 `tp-` 密钥不可混用。</p>}
          {customMode && <><label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder="我的兼容模型" /></label><label><span>模型名称</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder="my-compatible-model" /></label></>}
          {!customMode && <button className="provider-model-adjust" title="可选地修改默认模型标识或本地显示名称；不会改变已选择协议。" type="button" onClick={() => setAdvancedOpen((open) => !open)}>{advancedOpen ? '收起模型调整' : '调整模型或名称（可选）'}</button>}
          {!customMode && advancedOpen && <div className="provider-advanced-fields"><label><span>模型名称</span><input value={model} maxLength={128} onChange={(event) => setModel(event.target.value)} placeholder={selected.defaultModel} /></label><label><span>显示名称</span><input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder={`我的 ${selected.title}`} /></label></div>}
          <label className="provider-base-url-field"><span>连接地址 / Base URL（{protocol === 'openai-compatible' ? 'OpenAI' : 'Anthropic'}）</span><input value={baseUrl} inputMode="url" maxLength={512} onChange={(event) => { setBaseUrl(event.target.value); setBaseUrlDirty(true); }} placeholder={customMode ? 'https://api.example.com/v1' : baseUrlFor(selected, protocol) || '按供应商文档填写 HTTPS Base URL'} /><small>填写供应商控制台给出的协议对应基础地址；不要输入完整 chat completion 或 messages 操作路径。</small></label>
          {!customMode && baseUrlFor(selected, protocol) && <button type="button" className="provider-default-url" title="用该供应商当前所选协议的官方默认 Base URL 覆盖本框内容。" onClick={restoreOfficialBaseUrl}>使用当前协议的官方默认地址</button>}
          <label className="provider-key-field"><span>API key</span><input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴 API key" /><small>仅在当前桌面应用会话内存中保存；关闭应用后自动失效。</small></label>
          {!customMode && <div className="provider-model-discovery"><div><strong>可用模型</strong><p>连接后可按当前协议、地址和会话密钥查询；查询不到时仍可按供应商文档手动填写模型名称。</p></div><button type="button" title="按当前已连接会话的协议、Base URL 和 API key 查询公开模型列表。" disabled={isSubmitting} onClick={() => onDiscoverModels(providerId)}>{isSubmitting ? '正在查询…' : '查询模型'}</button>{discovery?.outcome === 'reachable' && discovery.models.length === 0 && <span className="provider-model-manual">该服务未提供标准模型列表，请手动填写模型名称。</span>}{discovery && discovery.models.length > 0 && <div className="provider-model-options" aria-label="查询到的模型">{discovery.models.map((item) => <button type="button" key={item} title={`使用 ${item} 作为本次连接的模型名称。`} onClick={() => { setModel(item); setAdvancedOpen(true); }}>{item}</button>)}</div>}</div>}
        </div>
        <div className="onboarding-step onboarding-step--final"><span>3</span><div><strong>连接、查询并测试</strong><p>先按所选协议查询可用模型；之后使用同一协议、地址、密钥和模型执行测试与任务。</p></div></div>
        <div className="provider-submit-row"><button className="provider-onboarding-submit" title="用当前协议、地址、密钥和模型通过桌面原生连接测试第三方服务。" type="button" disabled={!apiKey.trim() || !baseUrl.trim() || !model.trim() || (customMode && !displayName.trim()) || isSubmitting} onClick={submit}>{isSubmitting ? '正在连接、查询并测试…' : '连接并测试'}</button><button type="button" title="前往已连接模型页，查看连接状态与测试结果。" className="provider-next-link" onClick={onManageConnections}>查看已连接模型 →</button></div>
      </section>
      <p className="provider-compatibility-note">如果供应商只提供一种兼容协议，请按其官方文档选择；切换协议不会自动猜测或伪造另一种服务地址。</p>
    </div>
  );
}
