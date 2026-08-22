import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TaskEvent } from '@awo/protocol';
import {
  InMemoryRunWorkspaceLedgerStore,
  InMemoryTaskFileWorkspaceStore,
  RunWorkspaceLedger,
  SqliteTaskFileWorkspaceStore,
  TaskFileWorkspace,
} from '../src/index.js';

function workspace(root: string): { ledger: RunWorkspaceLedger; files: TaskFileWorkspace } {
  const ledger = new RunWorkspaceLedger(new InMemoryRunWorkspaceLedgerStore());
  return { ledger, files: new TaskFileWorkspace(root, new InMemoryTaskFileWorkspaceStore(), ledger) };
}

function registerArtifact(ledger: RunWorkspaceLedger, taskId = 'task-1', runId = 'run-1', eventId = 'event-1'): string {
  const event: TaskEvent = {
    protocolVersion: '1.0',
    eventId,
    taskId,
    runId,
    at: 100,
    type: 'tool.result',
    callId: 'deliver',
    status: 'ok',
    outputRef: `local://task/${taskId}/deliver`,
  };
  const artifact = ledger.recordTaskEvent(event);
  assert.ok(artifact);
  return artifact.artifactLedgerId;
}

function publish(files: TaskFileWorkspace, artifactLedgerId: string, input: Partial<{ logicalPath: string; content: string; createdAt: number }> = {}) {
  return files.publishTextFile({
    taskId: 'task-1',
    runId: 'run-1',
    artifactLedgerId,
    logicalPath: input.logicalPath ?? 'src/hello.ts',
    content: input.content ?? 'export const hello = "world";\n',
    createdAt: input.createdAt ?? 101,
  });
}

test('任务文件只在已有同 task/run 的受控 artifact 后发布，并提供截断预览', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-task-files-'));
  const { ledger, files } = workspace(directory);
  const artifactLedgerId = registerArtifact(ledger);
  const record = publish(files, artifactLedgerId, { content: `${'x'.repeat(33 * 1024)}\n` });

  assert.equal(record.logicalPath, 'src/hello.ts');
  assert.equal(record.mediaType, 'text/x-source');
  assert.equal(record.canExecute, false);
  assert.equal(record.containsSensitiveContent, false);
  assert.equal(record.sha256.length, 64);
  const preview = files.preview('task-1', 'run-1', record.taskFileId);
  assert.equal(preview.language, 'typescript');
  assert.equal(preview.truncated, true);
  assert.equal(preview.content.length, 32 * 1024);
  assert.throws(() => files.preview('task-2', 'run-1', record.taskFileId), /不属于当前 task\/run/);
  rmSync(directory, { recursive: true, force: true });
});

test('任务文件拒绝任意路径、未登记 artifact、可疑凭据与不允许类型', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-task-files-'));
  const { ledger, files } = workspace(directory);
  const artifactLedgerId = registerArtifact(ledger);
  assert.throws(() => publish(files, artifactLedgerId, { logicalPath: '../escape.ts' }), /不得包含/);
  assert.throws(() => publish(files, artifactLedgerId, { logicalPath: 'program.exe' }), /不允许的任务文件类型/);
  assert.throws(() => publish(files, 'artifact-ledger:missing'), /已登记的受控 artifact/);
  assert.throws(() => publish(files, artifactLedgerId, { content: 'const key = "sk-abc12345678901234567890";' }), /疑似包含凭据/);
  rmSync(directory, { recursive: true, force: true });
});

test('任务文件以逻辑路径版本化，差异仅能读取同一 task/run 的已校验内容', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-task-files-'));
  const { ledger, files } = workspace(directory);
  const artifactLedgerId = registerArtifact(ledger);
  const first = publish(files, artifactLedgerId, { content: 'export const answer = 41;\n', createdAt: 101 });
  const second = publish(files, artifactLedgerId, { content: 'export const answer = 42;\n', createdAt: 102 });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  const diff = files.diff('task-1', 'run-1', second.taskFileId);
  assert.equal(diff.previousVersion, 1);
  assert.equal(diff.currentVersion, 2);
  assert.match(diff.content, /-export const answer = 41/);
  assert.match(diff.content, /\+export const answer = 42/);
  assert.throws(() => files.diff('task-1', 'run-2', second.taskFileId), /不属于当前 task\/run/);
  rmSync(directory, { recursive: true, force: true });
});

test('显式交付包只收集当前 task/run 文件，含受控 manifest、哈希和不可自动执行声明', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-task-files-'));
  const { ledger, files } = workspace(directory);
  const artifactLedgerId = registerArtifact(ledger);
  publish(files, artifactLedgerId, { logicalPath: 'reports/summary.md', content: '# Summary\n', createdAt: 101 });
  publish(files, artifactLedgerId, { logicalPath: 'src/hello.ts', content: 'export {}\n', createdAt: 102 });
  const receipt = files.createDelivery('task-1', 'run-1', 103);
  const delivery = files.readDelivery('task-1', 'run-1', receipt.deliveryId);

  assert.equal(receipt.fileCount, 2);
  assert.equal(receipt.canAutoExecute, false);
  assert.equal(receipt.canAutoExtract, false);
  assert.equal(delivery.content.subarray(0, 4).toString('hex'), '504b0304');
  assert.match(delivery.content.toString('utf8'), /reports\/summary\.md/);
  assert.match(delivery.content.toString('utf8'), /"canAutoExecute": false/);
  assert.throws(() => files.createDelivery('task-1', 'run-2', 104), /没有可交付文件/);
  assert.throws(() => files.readDelivery('task-2', 'run-1', receipt.deliveryId), /不属于当前 task\/run/);
  rmSync(directory, { recursive: true, force: true });
});

test('SQLite metadata 可重开，文件内容不进入记录 DTO 或数据库投影', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-task-files-'));
  const metadataPath = join(directory, 'task-files.sqlite');
  const ledger = new RunWorkspaceLedger(new InMemoryRunWorkspaceLedgerStore());
  const artifactLedgerId = registerArtifact(ledger);
  const firstStore = new SqliteTaskFileWorkspaceStore(metadataPath);
  const first = new TaskFileWorkspace(directory, firstStore, ledger);
  const record = publish(first, artifactLedgerId, { logicalPath: 'notes.txt', content: 'durable content\n' });
  first.createDelivery('task-1', 'run-1', 103);
  assert.equal(JSON.stringify(first.listFiles('task-1', 'run-1')).includes('durable content'), false);
  firstStore.close();

  const reopenedStore = new SqliteTaskFileWorkspaceStore(metadataPath);
  const reopened = new TaskFileWorkspace(directory, reopenedStore, ledger);
  assert.equal(reopened.listFiles('task-1', 'run-1')[0]?.taskFileId, record.taskFileId);
  assert.equal(reopened.preview('task-1', 'run-1', record.taskFileId).content, 'durable content\n');
  assert.equal(reopened.listDeliveries('task-1', 'run-1').length, 1);
  reopenedStore.close();
  rmSync(directory, { recursive: true, force: true });
});


test('用户上传仅生成 task/run 范围的受控文本投影，二进制不会被自动读取、解析或执行', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awo-task-upload-projection-'));
  const { ledger, files } = workspace(directory);
  const textArtifact = registerArtifact(ledger, 'task-1', 'run-1', 'event-upload-text');
  const binaryArtifact = registerArtifact(ledger, 'task-1', 'run-1', 'event-upload-binary');
  const text = files.publishUploadedFile({ taskId: 'task-1', runId: 'run-1', artifactLedgerId: textArtifact, logicalPath: 'uploads/brief.md', content: Buffer.from('# Brief\n受控文本输入。\n'), createdAt: 101 });
  const binary = files.publishUploadedFile({ taskId: 'task-1', runId: 'run-1', artifactLedgerId: binaryArtifact, logicalPath: 'uploads/sources.zip', content: Buffer.from('PK\u0003\u0004static-only'), createdAt: 102 });

  assert.equal(text.origin, 'user-upload');
  assert.equal(binary.mediaType, 'application/octet-stream');
  const projection = files.projectUserUploadedText('task-1', 'run-1');
  assert.equal(projection.textFileCount, 1);
  assert.equal(projection.skippedBinaryFileCount, 1);
  assert.match(projection.text, /uploads\/brief\.md/);
  assert.match(projection.text, /受控文本输入/);
  assert.equal(projection.canExecute, false);
  assert.equal(projection.canAutoExtract, false);
  assert.equal(projection.canForwardToProvider, false);
  assert.equal(projection.text.includes('static-only'), false);
  assert.throws(() => files.preview('task-1', 'run-1', binary.taskFileId), /不提供自动预览/);
  assert.throws(() => files.diff('task-1', 'run-1', binary.taskFileId), /不提供自动差异/);
  assert.throws(() => files.publishUploadedFile({ taskId: 'task-1', runId: 'run-1', artifactLedgerId: textArtifact, logicalPath: 'deliverables/not-user.md', content: Buffer.from('bad path'), createdAt: 103 }), /uploads 逻辑目录/);
  rmSync(directory, { recursive: true, force: true });
});
