import type { AgentProfileId } from '@awo/protocol';
import type { DAGNode } from '@awo/agent-runtime';

/** 任务模板仅声明 DAG 与能力意图；实际权限、审批、预算和工具执行仍在运行时领域层完成。 */
export function createTaskNodes(profileId: AgentProfileId): readonly DAGNode[] {
  const readOnly = [
    {
      id: 'understand', kind: 'model' as const,
      tool: { name: 'local.task.understand', args: {}, capability: 'model.chat' as const, risk: 'low' as const },
      idempotencyKey: 'understand:v1', deps: [],
    },
    {
      id: 'inspect', kind: 'tool' as const,
      tool: { name: 'workspace.inspect', args: {}, capability: 'filesystem.read' as const, risk: 'low' as const },
      idempotencyKey: 'inspect:v1', deps: ['understand'],
    },
  ];
  if (profileId !== 'build') return readOnly;
  return [
    ...readOnly,
    {
      id: 'deliver', kind: 'tool' as const,
      tool: { name: 'workspace.write.intent', args: {}, capability: 'filesystem.write' as const, risk: 'medium' as const },
      idempotencyKey: 'deliver:v1', deps: ['inspect'],
    },
  ];
}
