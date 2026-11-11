import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { createWorkflowScriptHost, createFileJournalStore, journalStoreFromPath } from '../workflow-script-host.js';

// ---------------------------------------------------------------------------
// 宿主适配层：把 workflow-script 的执行端口接到真实本地 IO。
//
// 这里验的是"端口真的接到了 IO 上"，而不是 mock 的行为 —— 比如 world.run
// 真的会 spawn 进程、journal 真的会落盘。用真实临时目录，不 mock fs。
// ---------------------------------------------------------------------------

/** 造一个临时目录，测试结束清掉。 */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'awo-wf-host-'));
}

test('world.run 真的 spawn 进程并回传 stdout', async () => {
  const host = createWorkflowScriptHost({ announce: false });
  const result = await host.runtime.run('node', ['-e', 'console.log("hi from child")']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hi from child/);
});

test('world.run 非零退出不算抛异常，而是回传 exitCode', async () => {
  // 关键语义：脚本要靠 exitCode 判断成败，不是靠异常。
  const host = createWorkflowScriptHost({ announce: false });
  const result = await host.runtime.run('node', ['-e', 'process.exit(3)']);
  assert.equal(result.exitCode, 3);
});

test('world.run 的 cwd 由 workdir 决定', async () => {
  const dir = makeTempDir();
  try {
    const host = createWorkflowScriptHost({ workdir: dir, announce: false });
    const result = await host.runtime.run('node', ['-e', 'console.log(process.cwd())']);
    assert.equal(result.exitCode, 0);
    // Windows 上路径大小写与分隔符可能不同，只比规范化后的形式。
    assert.equal(result.stdout.trim().toLowerCase(), dir.toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('files.read 读得到真实文件', async () => {
  const dir = makeTempDir();
  try {
    writeFileSync(join(dir, 'note.txt'), '内容在这里');
    const host = createWorkflowScriptHost({ announce: false });
    assert.equal(await host.runtime.read(join(dir, 'note.txt')), '内容在这里');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('files.glob 明确报错而不是返回空', async () => {
  // 返回空会让脚本以为"没有匹配的文件"—— 那是静默的错误，比报错危险。
  const host = createWorkflowScriptHost({ announce: false });
  await assert.rejects(() => host.runtime.glob('*.ts'), /不支持/);
  await assert.rejects(() => host.runtime.grep('foo'), /不支持/);
});

test('ask 从注入的流里读一行', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const host = createWorkflowScriptHost({ input, output, announce: false });
  const question = host.runtime.ask('要跑吗');
  input.write('好的\n');
  assert.equal(await question, '好的');
});

test('ask 空输入返回 null（表示跳过）', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const host = createWorkflowScriptHost({ input, output, announce: false });
  const question = host.runtime.ask('要跑吗');
  input.write('\n');
  assert.equal(await question, null);
});

// ---------------------------------------------------------------------------
// journal 端口：落盘 → 读回 → 续跑。
// ---------------------------------------------------------------------------

test('journal 落盘后能读回来', () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'journal.json');
    const store = createFileJournalStore(path);
    assert.equal(store.load(), undefined, '文件不存在时是 undefined');

    // 写一份"上一轮"的记录进去。
    store.save({
      schemaVersion: 1,
      runId: path,
      records: [{ siteId: 'world-run#1', attempt: 1, result: { exitCode: 0, stdout: '旧的', stderr: '' } }],
    });

    const loaded = store.load();
    assert.equal(loaded?.records.length, 1);
    assert.equal(loaded?.records[0]?.siteId, 'world-run#1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal 文件坏了时返回 undefined 且不抛', () => {
  // 文件坏了不该让整轮跑挂掉。但调用方必须知道（宿主会打警告）。
  const dir = makeTempDir();
  try {
    const path = join(dir, 'journal.json');
    writeFileSync(path, '{ 这不是 JSON');
    const store = createFileJournalStore(path);
    assert.equal(store.load(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal 文件内容不合法时返回 undefined', () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'journal.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, runId: 'r', records: [] }));
    assert.equal(createFileJournalStore(path).load(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journalStoreFromPath：不给路径就没有端口', () => {
  // 没有落盘位置时不该造一个指向 undefined 的端口。
  assert.equal(journalStoreFromPath(undefined), undefined);
  assert.ok(journalStoreFromPath('/tmp/x.json'));
});

test('journal 真的写到磁盘上（不只是内存）', () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'journal.json');
    createFileJournalStore(path).save({
      schemaVersion: 1,
      runId: 'r',
      records: [{ siteId: 'ask#1', attempt: 1, result: '答案' }],
    });
    assert.ok(existsSync(path));
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { records: unknown[] };
    assert.equal(onDisk.records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
