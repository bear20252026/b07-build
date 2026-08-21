import type { AgentProfileId, ExecutionAuthorityMode } from '@awo/protocol';

export interface WorkModeAuditProjection {
  profileId: AgentProfileId;
  authorityMode: Exclude<ExecutionAuthorityMode, 'admin'>;
  connectionSummary: string;
  boundarySummary: string;
}

/** P25 仅投影用户已选择的工作方式；它不保存、自动选择或调用任何模型。 */
export function createWorkModeAuditProjection(input: { profileId: AgentProfileId; authorityMode: Exclude<ExecutionAuthorityMode, 'admin'>; connectedProviderCount: number }): WorkModeAuditProjection {
  return {
    profileId: input.profileId,
    authorityMode: input.authorityMode,
    connectionSummary: input.connectedProviderCount > 0 ? `${input.connectedProviderCount} 个脱敏模型连接可供手动配置与测试` : '尚未连接模型；提交任务前需由用户在设置中明确配置',
    boundarySummary: '模型连接不等于自动调用；API key 只保留引用或进程内会话，不写入任务、项目或界面 DTO。',
  };
}
