// 一个文件=一种作用：CapabilityPolicy 的内存规则适配器（C4）。
import type {
  CapabilityEvaluation,
  CapabilityPolicy,
  CapabilityPolicyRule,
  CapabilityRequest,
} from '@awo/protocol';

/**
 * 规则优先级：同能力同风险的精确规则优先于能力级通配规则；缺失规则时默认拒绝。
 * 这使得新增工具或风险等级不会因为遗漏配置而获得意外权限。
 */
export class RuleBasedCapabilityPolicy implements CapabilityPolicy {
  constructor(private readonly rules: readonly CapabilityPolicyRule[]) {}

  evaluate(request: CapabilityRequest): CapabilityEvaluation {
    const exact = this.rules.find(
      (rule) => rule.capability === request.capability && rule.risk === request.risk,
    );
    if (exact) return { decision: exact.decision, reason: exact.reason };

    const capabilityWide = this.rules.find(
      (rule) => rule.capability === request.capability && rule.risk === undefined,
    );
    if (capabilityWide) {
      return { decision: capabilityWide.decision, reason: capabilityWide.reason };
    }

    return {
      decision: 'deny',
      reason: `默认拒绝：未配置 ${request.capability} 的 ${request.risk} 风险授权规则`,
    };
  }
}
