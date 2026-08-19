// 一个文件=一种作用：Agent Profile 定义与权限收紧。Profile 只能收紧基线策略，不能扩大授权。
import type {
  AgentProfileId,
  CapabilityEvaluation,
  CapabilityPolicy,
  CapabilityPolicyRule,
  CapabilityRequest,
} from '@awo/protocol';
import { RuleBasedCapabilityPolicy } from './capability-policy.js';

export interface AgentProfile {
  id: AgentProfileId;
  label: string;
  description: string;
  maxToolCalls: number;
  maxIdenticalCalls: number;
  contextMaxTokens: number;
  rules: readonly CapabilityPolicyRule[];
}

const ALLOW_READ: CapabilityPolicyRule[] = [
  { capability: 'document.parse', decision: 'allow', reason: 'Profile 允许解析本地文档' },
  { capability: 'model.chat', decision: 'allow', reason: 'Profile 允许模型推理' },
  { capability: 'filesystem.read', decision: 'allow', reason: 'Profile 允许读取工作区' },
];

export const AGENT_PROFILES: Readonly<Record<AgentProfileId, AgentProfile>> = {
  build: {
    id: 'build',
    label: 'Build',
    description: '实现任务；写入、网络、浏览器和 Shell 均先进入审批门控。',
    maxToolCalls: 40,
    maxIdenticalCalls: 2,
    contextMaxTokens: 28_000,
    rules: [
      ...ALLOW_READ,
      { capability: 'filesystem.write', decision: 'require_approval', reason: 'Build 修改文件需要审批' },
      { capability: 'network.fetch', decision: 'require_approval', reason: 'Build 访问网络需要审批' },
      { capability: 'shell.execute', decision: 'require_approval', reason: 'Build 执行 Shell 需要审批' },
      { capability: 'browser.control', decision: 'require_approval', reason: 'Build 控制浏览器需要审批' },
    ],
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    description: '分析、规划与审查；不允许写文件或执行 Shell。',
    maxToolCalls: 16,
    maxIdenticalCalls: 2,
    contextMaxTokens: 18_000,
    rules: [
      ...ALLOW_READ,
      { capability: 'filesystem.write', decision: 'deny', reason: 'Plan Profile 禁止修改文件' },
      { capability: 'network.fetch', decision: 'require_approval', reason: 'Plan 访问网络需要审批' },
      { capability: 'shell.execute', decision: 'deny', reason: 'Plan Profile 禁止执行 Shell' },
      { capability: 'browser.control', decision: 'deny', reason: 'Plan Profile 禁止控制浏览器' },
    ],
  },
  explore: {
    id: 'explore',
    label: 'Explore',
    description: '快速只读探索；限制步骤和上下文以避免无边界扫描。',
    maxToolCalls: 10,
    maxIdenticalCalls: 1,
    contextMaxTokens: 8_000,
    rules: [
      ...ALLOW_READ,
      { capability: 'filesystem.write', decision: 'deny', reason: 'Explore Profile 禁止修改文件' },
      { capability: 'network.fetch', decision: 'deny', reason: 'Explore Profile 禁止网络访问' },
      { capability: 'shell.execute', decision: 'deny', reason: 'Explore Profile 禁止执行 Shell' },
      { capability: 'browser.control', decision: 'deny', reason: 'Explore Profile 禁止控制浏览器' },
    ],
  },
};

const RESTRICTION_RANK = { allow: 0, require_approval: 1, deny: 2 } as const;

/** 把一个基础授权策略限制在 Profile 的能力边界内。 */
export class ProfiledCapabilityPolicy implements CapabilityPolicy {
  private readonly profilePolicy: CapabilityPolicy;

  constructor(
    readonly profile: AgentProfile,
    private readonly baseline: CapabilityPolicy,
  ) {
    this.profilePolicy = new RuleBasedCapabilityPolicy(profile.rules);
  }

  evaluate(request: CapabilityRequest): CapabilityEvaluation {
    const baseline = this.baseline.evaluate(request);
    const profile = this.profilePolicy.evaluate(request);
    const decision = RESTRICTION_RANK[baseline.decision] >= RESTRICTION_RANK[profile.decision]
      ? baseline
      : profile;
    return decision;
  }
}

export function getAgentProfile(profileId: AgentProfileId): AgentProfile {
  return AGENT_PROFILES[profileId];
}
