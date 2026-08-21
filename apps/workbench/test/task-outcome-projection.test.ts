import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkbenchTaskDeliveryReceipt, WorkbenchTaskFile } from '../src/runtime/task-client.js';
import { createTaskOutcomeProjection, formatByteSize } from '../src/components/workspace/task-outcome-projection.js';

function taskFile(overrides: Partial<WorkbenchTaskFile> = {}): WorkbenchTaskFile {
  return {
    schemaVersion: 1,
    taskFileId: 'file-1',
    taskId: 'task-1',
    runId: 'run-1',
    artifactLedgerId: 'ledger-1',
    logicalPath: 'outcome/brief.md',
    displayName: 'brief.md',
    mediaType: 'text/markdown',
    byteSize: 1536,
    sha256: 'a'.repeat(64),
    version: 1,
    createdAt: 100,
    status: 'available',
    containsSensitiveContent: false,
    canExecute: false,
    ...overrides,
  };
}

function delivery(overrides: Partial<WorkbenchTaskDeliveryReceipt> = {}): WorkbenchTaskDeliveryReceipt {
  return {
    schemaVersion: 1,
    deliveryId: 'delivery-1',
    taskId: 'task-1',
    runId: 'run-1',
    fileCount: 2,
    byteSize: 2048,
    sha256: 'b'.repeat(64),
    createdAt: 100,
    status: 'available',
    canAutoExecute: false,
    canAutoExtract: false,
    ...overrides,
  };
}

test('成果投影只保留最近三个安全文件 metadata，并说明剩余项目数', () => {
  const projection = createTaskOutcomeProjection([
    taskFile({ taskFileId: 'first', displayName: 'first.md', createdAt: 1 }),
    taskFile({ taskFileId: 'second', displayName: 'second.json', mediaType: 'application/json', createdAt: 2 }),
    taskFile({ taskFileId: 'third', displayName: 'third.ts', mediaType: 'text/x-source', createdAt: 3 }),
    taskFile({ taskFileId: 'fourth', displayName: 'fourth.csv', mediaType: 'text/csv', createdAt: 4 }),
  ], []);

  assert.deepEqual(projection.visibleFiles.map((file) => file.displayName), ['fourth.csv', 'third.ts', 'second.json']);
  assert.equal(projection.hiddenFileCount, 1);
  assert.equal(projection.visibleFiles[0]?.detail, 'v1 · CSV · 2 KB');
  assert.equal(projection.latestDelivery, undefined);
});

test('成果投影只选择最新交付收据，且不将不存在的文件伪造成可交付状态', () => {
  const projection = createTaskOutcomeProjection([], [delivery({ deliveryId: 'old', createdAt: 2, fileCount: 1 }), delivery({ deliveryId: 'new', createdAt: 3, fileCount: 4, byteSize: 2 * 1024 * 1024 })]);

  assert.equal(projection.hasFiles, false);
  assert.deepEqual(projection.latestDelivery, { detail: '4 个文件 · 2.0 MB · 可供审查' });
});

test('大小格式化保持有限、可读且不泄露底层文件内容', () => {
  assert.equal(formatByteSize(0), '0 B');
  assert.equal(formatByteSize(1023), '1023 B');
  assert.equal(formatByteSize(1024), '1 KB');
  assert.equal(formatByteSize(1024 * 1024), '1.0 MB');
});
