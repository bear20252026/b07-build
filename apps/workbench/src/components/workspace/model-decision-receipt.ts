import type { AgentProfileId } from '@awo/protocol';
import type { WorkbenchAuthorityMode, WorkbenchProviderConnection } from '../../runtime/task-client';

export interface ModelDecisionReceipt { profileId: AgentProfileId; authorityMode: WorkbenchAuthorityMode; connectionStatus: 'unconfigured' | 'available'; connectedProviderCount: number; summary: string; canAutoRoute: false; canReadSecret: false; }

/** P32：任务模型决策只读收据；只记录 UI 已选择的工作方式和脱敏连接数量。 */
export function createModelDecisionReceipt(input: { profileId: AgentProfileId; authorityMode: WorkbenchAuthorityMode; connections: readonly WorkbenchProviderConnection[] }): ModelDecisionReceipt {
  const active = input.connections.filter((connection) => connection.profileStatus === 'active' && connection.credentialAvailability === 'available').length;
  return { profileId: input.profileId, authorityMode: input.authorityMode, connectionStatus: active ? 'available' : 'unconfigured', connectedProviderCount: active, summary: active ? `已显式选择 ${input.profileId} 工作方式与 ${input.authorityMode} 权限；存在 ${active} 个可用连接，但不会自动路由或调用。` : `已显式选择 ${input.profileId} 工作方式与 ${input.authorityMode} 权限；尚无可用连接，任务不会自动连接模型。`, canAutoRoute: false, canReadSecret: false };
}
