import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectClient, parseProjectLedger } from '../src/runtime/project-client.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
}

test('本地项目可创建、重开读取并关联任务，不依赖 Gateway 或 Provider', async () => {
  const storage = memoryStorage();
  const first = createProjectClient(storage);
  const project = await first.create({ title: '第一项目', description: '本地 metadata' });
  await first.attachTask({ projectId: project.projectId, taskId: 'task-1', runId: 'run-1' });

  const second = createProjectClient(storage);
  const projects = await second.list();
  const refs = await second.listTasks(project.projectId);
  assert.equal(projects[0]?.title, '第一项目');
  assert.equal(projects[0]?.taskCount, 1);
  assert.equal(refs.length, 1);
});

test('异常本地项目数据会安全降级为空账本', () => {
  assert.deepEqual(parseProjectLedger('{"schemaVersion":1,"projects":[{"projectId":"bad"}],"taskRefs":[]}'), { schemaVersion: 1, projects: [], taskRefs: [] });
});
