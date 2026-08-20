import type { TaskEvent } from './types.js';

type RecordValue = Readonly<Record<string, unknown>>;

const agentProfiles = new Set(['build', 'plan', 'explore', 'reader']);
const authorityModes = new Set(['plan', 'review', 'automate', 'admin']);
const capabilities = new Set(['filesystem.read', 'filesystem.write', 'network.fetch', 'shell.execute', 'browser.control']);
const risks = new Set(['low', 'medium', 'high']);
const decisions = new Set(['approved', 'rejected']);
const toolStatuses = new Set(['ok', 'error']);
const provenanceTrusts = new Set(['trusted-local', 'external-untrusted', 'derived-untrusted']);
const provenanceSources = new Set(['local-user', 'web', 'upload', 'knowledge', 'tool-output', 'provider-output']);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasEnvelope(value: RecordValue): boolean {
  return value.protocolVersion === '1.0'
    && isString(value.eventId)
    && isString(value.taskId)
    && isString(value.runId)
    && isFiniteNumber(value.at)
    && isString(value.type);
}

function isPlanSteps(value: unknown): boolean {
  return Array.isArray(value) && value.every((step) => isRecord(step)
    && isString(step.id)
    && isString(step.description)
    && (step.risk === undefined || (isString(step.risk) && risks.has(step.risk))));
}

function isBrowserProvenance(value: unknown): boolean {
  return Array.isArray(value) && value.every((input) => isRecord(input)
    && isString(input.inputId)
    && isString(input.digest)
    && isString(input.trust)
    && provenanceTrusts.has(input.trust)
    && isString(input.sourceKind)
    && provenanceSources.has(input.sourceKind));
}

function isToolReference(value: unknown): boolean {
  return isRecord(value)
    && isString(value.name)
    && Object.hasOwn(value, 'args')
    && isString(value.capability)
    && capabilities.has(value.capability)
    && isString(value.risk)
    && risks.has(value.risk);
}

/**
 * Renderer-only structural decoder for events already validated at the Gateway boundary.
 * It deliberately avoids Ajv and dynamic function compilation so a strict desktop CSP can
 * render the Workbench without granting `unsafe-eval`. It never authorizes execution.
 */
export function isBrowserTaskEvent(value: unknown): value is TaskEvent {
  if (!isRecord(value) || !hasEnvelope(value)) return false;

  switch (value.type) {
    case 'task.created':
      return isString(value.goal);
    case 'agent.profile.selected':
      return isString(value.profileId) && agentProfiles.has(value.profileId);
    case 'execution.authority.selected':
      return isString(value.authorityMode) && authorityModes.has(value.authorityMode);
    case 'input.provenance.recorded':
      return isBrowserProvenance(value.provenance);
    case 'plan.proposed':
      return isPlanSteps(value.steps);
    case 'approval.required':
      return isString(value.actionId)
        && isString(value.capability) && capabilities.has(value.capability)
        && isString(value.risk) && risks.has(value.risk)
        && isString(value.reason);
    case 'approval.resolved':
      return isString(value.actionId)
        && isString(value.decision) && decisions.has(value.decision)
        && isString(value.resolvedBy);
    case 'tool.called':
      return isString(value.callId) && isToolReference(value.tool) && isString(value.inputHash);
    case 'tool.result':
      return isString(value.callId)
        && isString(value.status) && toolStatuses.has(value.status)
        && isString(value.outputRef)
        && (value.errorCode === undefined || isString(value.errorCode))
        && (value.reason === undefined || isString(value.reason))
        && (value.blocked === undefined || typeof value.blocked === 'boolean');
    case 'artifact.created':
      return isString(value.artifactId) && isString(value.mime) && isString(value.path);
    case 'task.completed':
      return isString(value.summaryRef);
    case 'task.failed':
      return isString(value.code) && isString(value.message);
    case 'context.compacted':
      return Array.isArray(value.retainedItemIds) && value.retainedItemIds.every(isString)
        && Array.isArray(value.compactedItemIds) && value.compactedItemIds.every(isString)
        && isFiniteNumber(value.estimatedTokensBefore)
        && isFiniteNumber(value.estimatedTokensAfter)
        && value.reason === 'budget_exceeded';
    case 'execution.blocked':
      return isString(value.callId)
        && (value.code === 'STEP_BUDGET_EXCEEDED' || value.code === 'REPEATED_TOOL_CALL')
        && isString(value.reason);
    default:
      return false;
  }
}
