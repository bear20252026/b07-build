export interface WorkbenchProject {
  schemaVersion: 1;
  projectId: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  taskCount: number;
  lastTaskAt?: number;
}

export interface WorkbenchProjectTaskRef { projectId: string; taskId: string; runId: string; attachedAt: number; }

function assertProject(value: unknown): asserts value is WorkbenchProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目摘要无效');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !['schemaVersion', 'projectId', 'title', 'description', 'createdAt', 'updatedAt', 'taskCount', 'lastTaskAt'].includes(key))
    || item.schemaVersion !== 1 || typeof item.projectId !== 'string' || !/^project-[a-f0-9-]{8,80}$/.test(item.projectId)
    || typeof item.title !== 'string' || typeof item.description !== 'string' || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.updatedAt)
    || !Number.isSafeInteger(item.taskCount) || (item.taskCount as number) < 0 || (item.lastTaskAt !== undefined && !Number.isSafeInteger(item.lastTaskAt))) throw new Error('项目摘要包含未声明或不安全字段');
}

function assertProjectTaskRef(value: unknown): asserts value is WorkbenchProjectTaskRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目任务归属无效');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !['projectId', 'taskId', 'runId', 'attachedAt'].includes(key))
    || typeof item.projectId !== 'string' || typeof item.taskId !== 'string' || typeof item.runId !== 'string' || !Number.isSafeInteger(item.attachedAt)) throw new Error('项目任务归属包含未声明字段');
}

/** P28：浏览器仅通过已附着的本机 Gateway 读写项目 metadata；不访问 SQLite、文件、Provider 或凭据。 */
export function createProjectClient(baseUrl: string) {
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const payload = await response.json() as unknown;
    if (!response.ok) throw new Error(typeof payload === 'object' && payload && 'error' in payload ? String((payload as { error: unknown }).error) : '项目请求失败');
    return payload;
  }
  return {
    async list(): Promise<readonly WorkbenchProject[]> {
      const payload = await request('/api/projects');
      if (!Array.isArray(payload)) throw new Error('项目列表无效');
      payload.forEach(assertProject);
      return payload;
    },
    async create(input: { title: string; description?: string }): Promise<WorkbenchProject> {
      const payload = await request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'project-v1' }, body: JSON.stringify(input) });
      assertProject(payload); return payload;
    },
    async listTasks(projectId: string): Promise<readonly WorkbenchProjectTaskRef[]> {
      const payload = await request(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
      if (!Array.isArray(payload)) throw new Error('项目任务列表无效'); payload.forEach(assertProjectTaskRef); return payload;
    },
    async attachTask(input: { projectId: string; taskId: string; runId: string }): Promise<WorkbenchProjectTaskRef> {
      const payload = await request(`/api/projects/${encodeURIComponent(input.projectId)}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-awo-operator-intent': 'project-v1' }, body: JSON.stringify({ taskId: input.taskId, runId: input.runId }) });
      assertProjectTaskRef(payload); return payload;
    },
  };
}
