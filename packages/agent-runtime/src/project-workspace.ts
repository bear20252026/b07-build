export interface LocalProject {
  schemaVersion: 1;
  projectId: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectTaskRef {
  projectId: string;
  taskId: string;
  runId: string;
  attachedAt: number;
}

export interface ProjectWorkspaceStore {
  save(project: LocalProject): void;
  load(projectId: string): LocalProject | undefined;
  list(): readonly LocalProject[];
  attachTask(reference: ProjectTaskRef): void;
  listTasks(projectId: string): readonly ProjectTaskRef[];
  close(): void;
}

const IDENTIFIER = /^[a-z][a-z0-9-]{2,80}$/;

/** 本地项目服务：只管理项目 metadata 与 task/run 引用，不保存密钥、文件正文、路径或运行状态。 */
export class LocalProjectWorkspaceService {
  constructor(private readonly store: ProjectWorkspaceStore) {}

  create(input: { projectId: string; title: string; description?: string; at: number }): LocalProject {
    if (!IDENTIFIER.test(input.projectId)) throw new Error('项目标识无效');
    const title = input.title.trim();
    const description = input.description?.trim() ?? '';
    if (!title || title.length > 120 || description.length > 500 || !Number.isSafeInteger(input.at) || input.at < 0) throw new Error('项目名称、描述或时间无效');
    if (this.store.load(input.projectId)) throw new Error('项目标识已存在');
    const project: LocalProject = { schemaVersion: 1, projectId: input.projectId, title, description, createdAt: input.at, updatedAt: input.at };
    this.store.save(project);
    return { ...project };
  }

  list(): readonly (LocalProject & { taskCount: number; lastTaskAt?: number })[] {
    return this.store.list().map((project) => {
      const tasks = this.store.listTasks(project.projectId);
      return { ...project, taskCount: tasks.length, ...(tasks.length ? { lastTaskAt: Math.max(...tasks.map((task) => task.attachedAt)) } : {}) };
    }).sort((left, right) => right.updatedAt - left.updatedAt || left.projectId.localeCompare(right.projectId));
  }

  attachTask(input: ProjectTaskRef): ProjectTaskRef {
    if (!IDENTIFIER.test(input.projectId) || !IDENTIFIER.test(input.taskId) || !IDENTIFIER.test(input.runId) || !Number.isSafeInteger(input.attachedAt) || input.attachedAt < 0) throw new Error('项目任务归属无效');
    if (!this.store.load(input.projectId)) throw new Error('项目不存在');
    this.store.attachTask({ ...input });
    return { ...input };
  }

  listTasks(projectId: string): readonly ProjectTaskRef[] {
    if (!IDENTIFIER.test(projectId) || !this.store.load(projectId)) throw new Error('项目不存在');
    return this.store.listTasks(projectId).map((item) => ({ ...item }));
  }

  close(): void { this.store.close(); }
}
