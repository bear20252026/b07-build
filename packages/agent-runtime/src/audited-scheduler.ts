import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentProfileId, Capability } from '@awo/protocol';

export type AuditedScheduleStatus = 'candidate' | 'reviewed' | 'enabled' | 'disabled' | 'revoked';
export type MissedRunPolicy = 'skip' | 'one';
export type ScheduledRunStatus = 'ready' | 'pending_approval' | 'approved' | 'denied' | 'expired';

export interface ScheduleTaskTemplate {
  id: string;
  version: string;
  /** 模板正文的 SHA-256，正文由上层本地任务仓或 UI 草稿另行保存；调度账本不保存密钥或可执行代码。 */
  digest: string;
  title: string;
  goal: string;
  profileId: AgentProfileId;
  requestedCapabilities: readonly Capability[];
}

export interface ScheduleIntervalTrigger {
  kind: 'interval';
  everyMs: number;
  startAt: number;
  timeZone: string;
  missedRunPolicy: MissedRunPolicy;
}

export interface ScheduleRunBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxCpuMs: number;
}

/**
 * Schedule Manifest 只描述可审计的未来任务意图。它不能启动后台循环，也没有 runner、命令、URL、凭据或自动授权字段。
 */
export interface ScheduleManifestV1 {
  schemaVersion: 1;
  id: string;
  revision: number;
  status: AuditedScheduleStatus;
  displayName: string;
  taskTemplate: Readonly<ScheduleTaskTemplate>;
  trigger: Readonly<ScheduleIntervalTrigger>;
  budget: Readonly<ScheduleRunBudget>;
  requiresApproval: boolean;
  reviewedBy?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterScheduleRequest {
  id: string;
  displayName: string;
  taskTemplate: ScheduleTaskTemplate;
  trigger: ScheduleIntervalTrigger;
  budget: ScheduleRunBudget;
  requiresApproval: boolean;
  note?: string;
  at: number;
}

export interface ScheduleManifestStore {
  load(id: string): ScheduleManifestV1 | undefined;
  append(manifest: ScheduleManifestV1): void;
  history(id: string): readonly ScheduleManifestV1[];
  list(): readonly ScheduleManifestV1[];
}

export interface ScheduledRunRecord {
  schemaVersion: 1;
  runId: string;
  revision: number;
  scheduleId: string;
  scheduleRevision: number;
  scheduledFor: number;
  createdAt: number;
  status: ScheduledRunStatus;
  missedSlots: number;
  taskTemplate: Readonly<ScheduleTaskTemplate>;
  budget: Readonly<ScheduleRunBudget>;
  requiresApproval: boolean;
  approvedBy?: string;
  resolvedAt?: number;
  resolutionNote?: string;
  /** 计划运行和审批记录永远不等同于实时工具授权或执行许可证。 */
  canAuthorize: false;
  canExecute: false;
}

export interface ScheduledRunStore {
  load(runId: string): ScheduledRunRecord | undefined;
  append(run: ScheduledRunRecord): void;
  history(runId: string): readonly ScheduledRunRecord[];
  list(scheduleId?: string): readonly ScheduledRunRecord[];
}

export interface PlanScheduledRunRequest {
  scheduleId: string;
  /** 每次调度窗口必须提供独立 runId；重放同一 runId 只会返回同一审计记录。 */
  runId: string;
  at: number;
}

export interface ScheduleRunPlan {
  scheduleId: string;
  at: number;
  due: boolean;
  reason: 'not_enabled' | 'not_due' | 'planned';
  run?: ScheduledRunRecord;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIGEST = /^[a-f0-9]{64}$/i;
const CAPABILITIES = new Set<Capability>([
  'document.parse', 'model.chat', 'filesystem.read', 'filesystem.write', 'network.fetch', 'shell.execute', 'browser.control',
]);
const HIGH_RISK_CAPABILITIES = new Set<Capability>(['filesystem.write', 'network.fetch', 'shell.execute', 'browser.control']);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是正安全整数`);
}

function assertDigest(value: string, label: string): void {
  if (!DIGEST.test(value)) throw new Error(`${label} 必须是 64 位 SHA-256 十六进制摘要`);
}

function assertTimeZone(value: string): void {
  if (!value.trim() || value.length > 100) throw new Error('trigger.timeZone 必须是有效 IANA 时区');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
  } catch {
    throw new Error('trigger.timeZone 必须是有效 IANA 时区');
  }
}

function assertUniqueCapabilities(values: readonly Capability[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} 不得包含重复 capability`);
  for (const capability of values) {
    if (!CAPABILITIES.has(capability)) throw new Error(`${label} 包含未声明 capability：${capability}`);
  }
}

function copyTemplate(template: ScheduleTaskTemplate): ScheduleTaskTemplate {
  return { ...template, requestedCapabilities: [...template.requestedCapabilities] };
}

function copyTrigger(trigger: ScheduleIntervalTrigger): ScheduleIntervalTrigger {
  return { ...trigger };
}

function copyBudget(budget: ScheduleRunBudget): ScheduleRunBudget {
  return { ...budget };
}

export function copyScheduleManifest(manifest: ScheduleManifestV1): ScheduleManifestV1 {
  return {
    ...manifest,
    taskTemplate: copyTemplate(manifest.taskTemplate),
    trigger: copyTrigger(manifest.trigger),
    budget: copyBudget(manifest.budget),
  };
}

function copyRun(run: ScheduledRunRecord): ScheduledRunRecord {
  return { ...run, taskTemplate: copyTemplate(run.taskTemplate), budget: copyBudget(run.budget) };
}

function assertTemplate(template: ScheduleTaskTemplate): void {
  assertIdentifier(template.id, 'taskTemplate.id');
  if (!SEMVER.test(template.version)) throw new Error('taskTemplate.version 必须是 semver');
  assertDigest(template.digest, 'taskTemplate.digest');
  if (!template.title.trim() || template.title.trim().length > 160) throw new Error('taskTemplate.title 必须是 1-160 位文本');
  if (!template.goal.trim() || template.goal.trim().length > 4_000) throw new Error('taskTemplate.goal 必须是 1-4000 位文本');
  if (!['build', 'plan', 'explore'].includes(template.profileId)) throw new Error('taskTemplate.profileId 必须是 build、plan 或 explore');
  assertUniqueCapabilities(template.requestedCapabilities, 'taskTemplate.requestedCapabilities');
}

function assertTrigger(trigger: ScheduleIntervalTrigger): void {
  if (trigger.kind !== 'interval') throw new Error('当前仅支持 interval 触发器');
  assertPositive(trigger.everyMs, 'trigger.everyMs');
  if (trigger.everyMs < 60_000) throw new Error('trigger.everyMs 不得小于 60000 毫秒；高频轮询不属于调度控制面');
  assertEpoch(trigger.startAt, 'trigger.startAt');
  assertTimeZone(trigger.timeZone);
  if (trigger.missedRunPolicy !== 'skip' && trigger.missedRunPolicy !== 'one') throw new Error('trigger.missedRunPolicy 必须是 skip 或 one');
}

function assertBudget(budget: ScheduleRunBudget): void {
  assertPositive(budget.maxInputTokens, 'budget.maxInputTokens');
  assertPositive(budget.maxOutputTokens, 'budget.maxOutputTokens');
  assertPositive(budget.maxToolCalls, 'budget.maxToolCalls');
  assertPositive(budget.maxCpuMs, 'budget.maxCpuMs');
}

function assertRegisterRequest(request: RegisterScheduleRequest): void {
  assertIdentifier(request.id, 'id');
  if (!request.displayName.trim() || request.displayName.trim().length > 160) throw new Error('displayName 必须是 1-160 位文本');
  assertTemplate(request.taskTemplate);
  assertTrigger(request.trigger);
  assertBudget(request.budget);
  const hasHighRisk = request.taskTemplate.requestedCapabilities.some((capability) => HIGH_RISK_CAPABILITIES.has(capability));
  if (hasHighRisk && !request.requiresApproval) {
    throw new Error('包含写入、网络、Shell 或浏览器能力的 Schedule 必须 requiresApproval: true');
  }
  if (request.note !== undefined && request.note.length > 2_000) throw new Error('note 不得超过 2000 个字符');
  assertEpoch(request.at, 'at');
}

function scheduleTransition(current: AuditedScheduleStatus, next: AuditedScheduleStatus): boolean {
  return {
    candidate: next === 'reviewed' || next === 'disabled' || next === 'revoked',
    reviewed: next === 'enabled' || next === 'disabled' || next === 'revoked',
    enabled: next === 'disabled' || next === 'revoked',
    disabled: next === 'enabled' || next === 'revoked',
    revoked: false,
  }[current];
}

function runTransition(current: ScheduledRunStatus, next: ScheduledRunStatus): boolean {
  const transitions: Readonly<Record<ScheduledRunStatus, readonly ScheduledRunStatus[]>> = {
    ready: ['expired'],
    pending_approval: ['approved', 'denied', 'expired'],
    approved: [], denied: [], expired: [],
  };
  return transitions[current].includes(next);
}

export class InMemoryScheduleManifestStore implements ScheduleManifestStore {
  private readonly revisions = new Map<string, ScheduleManifestV1[]>();

  load(id: string): ScheduleManifestV1 | undefined {
    const current = this.revisions.get(id)?.at(-1);
    return current ? copyScheduleManifest(current) : undefined;
  }

  append(manifest: ScheduleManifestV1): void {
    const history = this.revisions.get(manifest.id) ?? [];
    const current = history.at(-1);
    if (!current && manifest.revision !== 1) throw new Error('新 Schedule manifest revision 必须为 1');
    if (current && manifest.revision !== current.revision + 1) throw new Error('Schedule manifest revision 必须连续递增');
    this.revisions.set(manifest.id, [...history, copyScheduleManifest(manifest)]);
  }

  history(id: string): readonly ScheduleManifestV1[] { return (this.revisions.get(id) ?? []).map(copyScheduleManifest); }

  list(): readonly ScheduleManifestV1[] {
    return [...this.revisions.values()]
      .map((history) => history.at(-1))
      .filter((value): value is ScheduleManifestV1 => value !== undefined)
      .map(copyScheduleManifest)
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }
}

interface JsonRow { value_json: string; }

export class SqliteScheduleManifestStore implements ScheduleManifestStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS audited_schedule_manifest_revisions (schedule_id TEXT NOT NULL, revision INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY (schedule_id, revision));`);
  }

  load(id: string): ScheduleManifestV1 | undefined {
    assertIdentifier(id, 'id');
    const row = this.db.prepare(`SELECT value_json FROM audited_schedule_manifest_revisions WHERE schedule_id = ? ORDER BY revision DESC LIMIT 1`).get(id) as JsonRow | undefined;
    return row ? copyScheduleManifest(JSON.parse(row.value_json) as ScheduleManifestV1) : undefined;
  }

  append(manifest: ScheduleManifestV1): void {
    const current = this.load(manifest.id);
    if (!current && manifest.revision !== 1) throw new Error('新 Schedule manifest revision 必须为 1');
    if (current && manifest.revision !== current.revision + 1) throw new Error('Schedule manifest revision 必须连续递增');
    this.db.prepare(`INSERT INTO audited_schedule_manifest_revisions (schedule_id, revision, value_json) VALUES (?, ?, ?)`)
      .run(manifest.id, manifest.revision, JSON.stringify(copyScheduleManifest(manifest)));
  }

  history(id: string): readonly ScheduleManifestV1[] {
    assertIdentifier(id, 'id');
    const rows = this.db.prepare(`SELECT value_json FROM audited_schedule_manifest_revisions WHERE schedule_id = ? ORDER BY revision ASC`).all(id) as unknown as readonly JsonRow[];
    return rows.map((row) => copyScheduleManifest(JSON.parse(row.value_json) as ScheduleManifestV1));
  }

  list(): readonly ScheduleManifestV1[] {
    const rows = this.db.prepare(`SELECT r.value_json FROM audited_schedule_manifest_revisions r INNER JOIN (SELECT schedule_id, MAX(revision) AS revision FROM audited_schedule_manifest_revisions GROUP BY schedule_id) latest ON latest.schedule_id = r.schedule_id AND latest.revision = r.revision`).all() as unknown as readonly JsonRow[];
    return rows.map((row) => copyScheduleManifest(JSON.parse(row.value_json) as ScheduleManifestV1))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
  }

  close(): void { this.db.close(); }
}

export class InMemoryScheduledRunStore implements ScheduledRunStore {
  private readonly revisions = new Map<string, ScheduledRunRecord[]>();

  load(runId: string): ScheduledRunRecord | undefined {
    const current = this.revisions.get(runId)?.at(-1);
    return current ? copyRun(current) : undefined;
  }

  append(run: ScheduledRunRecord): void {
    const history = this.revisions.get(run.runId) ?? [];
    const current = history.at(-1);
    if (!current && run.revision !== 1) throw new Error('新 schedule run revision 必须为 1');
    if (current && run.revision !== current.revision + 1) throw new Error('schedule run revision 必须连续递增');
    this.revisions.set(run.runId, [...history, copyRun(run)]);
  }

  history(runId: string): readonly ScheduledRunRecord[] { return (this.revisions.get(runId) ?? []).map(copyRun); }

  list(scheduleId?: string): readonly ScheduledRunRecord[] {
    return [...this.revisions.values()]
      .map((history) => history.at(-1))
      .filter((value): value is ScheduledRunRecord => value !== undefined)
      .filter((run) => !scheduleId || run.scheduleId === scheduleId)
      .map(copyRun)
      .sort((left, right) => left.scheduledFor - right.scheduledFor || left.runId.localeCompare(right.runId));
  }
}

export class SqliteScheduledRunStore implements ScheduledRunStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS audited_schedule_run_revisions (run_id TEXT NOT NULL, revision INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY (run_id, revision));`);
  }

  load(runId: string): ScheduledRunRecord | undefined {
    assertIdentifier(runId, 'runId');
    const row = this.db.prepare(`SELECT value_json FROM audited_schedule_run_revisions WHERE run_id = ? ORDER BY revision DESC LIMIT 1`).get(runId) as JsonRow | undefined;
    return row ? copyRun(JSON.parse(row.value_json) as ScheduledRunRecord) : undefined;
  }

  append(run: ScheduledRunRecord): void {
    const current = this.load(run.runId);
    if (!current && run.revision !== 1) throw new Error('新 schedule run revision 必须为 1');
    if (current && run.revision !== current.revision + 1) throw new Error('schedule run revision 必须连续递增');
    this.db.prepare(`INSERT INTO audited_schedule_run_revisions (run_id, revision, value_json) VALUES (?, ?, ?)`)
      .run(run.runId, run.revision, JSON.stringify(copyRun(run)));
  }

  history(runId: string): readonly ScheduledRunRecord[] {
    assertIdentifier(runId, 'runId');
    const rows = this.db.prepare(`SELECT value_json FROM audited_schedule_run_revisions WHERE run_id = ? ORDER BY revision ASC`).all(runId) as unknown as readonly JsonRow[];
    return rows.map((row) => copyRun(JSON.parse(row.value_json) as ScheduledRunRecord));
  }

  list(scheduleId?: string): readonly ScheduledRunRecord[] {
    if (scheduleId !== undefined) assertIdentifier(scheduleId, 'scheduleId');
    const rows = this.db.prepare(`SELECT r.value_json FROM audited_schedule_run_revisions r INNER JOIN (SELECT run_id, MAX(revision) AS revision FROM audited_schedule_run_revisions GROUP BY run_id) latest ON latest.run_id = r.run_id AND latest.revision = r.revision`).all() as unknown as readonly JsonRow[];
    return rows.map((row) => copyRun(JSON.parse(row.value_json) as ScheduledRunRecord))
      .filter((run) => !scheduleId || run.scheduleId === scheduleId)
      .sort((left, right) => left.scheduledFor - right.scheduledFor || left.runId.localeCompare(right.runId));
  }

  close(): void { this.db.close(); }
}

/**
 * 本地审计调度控制面。`planDueRun()` 仅确定 due slot 并创建不可执行 run record；真实执行应由后续 runtime 在实时 policy、审批和预算复核后另行 claim。
 */
export class AuditedScheduleControlPlane {
  constructor(private readonly manifests: ScheduleManifestStore, private readonly runs: ScheduledRunStore) {}

  registerCandidate(request: RegisterScheduleRequest): ScheduleManifestV1 {
    assertRegisterRequest(request);
    if (this.manifests.load(request.id)) throw new Error(`Schedule ${request.id} 已存在`);
    const manifest: ScheduleManifestV1 = {
      schemaVersion: 1, id: request.id, revision: 1, status: 'candidate', displayName: request.displayName.trim(),
      taskTemplate: copyTemplate(request.taskTemplate), trigger: copyTrigger(request.trigger), budget: copyBudget(request.budget),
      requiresApproval: request.requiresApproval, note: request.note?.trim() || undefined, createdAt: request.at, updatedAt: request.at,
    };
    this.manifests.append(manifest);
    return copyScheduleManifest(manifest);
  }

  review(id: string, reviewedBy: string, at: number, note?: string): ScheduleManifestV1 {
    return this.transition(id, 'reviewed', reviewedBy, at, note);
  }

  enable(id: string, reviewedBy: string, at: number, note?: string): ScheduleManifestV1 {
    return this.transition(id, 'enabled', reviewedBy, at, note);
  }

  disable(id: string, reviewedBy: string, at: number, note?: string): ScheduleManifestV1 {
    return this.transition(id, 'disabled', reviewedBy, at, note);
  }

  revoke(id: string, reviewedBy: string, at: number, note?: string): ScheduleManifestV1 {
    return this.transition(id, 'revoked', reviewedBy, at, note);
  }

  planDueRun(request: PlanScheduledRunRequest): ScheduleRunPlan {
    assertIdentifier(request.scheduleId, 'scheduleId');
    assertIdentifier(request.runId, 'runId');
    assertEpoch(request.at, 'at');
    const existing = this.runs.load(request.runId);
    if (existing) {
      if (existing.scheduleId !== request.scheduleId) throw new Error('runId 已绑定到其他 schedule，不得复用');
      return { scheduleId: request.scheduleId, at: request.at, due: true, reason: 'planned', run: existing };
    }
    const manifest = this.requireManifest(request.scheduleId);
    if (manifest.status !== 'enabled') return { scheduleId: manifest.id, at: request.at, due: false, reason: 'not_enabled' };
    if (request.at < manifest.trigger.startAt) return { scheduleId: manifest.id, at: request.at, due: false, reason: 'not_due' };
    const previous = this.runs.list(manifest.id).at(-1);
    const firstSlot = previous ? previous.scheduledFor + manifest.trigger.everyMs : manifest.trigger.startAt;
    if (request.at < firstSlot) return { scheduleId: manifest.id, at: request.at, due: false, reason: 'not_due' };
    const totalDueSlots = Math.floor((request.at - firstSlot) / manifest.trigger.everyMs) + 1;
    const scheduledFor = firstSlot + (totalDueSlots - 1) * manifest.trigger.everyMs;
    const missedSlots = totalDueSlots - 1;
    const run: ScheduledRunRecord = {
      schemaVersion: 1,
      runId: request.runId,
      revision: 1,
      scheduleId: manifest.id,
      scheduleRevision: manifest.revision,
      scheduledFor,
      createdAt: request.at,
      status: manifest.requiresApproval ? 'pending_approval' : 'ready',
      missedSlots,
      taskTemplate: copyTemplate(manifest.taskTemplate),
      budget: copyBudget(manifest.budget),
      requiresApproval: manifest.requiresApproval,
      canAuthorize: false,
      canExecute: false,
    };
    this.runs.append(run);
    return { scheduleId: manifest.id, at: request.at, due: true, reason: 'planned', run: copyRun(run) };
  }

  approveRun(runId: string, reviewedBy: string, at: number, note?: string): ScheduledRunRecord {
    return this.resolveRun(runId, 'approved', reviewedBy, at, note);
  }

  denyRun(runId: string, reviewedBy: string, at: number, note?: string): ScheduledRunRecord {
    return this.resolveRun(runId, 'denied', reviewedBy, at, note);
  }

  expireRun(runId: string, at: number, note?: string): ScheduledRunRecord {
    return this.resolveRun(runId, 'expired', 'system-expiry', at, note);
  }

  getSchedule(id: string): ScheduleManifestV1 | undefined {
    assertIdentifier(id, 'id');
    const manifest = this.manifests.load(id);
    return manifest ? copyScheduleManifest(manifest) : undefined;
  }

  listSchedules(): readonly ScheduleManifestV1[] { return this.manifests.list().map(copyScheduleManifest); }

  listRuns(scheduleId?: string): readonly ScheduledRunRecord[] {
    if (scheduleId !== undefined) assertIdentifier(scheduleId, 'scheduleId');
    return this.runs.list(scheduleId).map(copyRun);
  }

  approvalInbox(): readonly ScheduledRunRecord[] {
    return this.runs.list().filter((run) => run.status === 'pending_approval').map(copyRun);
  }

  private transition(id: string, status: AuditedScheduleStatus, reviewedBy: string, at: number, note?: string): ScheduleManifestV1 {
    assertIdentifier(id, 'id'); assertIdentifier(reviewedBy, 'reviewedBy'); assertEpoch(at, 'at');
    if (note !== undefined && note.length > 2_000) throw new Error('note 不得超过 2000 个字符');
    const current = this.requireManifest(id);
    if (!scheduleTransition(current.status, status)) throw new Error(`Schedule 状态不能从 ${current.status} 转为 ${status}`);
    const next: ScheduleManifestV1 = {
      ...current, taskTemplate: copyTemplate(current.taskTemplate), trigger: copyTrigger(current.trigger), budget: copyBudget(current.budget),
      revision: current.revision + 1, status, reviewedBy, note: note?.trim() || current.note, updatedAt: at,
    };
    this.manifests.append(next);
    return copyScheduleManifest(next);
  }

  private resolveRun(runId: string, status: Extract<ScheduledRunStatus, 'approved' | 'denied' | 'expired'>, reviewedBy: string, at: number, note?: string): ScheduledRunRecord {
    assertIdentifier(runId, 'runId'); assertIdentifier(reviewedBy, 'reviewedBy'); assertEpoch(at, 'at');
    if (note !== undefined && note.length > 2_000) throw new Error('note 不得超过 2000 个字符');
    const current = this.runs.load(runId);
    if (!current) throw new Error(`Schedule run ${runId} 不存在`);
    const manifest = this.requireManifest(current.scheduleId);
    if (manifest.status !== 'enabled' || manifest.revision !== current.scheduleRevision) {
      throw new Error(`Schedule ${current.scheduleId} 已停用、撤销或更新；不得处理既有 run`);
    }
    if (!runTransition(current.status, status)) throw new Error(`Schedule run 状态不能从 ${current.status} 转为 ${status}`);
    const next: ScheduledRunRecord = {
      ...current, taskTemplate: copyTemplate(current.taskTemplate), budget: copyBudget(current.budget),
      revision: current.revision + 1, status, approvedBy: reviewedBy, resolvedAt: at,
      resolutionNote: note?.trim() || undefined, canAuthorize: false, canExecute: false,
    };
    this.runs.append(next);
    return copyRun(next);
  }

  private requireManifest(id: string): ScheduleManifestV1 {
    const manifest = this.manifests.load(id);
    if (!manifest) throw new Error(`Schedule ${id} 不存在`);
    return manifest;
  }
}
