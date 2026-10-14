// 一个文件=一种作用：CapabilityPolicy 的内存规则适配器（C4）。
import type {
  CapabilityEvaluation,
  CapabilityPolicy,
  CapabilityPolicyRule,
  CapabilityRequest,
} from '@awo/protocol';
import { decideFromRules } from './permission-chain.js';

/**
 * 规则优先级：模式规则（toolPattern + patternInput）→ 精确规则（capability + risk）
 * → 能力级通配规则；同一特异度内 deny 先行；缺失规则时默认拒绝。
 * 这使得新增工具或风险等级不会因为遗漏配置而获得意外权限。
 */
export class RuleBasedCapabilityPolicy implements CapabilityPolicy {
  constructor(private readonly rules: readonly CapabilityPolicyRule[]) {}

  evaluate(request: CapabilityRequest): CapabilityEvaluation {
    return (
      decideFromRules(this.rules, request) ?? {
        decision: 'deny',
        reason: `默认拒绝：未配置 ${request.capability} 的 ${request.risk} 风险授权规则`,
      }
    );
  }
}
