import type { WorkbenchProviderConnection, WorkbenchProviderModelDiscovery } from './task-client';

const modelIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isSelectableHomeModel(value: string): boolean {
  return modelIdentifier.test(value.trim());
}

export function homeModelChoices(
  connection: WorkbenchProviderConnection | undefined,
  discovery: WorkbenchProviderModelDiscovery | undefined,
): readonly string[] {
  if (!connection) return [];
  const knownMimo = /mimo/i.test(connection.displayName) || connection.providerId === 'mimo' || connection.providerId.startsWith('mimo-token-plan-')
    ? ['mimo-v2.5', 'mimo-v2.5-pro']
    : [];
  return [connection.defaultModel, ...knownMimo, ...(discovery?.outcome === 'reachable' ? discovery.models : [])]
    .filter((model, index, all) => Boolean(model) && all.indexOf(model) === index)
    .slice(0, 100);
}

export function homeModelCapabilityHint(connection: WorkbenchProviderConnection | undefined, model: string): string {
  if (!connection) return '请先选择已连接的 Provider。';
  const isMimo = /mimo/i.test(connection.displayName) || connection.providerId === 'mimo' || connection.providerId.startsWith('mimo-token-plan-');
  if (isMimo && model === 'mimo-v2.5') return '已知能力：视觉/全模态与流式；图片将按当前 OpenAI-compatible 协议直连发送。';
  if (isMimo && model === 'mimo-v2.5-pro') return '已知能力：文本、推理与流式；图片任务请显式切换到 mimo-v2.5。';
  return `协议：${connection.driverId.replace('desktop-direct.', '')}。其他能力以供应商文档和实际测试为准。`;
}
