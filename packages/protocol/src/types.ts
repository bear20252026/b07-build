// packages/protocol/src/types.ts —— 一文件=一作用：只声明协议类型，不放逻辑
export type RiskLevel = 'low' | 'medium' | 'high';
export type ToolStatus = 'ok' | 'error';

export interface PlanStep {
  id: string;
  description: string;
  risk?: RiskLevel;
}

export type TaskEvent =
  | { type: 'task.created'; taskId: string; goal: string; at: number }
  | { type: 'plan.proposed'; taskId: string; steps: PlanStep[]; at: number }
  | { type: 'approval.required'; actionId: string; risk: RiskLevel; at: number }
  | { type: 'tool.called'; callId: string; tool: ToolRef; inputHash: string; at: number }
  | { type: 'tool.result'; callId: string; status: ToolStatus; outputRef: string; at: number }
  | { type: 'artifact.created'; artifactId: string; mime: string; path: string; at: number }
  | { type: 'task.completed'; taskId: string; summaryRef: string; at: number };

export interface ToolRef {
  name: string;
  args: unknown;
}
