import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalProjectWorkspaceService, type LocalProject, type ProjectTaskRef, type ProjectWorkspaceStore } from '../src/project-workspace.js';

class MemoryStore implements ProjectWorkspaceStore {
  readonly projects = new Map<string, LocalProject>();
  readonly tasks = new Map<string, ProjectTaskRef[]>();
  save(project: LocalProject): void { this.projects.set(project.projectId, { ...project }); }
  load(projectId: string): LocalProject | undefined { const project = this.projects.get(projectId); return project && { ...project }; }
  list(): readonly LocalProject[] { return [...this.projects.values()].map((project) => ({ ...project })); }
  attachTask(reference: ProjectTaskRef): void { const key = reference.projectId; const list = this.tasks.get(key) ?? []; if (!list.some((item) => item.taskId === reference.taskId && item.runId === reference.runId)) list.push({ ...reference }); this.tasks.set(key, list); }
  listTasks(projectId: string): readonly ProjectTaskRef[] { return (this.tasks.get(projectId) ?? []).map((task) => ({ ...task })); }
  close(): void {}
}

test('项目服务只保存项目 metadata 与 task/run 引用，不保存文件或密钥字段', () => {
  const service = new LocalProjectWorkspaceService(new MemoryStore());
  service.create({ projectId: 'project-alpha', title: ' Alpha ', description: '本地学习项目', at: 10 });
  service.attachTask({ projectId: 'project-alpha', taskId: 'task-one', runId: 'run-one', attachedAt: 12 });
  service.attachTask({ projectId: 'project-alpha', taskId: 'task-one', runId: 'run-one', attachedAt: 13 });

  assert.deepEqual(service.list(), [{ schemaVersion: 1, projectId: 'project-alpha', title: 'Alpha', description: '本地学习项目', createdAt: 10, updatedAt: 10, taskCount: 1, lastTaskAt: 12 }]);
  assert.deepEqual(service.listTasks('project-alpha'), [{ projectId: 'project-alpha', taskId: 'task-one', runId: 'run-one', attachedAt: 12 }]);
});

test('项目服务拒绝非法标识与不存在项目的任务归属', () => {
  const service = new LocalProjectWorkspaceService(new MemoryStore());
  assert.throws(() => service.create({ projectId: 'X', title: 'x', at: 1 }), /标识/);
  assert.throws(() => service.attachTask({ projectId: 'project-none', taskId: 'task-one', runId: 'run-one', attachedAt: 1 }), /项目不存在/);
});
