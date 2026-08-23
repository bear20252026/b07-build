import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunWorkspaceLedger } from './run-workspace-ledger.js';

export const TASK_FILE_SCHEMA_VERSION = 1 as const;

export type TaskFileMediaType = 'text/plain' | 'text/markdown' | 'application/json' | 'text/csv' | 'text/x-source' | 'application/octet-stream';

export interface TaskFileRecordV1 {
  schemaVersion: typeof TASK_FILE_SCHEMA_VERSION;
  taskFileId: string;
  taskId: string;
  runId: string;
  artifactLedgerId: string;
  logicalPath: string;
  displayName: string;
  mediaType: TaskFileMediaType;
  byteSize: number;
  sha256: string;
  version: number;
  createdAt: number;
  status: 'available';
  origin: 'generated' | 'user-upload';
  containsSensitiveContent: false;
  canExecute: false;
}

export interface ControlledTaskInputProjectionV1 {
  taskId: string;
  runId: string;
  textFileCount: number;
  skippedBinaryFileCount: number;
  text: string;
  truncated: boolean;
  canExecute: false;
  canAutoExtract: false;
  canForwardToProvider: false;
}

export interface TaskFilePreviewV1 {
  taskFileId: string;
  logicalPath: string;
  language: string;
  content: string;
  lineCount: number;
  truncated: boolean;
  byteSize: number;
  sha256: string;
}

export interface TaskFileDiffV1 {
  taskFileId: string;
  logicalPath: string;
  previousVersion: number | undefined;
  currentVersion: number;
  content: string;
  truncated: boolean;
}

export interface TaskDeliveryReceiptV1 {
  schemaVersion: typeof TASK_FILE_SCHEMA_VERSION;
  deliveryId: string;
  taskId: string;
  runId: string;
  fileCount: number;
  byteSize: number;
  sha256: string;
  createdAt: number;
  status: 'available';
  canAutoExecute: false;
  canAutoExtract: false;
}

export interface TaskFileWorkspaceStore {
  appendFile(record: TaskFileRecordV1): void;
  listFiles(taskId: string, runId: string): readonly TaskFileRecordV1[];
  findFile(taskId: string, runId: string, taskFileId: string): TaskFileRecordV1 | undefined;
  appendDelivery(receipt: TaskDeliveryReceiptV1): void;
  listDeliveries(taskId: string, runId: string): readonly TaskDeliveryReceiptV1[];
  findDelivery(taskId: string, runId: string, deliveryId: string): TaskDeliveryReceiptV1 | undefined;
  close?(): void;
}

export interface PublishTaskTextFileInput {
  taskId: string;
  runId: string;
  artifactLedgerId: string;
  logicalPath: string;
  content: string;
  createdAt: number;
}

export interface PublishUploadedTaskFileInput {
  taskId: string;
  runId: string;
  artifactLedgerId: string;
  logicalPath: string;
  content: Buffer;
  createdAt: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOGICAL_PATH_MAX_LENGTH = 160;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 32 * 1024;
const MAX_TASK_INPUT_PROJECTION_BYTES = 64 * 1024;
const MAX_FILES_PER_RUN = 64;
const MAX_DELIVERY_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_BYTES = 64 * 1024;
const ALLOWED_EXTENSIONS = new Map<string, { mediaType: TaskFileMediaType; language: string }>([
  ['.txt', { mediaType: 'text/plain', language: 'text' }],
  ['.md', { mediaType: 'text/markdown', language: 'markdown' }],
  ['.json', { mediaType: 'application/json', language: 'json' }],
  ['.csv', { mediaType: 'text/csv', language: 'csv' }],
  ['.ts', { mediaType: 'text/x-source', language: 'typescript' }],
  ['.tsx', { mediaType: 'text/x-source', language: 'tsx' }],
  ['.js', { mediaType: 'text/x-source', language: 'javascript' }],
  ['.jsx', { mediaType: 'text/x-source', language: 'jsx' }],
  ['.py', { mediaType: 'text/x-source', language: 'python' }],
  ['.rs', { mediaType: 'text/x-source', language: 'rust' }],
  ['.css', { mediaType: 'text/x-source', language: 'css' }],
  ['.html', { mediaType: 'text/x-source', language: 'html' }],
  ['.yaml', { mediaType: 'text/x-source', language: 'yaml' }],
  ['.yml', { mediaType: 'text/x-source', language: 'yaml' }],
]);

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} 必须是 1-128 位安全标识符`);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`);
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function copyFileRecord(record: TaskFileRecordV1): TaskFileRecordV1 {
  return { ...record };
}

function copyDeliveryReceipt(receipt: TaskDeliveryReceiptV1): TaskDeliveryReceiptV1 {
  return { ...receipt };
}

function assertLogicalPath(logicalPath: string): void {
  if (
    logicalPath.length === 0 || logicalPath.length > LOGICAL_PATH_MAX_LENGTH || logicalPath.includes('\\') || logicalPath.includes('\0')
    || logicalPath.startsWith('/') || logicalPath.endsWith('/')
  ) {
    throw new Error('logicalPath 必须是 1-160 位的安全相对 POSIX 路径');
  }
  const segments = logicalPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('logicalPath 不得包含空段、. 或 ..');
  }
}

function metadataForPath(logicalPath: string, allowBinary = false): { mediaType: TaskFileMediaType; language: string } {
  assertLogicalPath(logicalPath);
  const extensionStart = logicalPath.lastIndexOf('.');
  const extension = extensionStart >= 0 ? logicalPath.slice(extensionStart).toLowerCase() : '';
  const metadata = ALLOWED_EXTENSIONS.get(extension);
  if (metadata) return metadata;
  if (allowBinary) return { mediaType: 'application/octet-stream', language: 'binary' };
  throw new Error(`不允许的任务文件类型：${extension || '(无扩展名)'}`);
}

function taskFileId(taskId: string, runId: string, logicalPath: string, version: number): string {
  return `task-file:${sha256(`${taskId}:${runId}:${logicalPath}:${version}`)}`;
}

function deliveryId(taskId: string, runId: string, requestKey: string): string {
  return `delivery:${sha256(`${taskId}:${runId}:${requestKey}`)}`;
}

function assertDeliveryRequestKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new Error('delivery request key 必须是 8-128 位安全幂等标识符');
  }
}

function textFromBuffer(buffer: Buffer): string {
  return buffer.toString('utf8');
}

function lineCount(content: string): number {
  if (!content) return 0;
  return content.endsWith('\n') ? content.slice(0, -1).split('\n').length : content.split('\n').length;
}

function assertNoCredentialLikeContent(content: string): void {
  // P13 只允许业务文本和代码进入任务文件。此检查是纵深防御，不能替代 credentialReference 边界。
  if (/(?:^|[\s"'])sk-[A-Za-z0-9_-]{20,}|(?:^|[\s"'])ghp_[A-Za-z0-9]{20,}|authorization\s*:\s*bearer\s+\S+/i.test(content)) {
    throw new Error('任务文件疑似包含凭据；已拒绝写入');
  }
}

function resolveContainedPath(root: string, ...segments: readonly string[]): string {
  const path = resolve(root, ...segments);
  const pathWithinRoot = relative(root, path);
  if (!pathWithinRoot || pathWithinRoot === '..' || pathWithinRoot.startsWith('..\\') || pathWithinRoot.startsWith('../') || isAbsolute(pathWithinRoot)) {
    throw new Error('受控任务文件路径越界');
  }
  return path;
}

/**
 * 逻辑 ID 允许 `:` 用于可读命名空间（如 `delivery:<digest>`），但 Windows 禁止它出现在
 * 物理路径段中。输入标识符不允许 `%`，因此 `%3A` 是无碰撞、可逆且跨平台的文件名映射。
 */
function storagePathSegment(identifier: string): string {
  return identifier.replaceAll(':', '%3A');
}

function previousVersion(records: readonly TaskFileRecordV1[], record: TaskFileRecordV1): TaskFileRecordV1 | undefined {
  return records
    .filter((candidate) => candidate.logicalPath === record.logicalPath && candidate.version < record.version)
    .sort((left, right) => right.version - left.version)[0];
}

function simpleUnifiedDiff(previous: string, current: string, logicalPath: string): string {
  if (previous === current) return `--- a/${logicalPath}\n+++ b/${logicalPath}\n@@ 变更为空 @@\n`;
  const before = previous.split('\n');
  const after = current.split('\n');
  const prefix: string[] = [];
  while (prefix.length < before.length && prefix.length < after.length && before[prefix.length] === after[prefix.length]) prefix.push(before[prefix.length] ?? '');
  const suffix: string[] = [];
  while (
    suffix.length < before.length - prefix.length && suffix.length < after.length - prefix.length
    && before[before.length - 1 - suffix.length] === after[after.length - 1 - suffix.length]
  ) suffix.push(before[before.length - 1 - suffix.length] ?? '');
  const lines = [`--- a/${logicalPath}`, `+++ b/${logicalPath}`, `@@ -${prefix.length + 1},${before.length - prefix.length - suffix.length} +${prefix.length + 1},${after.length - prefix.length - suffix.length} @@`];
  for (const line of before.slice(prefix.length, before.length - suffix.length)) lines.push(`-${line}`);
  for (const line of after.slice(prefix.length, after.length - suffix.length)) lines.push(`+${line}`);
  return `${lines.join('\n')}\n`;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  content: Buffer;
}

/** 仅生成 store-only ZIP，避免引入解压器、脚本或外部进程。 */
function createStoredZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, entry.content);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralEntries.push(central);
    offset += local.length + entry.content.length;
  }
  const centralDirectory = Buffer.concat(centralEntries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}

/**
 * 任务专项文件领域服务。所有读写都从 task/run/file ID 重新推导本地路径；SQLite 仅保存脱敏 metadata。
 * 调用者必须在 ControlledToolRunner 的成功事件已登记到 RunWorkspaceLedger 之后才可以发布文件。
 */
export class TaskFileWorkspace {
  private readonly root: string;
  private readonly deliveriesRoot: string;

  constructor(
    rootDirectory: string,
    private readonly store: TaskFileWorkspaceStore,
    private readonly runWorkspace: Pick<RunWorkspaceLedger, 'listArtifacts'>,
  ) {
    this.root = resolve(rootDirectory, 'task-files');
    this.deliveriesRoot = resolve(rootDirectory, 'task-deliveries');
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.deliveriesRoot, { recursive: true });
  }

  publishTextFile(input: PublishTaskTextFileInput): TaskFileRecordV1 {
    assertNoCredentialLikeContent(input.content);
    return this.publishFile({ ...input, content: Buffer.from(input.content, 'utf8') }, false, 'generated');
  }

  /** 用户显式上传只可作为静态、不可信、不可执行 task/run 附件写入。 */
  validateUploadedFile(logicalPath: string, content: Buffer): void {
    if (!logicalPath.startsWith('uploads/')) throw new Error('用户上传只能写入 task/run 专属 uploads 逻辑目录');
    metadataForPath(logicalPath, true);
    if (content.length === 0 || content.length > MAX_FILE_BYTES) throw new Error(`用户上传文件必须为 1-${MAX_FILE_BYTES} 字节`);
    // 按 UTF-8 尝试扫描，避免文本型 API key、token、私钥被静默写入任务文件区；二进制只保存、不读取。
    assertNoCredentialLikeContent(content.toString('utf8'));
  }

  publishUploadedFile(input: PublishUploadedTaskFileInput): TaskFileRecordV1 {
    this.validateUploadedFile(input.logicalPath, input.content);
    return this.publishFile(input, true, 'user-upload');
  }

  private publishFile(input: PublishUploadedTaskFileInput, allowBinary: boolean, origin: TaskFileRecordV1['origin']): TaskFileRecordV1 {
    assertIdentifier(input.taskId, 'taskId');
    assertIdentifier(input.runId, 'runId');
    assertIdentifier(input.artifactLedgerId, 'artifactLedgerId');
    assertEpoch(input.createdAt, 'createdAt');
    const pathMetadata = metadataForPath(input.logicalPath, allowBinary);
    const content = input.content;
    if (content.length > MAX_FILE_BYTES) throw new Error(`任务文件超过 ${MAX_FILE_BYTES} 字节上限`);
    const artifacts = this.runWorkspace.listArtifacts(input.taskId, input.runId);
    if (!artifacts.some((artifact) => artifact.artifactLedgerId === input.artifactLedgerId)) throw new Error('任务文件必须关联到同一 task/run 中已登记的受控 artifact');
    const records = this.store.listFiles(input.taskId, input.runId);
    if (records.length >= MAX_FILES_PER_RUN) throw new Error(`每个任务运行最多发布 ${MAX_FILES_PER_RUN} 个文件`);
    const version = Math.max(0, ...records.filter((record) => record.logicalPath === input.logicalPath).map((record) => record.version)) + 1;
    const record: TaskFileRecordV1 = {
      schemaVersion: TASK_FILE_SCHEMA_VERSION, taskFileId: taskFileId(input.taskId, input.runId, input.logicalPath, version), taskId: input.taskId, runId: input.runId,
      artifactLedgerId: input.artifactLedgerId, logicalPath: input.logicalPath, displayName: basename(input.logicalPath), mediaType: pathMetadata.mediaType,
      byteSize: content.length, sha256: sha256(content), version, createdAt: input.createdAt, status: 'available', origin, containsSensitiveContent: false, canExecute: false,
    };
    const filePath = this.filePath(record.taskId, record.runId, record.taskFileId);
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) throw new Error(`任务文件版本已存在：${record.taskFileId}`);
    writeFileSync(filePath, content, { flag: 'wx' });
    try { this.store.appendFile(record); return copyFileRecord(record); } catch (error) { rmSync(filePath, { force: true }); throw error; }
  }

  listFiles(taskId: string, runId: string): readonly TaskFileRecordV1[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    return this.store.listFiles(taskId, runId).map(copyFileRecord);
  }

  /**
   * 受控读取步骤专用的瞬时用户输入投影。它只读取本 task/run 的已验证文本上传，
   * 绝不解压/执行二进制，也不会进入 SQLite、事件或 HTTP DTO。
   */
  projectUserUploadedText(taskId: string, runId: string): ControlledTaskInputProjectionV1 {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    let remaining = MAX_TASK_INPUT_PROJECTION_BYTES;
    let textFileCount = 0;
    let skippedBinaryFileCount = 0;
    let truncated = false;
    const sections: string[] = [];
    for (const record of this.store.listFiles(taskId, runId).filter((item) => item.origin === 'user-upload').sort((left, right) => left.createdAt - right.createdAt || left.taskFileId.localeCompare(right.taskFileId))) {
      if (record.mediaType === 'application/octet-stream') { skippedBinaryFileCount += 1; continue; }
      if (remaining <= 0) { truncated = true; break; }
      const content = this.readVerifiedContent(record);
      const included = content.subarray(0, remaining);
      if (included.length < content.length) truncated = true;
      remaining -= included.length;
      textFileCount += 1;
      sections.push(`--- ${record.logicalPath} · sha256:${record.sha256} ---\n${textFromBuffer(included)}`);
    }
    return { taskId, runId, textFileCount, skippedBinaryFileCount, text: sections.join('\n\n'), truncated, canExecute: false, canAutoExtract: false, canForwardToProvider: false };
  }

  preview(taskId: string, runId: string, taskFileId: string): TaskFilePreviewV1 {
    const record = this.requireFile(taskId, runId, taskFileId);
    if (record.mediaType === 'application/octet-stream') throw new Error('未知二进制附件不提供自动预览、解析或内容读取');
    const content = this.readVerifiedContent(record);
    const truncated = content.subarray(0, MAX_PREVIEW_BYTES);
    const metadata = metadataForPath(record.logicalPath);
    const text = textFromBuffer(truncated);
    return {
      taskFileId: record.taskFileId,
      logicalPath: record.logicalPath,
      language: metadata.language,
      content: text,
      lineCount: lineCount(text),
      truncated: content.length > truncated.length,
      byteSize: record.byteSize,
      sha256: record.sha256,
    };
  }

  diff(taskId: string, runId: string, taskFileId: string): TaskFileDiffV1 {
    const record = this.requireFile(taskId, runId, taskFileId);
    if (record.mediaType === 'application/octet-stream') throw new Error('未知二进制附件不提供自动差异、解析或内容读取');
    const allRecords = this.store.listFiles(taskId, runId);
    const previous = previousVersion(allRecords, record);
    const currentContent = this.readVerifiedContent(record);
    const previousContent = previous ? this.readVerifiedContent(previous) : Buffer.alloc(0);
    const fullDiff = simpleUnifiedDiff(textFromBuffer(previousContent), textFromBuffer(currentContent), record.logicalPath);
    const content = Buffer.from(fullDiff, 'utf8');
    return {
      taskFileId: record.taskFileId,
      logicalPath: record.logicalPath,
      previousVersion: previous?.version,
      currentVersion: record.version,
      content: textFromBuffer(content.subarray(0, MAX_DIFF_BYTES)),
      truncated: content.length > MAX_DIFF_BYTES,
    };
  }

  createDelivery(taskId: string, runId: string, createdAt = Date.now(), requestKey = `local-${createdAt}`): TaskDeliveryReceiptV1 {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    assertEpoch(createdAt, 'createdAt');
    assertDeliveryRequestKey(requestKey);
    const nextDeliveryId = deliveryId(taskId, runId, requestKey);
    const existingDelivery = this.store.findDelivery(taskId, runId, nextDeliveryId);
    if (existingDelivery) return copyDeliveryReceipt(existingDelivery);
    const records = this.store.listFiles(taskId, runId);
    if (records.length === 0) throw new Error('当前任务没有可交付文件');
    const totalContentBytes = records.reduce((sum, record) => sum + record.byteSize, 0);
    if (totalContentBytes > MAX_DELIVERY_BYTES) throw new Error(`任务文件总大小超过 ${MAX_DELIVERY_BYTES} 字节交付上限`);
    const entries = records.map((record) => ({ name: record.logicalPath, content: this.readVerifiedContent(record) }));
    const manifest = Buffer.from(`${JSON.stringify({
      schemaVersion: TASK_FILE_SCHEMA_VERSION,
      taskId,
      runId,
      files: records.map((record) => ({
        taskFileId: record.taskFileId,
        logicalPath: record.logicalPath,
        mediaType: record.mediaType,
        byteSize: record.byteSize,
        sha256: record.sha256,
        version: record.version,
      })),
      canAutoExecute: false,
      canAutoExtract: false,
    }, null, 2)}\n`, 'utf8');
    const zip = createStoredZip([...entries, { name: 'manifest.json', content: manifest }]);
    if (zip.length > MAX_DELIVERY_BYTES) throw new Error(`交付包超过 ${MAX_DELIVERY_BYTES} 字节上限`);
    const receipt: TaskDeliveryReceiptV1 = {
      schemaVersion: TASK_FILE_SCHEMA_VERSION,
      deliveryId: nextDeliveryId,
      taskId,
      runId,
      fileCount: records.length,
      byteSize: zip.length,
      sha256: sha256(zip),
      createdAt,
      status: 'available',
      canAutoExecute: false,
      canAutoExtract: false,
    };
    const finalPath = this.deliveryPath(taskId, runId, receipt.deliveryId);
    const temporaryPath = `${finalPath}.tmp`;
    mkdirSync(dirname(finalPath), { recursive: true });
    writeFileSync(temporaryPath, zip, { flag: 'wx' });
    try {
      renameSync(temporaryPath, finalPath);
      this.store.appendDelivery(receipt);
      return copyDeliveryReceipt(receipt);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      rmSync(finalPath, { force: true });
      throw error;
    }
  }

  listDeliveries(taskId: string, runId: string): readonly TaskDeliveryReceiptV1[] {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    return this.store.listDeliveries(taskId, runId).map(copyDeliveryReceipt);
  }

  readDelivery(taskId: string, runId: string, deliveryIdValue: string): { receipt: TaskDeliveryReceiptV1; content: Buffer } {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    assertIdentifier(deliveryIdValue, 'deliveryId');
    const receipt = this.store.findDelivery(taskId, runId, deliveryIdValue);
    if (!receipt) throw new Error('任务交付包不存在或不属于当前 task/run');
    const filePath = this.deliveryPath(taskId, runId, deliveryIdValue);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error('任务交付包源文件不可用');
    const content = readFileSync(filePath);
    if (content.length !== receipt.byteSize || sha256(content) !== receipt.sha256) throw new Error('任务交付包完整性校验失败');
    return { receipt: copyDeliveryReceipt(receipt), content };
  }

  private requireFile(taskId: string, runId: string, taskFileIdValue: string): TaskFileRecordV1 {
    assertIdentifier(taskId, 'taskId');
    assertIdentifier(runId, 'runId');
    assertIdentifier(taskFileIdValue, 'taskFileId');
    const record = this.store.findFile(taskId, runId, taskFileIdValue);
    if (!record) throw new Error('任务文件不存在或不属于当前 task/run');
    return copyFileRecord(record);
  }

  private readVerifiedContent(record: TaskFileRecordV1): Buffer {
    const filePath = this.filePath(record.taskId, record.runId, record.taskFileId);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error('任务文件源文件不可用');
    const content = readFileSync(filePath);
    if (content.length !== record.byteSize || sha256(content) !== record.sha256) throw new Error('任务文件完整性校验失败');
    return content;
  }

  private filePath(taskId: string, runId: string, taskFileIdValue: string): string {
    return resolveContainedPath(this.root, storagePathSegment(taskId), storagePathSegment(runId), `${storagePathSegment(taskFileIdValue)}.data`);
  }

  private deliveryPath(taskId: string, runId: string, deliveryIdValue: string): string {
    return resolveContainedPath(this.deliveriesRoot, storagePathSegment(taskId), storagePathSegment(runId), `${storagePathSegment(deliveryIdValue)}.zip`);
  }
}

export class InMemoryTaskFileWorkspaceStore implements TaskFileWorkspaceStore {
  private readonly files = new Map<string, TaskFileRecordV1>();
  private readonly deliveries = new Map<string, TaskDeliveryReceiptV1>();

  appendFile(record: TaskFileRecordV1): void {
    if (this.files.has(record.taskFileId)) throw new Error(`任务文件已存在：${record.taskFileId}`);
    this.files.set(record.taskFileId, copyFileRecord(record));
  }

  listFiles(taskId: string, runId: string): readonly TaskFileRecordV1[] {
    return [...this.files.values()]
      .filter((record) => record.taskId === taskId && record.runId === runId)
      .sort((left, right) => left.createdAt - right.createdAt || left.taskFileId.localeCompare(right.taskFileId))
      .map(copyFileRecord);
  }

  findFile(taskId: string, runId: string, taskFileIdValue: string): TaskFileRecordV1 | undefined {
    const record = this.files.get(taskFileIdValue);
    return record && record.taskId === taskId && record.runId === runId ? copyFileRecord(record) : undefined;
  }

  appendDelivery(receipt: TaskDeliveryReceiptV1): void {
    if (this.deliveries.has(receipt.deliveryId)) throw new Error(`任务交付包已存在：${receipt.deliveryId}`);
    this.deliveries.set(receipt.deliveryId, copyDeliveryReceipt(receipt));
  }

  listDeliveries(taskId: string, runId: string): readonly TaskDeliveryReceiptV1[] {
    return [...this.deliveries.values()]
      .filter((receipt) => receipt.taskId === taskId && receipt.runId === runId)
      .sort((left, right) => right.createdAt - left.createdAt || left.deliveryId.localeCompare(right.deliveryId))
      .map(copyDeliveryReceipt);
  }

  findDelivery(taskId: string, runId: string, deliveryIdValue: string): TaskDeliveryReceiptV1 | undefined {
    const receipt = this.deliveries.get(deliveryIdValue);
    return receipt && receipt.taskId === taskId && receipt.runId === runId ? copyDeliveryReceipt(receipt) : undefined;
  }
}

/** SQLite WAL metadata store；内容保存在专属受控目录，绝不进入 SQLite/事件/DTO。 */
export class SqliteTaskFileWorkspaceStore implements TaskFileWorkspaceStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_file_records (
        task_file_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        logical_path TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE(task_id, run_id, logical_path, version)
      );
      CREATE TABLE IF NOT EXISTS task_delivery_receipts (
        delivery_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        receipt_json TEXT NOT NULL
      );
    `);
  }

  appendFile(record: TaskFileRecordV1): void {
    this.db.prepare(`
      INSERT INTO task_file_records (task_file_id, task_id, run_id, logical_path, version, created_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(record.taskFileId, record.taskId, record.runId, record.logicalPath, record.version, record.createdAt, JSON.stringify(copyFileRecord(record)));
  }

  listFiles(taskId: string, runId: string): readonly TaskFileRecordV1[] {
    const rows = this.db.prepare(`
      SELECT record_json FROM task_file_records WHERE task_id = ? AND run_id = ? ORDER BY created_at ASC, task_file_id ASC
    `).all(taskId, runId) as unknown as readonly { record_json: string }[];
    return rows.map((row) => copyFileRecord(JSON.parse(row.record_json) as TaskFileRecordV1));
  }

  findFile(taskId: string, runId: string, taskFileIdValue: string): TaskFileRecordV1 | undefined {
    const row = this.db.prepare(`
      SELECT record_json FROM task_file_records WHERE task_id = ? AND run_id = ? AND task_file_id = ?
    `).get(taskId, runId, taskFileIdValue) as { record_json: string } | undefined;
    return row ? copyFileRecord(JSON.parse(row.record_json) as TaskFileRecordV1) : undefined;
  }

  appendDelivery(receipt: TaskDeliveryReceiptV1): void {
    this.db.prepare(`
      INSERT INTO task_delivery_receipts (delivery_id, task_id, run_id, created_at, receipt_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(receipt.deliveryId, receipt.taskId, receipt.runId, receipt.createdAt, JSON.stringify(copyDeliveryReceipt(receipt)));
  }

  listDeliveries(taskId: string, runId: string): readonly TaskDeliveryReceiptV1[] {
    const rows = this.db.prepare(`
      SELECT receipt_json FROM task_delivery_receipts WHERE task_id = ? AND run_id = ? ORDER BY created_at DESC, delivery_id ASC
    `).all(taskId, runId) as unknown as readonly { receipt_json: string }[];
    return rows.map((row) => copyDeliveryReceipt(JSON.parse(row.receipt_json) as TaskDeliveryReceiptV1));
  }

  findDelivery(taskId: string, runId: string, deliveryIdValue: string): TaskDeliveryReceiptV1 | undefined {
    const row = this.db.prepare(`
      SELECT receipt_json FROM task_delivery_receipts WHERE task_id = ? AND run_id = ? AND delivery_id = ?
    `).get(taskId, runId, deliveryIdValue) as { receipt_json: string } | undefined;
    return row ? copyDeliveryReceipt(JSON.parse(row.receipt_json) as TaskDeliveryReceiptV1) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
