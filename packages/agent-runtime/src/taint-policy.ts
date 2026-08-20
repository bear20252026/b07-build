import type {
  Capability,
  CapabilityEvaluation,
  CapabilityPolicy,
  CapabilityRequest,
  ContentTrust,
  InputProvenanceV1,
  InputSourceKind,
} from '@awo/protocol';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const TRUSTS = new Set<ContentTrust>(['operator-authored', 'workspace-controlled', 'external-untrusted', 'derived-untrusted']);
const SOURCE_KINDS = new Set<InputSourceKind>(['operator', 'workspace', 'web', 'upload', 'knowledge', 'tool-output', 'provider-output']);
const TAINT_BLOCKED_CAPABILITIES = new Set<Capability>(['filesystem.write', 'network.fetch', 'shell.execute', 'browser.control']);

function copy(input: InputProvenanceV1): InputProvenanceV1 {
  return { ...input };
}

function assertProvenance(input: InputProvenanceV1): void {
  if (input.schemaVersion !== 1 || !IDENTIFIER.test(input.inputId) || !TRUSTS.has(input.trust) || !SOURCE_KINDS.has(input.sourceKind) || !SHA256_DIGEST.test(input.contentDigest)) {
    throw new Error('InputProvenanceV1 无效；taint 控制面失败关闭');
  }
  if ((input.trust === 'operator-authored' && input.sourceKind !== 'operator') || (input.trust === 'workspace-controlled' && input.sourceKind !== 'workspace')) {
    throw new Error('InputProvenanceV1 trust/sourceKind 不匹配；taint 控制面失败关闭');
  }
  if (input.trust === 'external-untrusted' && !['web', 'upload', 'knowledge'].includes(input.sourceKind)) {
    throw new Error('external-untrusted 来源不被允许；taint 控制面失败关闭');
  }
  if (input.trust === 'derived-untrusted' && !['tool-output', 'provider-output', 'knowledge'].includes(input.sourceKind)) {
    throw new Error('derived-untrusted 来源不被允许；taint 控制面失败关闭');
  }
}

/** 保持稳定排序、无重复 ID 的脱敏输入来源集合；它不是任意文本、URL 或授权载体。 */
export function normalizeInputProvenance(inputs: readonly InputProvenanceV1[]): readonly InputProvenanceV1[] {
  const ids = new Set<string>();
  for (const input of inputs) {
    assertProvenance(input);
    if (ids.has(input.inputId)) throw new Error(`inputProvenance.inputId 重复：${input.inputId}`);
    ids.add(input.inputId);
  }
  return inputs.map(copy).sort((left, right) => left.inputId.localeCompare(right.inputId));
}

export function hasUntrustedInput(inputs: readonly InputProvenanceV1[]): boolean {
  return inputs.some((input) => input.trust === 'external-untrusted' || input.trust === 'derived-untrusted');
}

/**
 * 不可信输入只会收紧已组合的 Profile/Authority decision。
 * P6.0 没有 declassification 端口：管理员租约、审批、HTTP body 和模型输出均无法覆盖此 gate。
 */
export class TaintAwareCapabilityPolicy implements CapabilityPolicy {
  private readonly provenance: readonly InputProvenanceV1[];
  private readonly tainted: boolean;

  constructor(inputs: readonly InputProvenanceV1[], private readonly delegate: CapabilityPolicy) {
    this.provenance = normalizeInputProvenance(inputs);
    this.tainted = hasUntrustedInput(this.provenance);
  }

  evaluate(request: CapabilityRequest): CapabilityEvaluation {
    const base = this.delegate.evaluate(request);
    if (base.decision === 'deny' || !this.tainted) return base;
    if (TAINT_BLOCKED_CAPABILITIES.has(request.capability)) {
      return {
        decision: 'deny',
        reason: `输入 taint gate 拒绝 ${request.capability}：任务包含 external/derived-untrusted 内容；请使用 Reader Profile 或经未来可信宿主发起的显式受限 declassification`,
      };
    }
    return base;
  }

  listInputProvenance(): readonly InputProvenanceV1[] {
    return this.provenance.map(copy);
  }

  isTainted(): boolean {
    return this.tainted;
  }
}
