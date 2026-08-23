export interface WorkbenchProject {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly taskCount: number;
  readonly lastTaskAt?: number;
}

export interface WorkbenchProjectTaskRef {
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly attachedAt: number;
}

type ProjectLedger = Readonly<{ schemaVersion: 1; projects: readonly WorkbenchProject[]; taskRefs: readonly WorkbenchProjectTaskRef[] }>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const STORAGE_KEY = 'awo.projects.v1';
const MAX_PROJECTS = 128;
const MAX_TASK_REFS = 1_024;

function validProject(value: unknown): value is WorkbenchProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<WorkbenchProject>;
  return item.schemaVersion === 1 && typeof item.projectId === 'string' && /^project-[a-f0-9-]{8,80}$/.test(item.projectId)
    && typeof item.title === 'string' && typeof item.description === 'string'
    && Number.isSafeInteger(item.createdAt) && Number.isSafeInteger(item.updatedAt)
    && typeof item.taskCount === 'number' && Number.isSafeInteger(item.taskCount) && item.taskCount >= 0
    && (item.lastTaskAt === undefined || Number.isSafeInteger(item.lastTaskAt));
}

function validTaskRef(value: unknown): value is WorkbenchProjectTaskRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<WorkbenchProjectTaskRef>;
  return typeof item.projectId === 'string' && /^project-[a-f0-9-]{8,80}$/.test(item.projectId)
    && typeof item.taskId === 'string' && typeof item.runId === 'string' && Number.isSafeInteger(item.attachedAt);
}

function emptyLedger(): ProjectLedger { return { schemaVersion: 1, projects: [], taskRefs: [] }; }

export function parseProjectLedger(raw: string | null): ProjectLedger {
  try {
    const parsed = JSON.parse(raw ?? '') as Partial<ProjectLedger>;
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.taskRefs)) return emptyLedger();
    const projects = parsed.projects.filter(validProject).slice(0, MAX_PROJECTS);
    const projectIds = new Set(projects.map((project) => project.projectId));
    const taskRefs = parsed.taskRefs.filter(validTaskRef).filter((ref) => projectIds.has(ref.projectId)).slice(0, MAX_TASK_REFS);
    return { schemaVersion: 1, projects, taskRefs };
  } catch { return emptyLedger(); }
}

/**
 * AtomCode/OpenWorker-style local workspace metadata: projects persist in the desktop renderer and
 * never depend on a Provider request, API key, loopback HTTP service, task file, or model response.
 */
export function createProjectClient(storage: StorageLike = window.localStorage) {
  const read = (): ProjectLedger => parseProjectLedger(storage.getItem(STORAGE_KEY));
  const write = (ledger: ProjectLedger): void => storage.setItem(STORAGE_KEY, JSON.stringify(ledger));
  return {
    async list(): Promise<readonly WorkbenchProject[]> {
      return [...read().projects].sort((left, right) => right.updatedAt - left.updatedAt);
    },
    async create(input: { title: string; description?: string }): Promise<WorkbenchProject> {
      const title = input.title.trim().slice(0, 120);
      if (!title) throw new Error('请输入项目名称。');
      const now = Date.now();
      const created: WorkbenchProject = {
        schemaVersion: 1,
        projectId: `project-${crypto.randomUUID()}`,
        title,
        description: (input.description ?? '').trim().slice(0, 500),
        createdAt: now,
        updatedAt: now,
        taskCount: 0,
      };
      const ledger = read();
      write({ ...ledger, projects: [created, ...ledger.projects].slice(0, MAX_PROJECTS) });
      return created;
    },
    async listTasks(projectId: string): Promise<readonly WorkbenchProjectTaskRef[]> {
      return read().taskRefs.filter((item) => item.projectId === projectId).sort((left, right) => left.attachedAt - right.attachedAt);
    },
    async attachTask(input: { projectId: string; taskId: string; runId: string }): Promise<WorkbenchProjectTaskRef> {
      const ledger = read();
      if (!ledger.projects.some((project) => project.projectId === input.projectId)) throw new Error('项目不存在或已删除。');
      const existing = ledger.taskRefs.find((item) => item.projectId === input.projectId && item.taskId === input.taskId && item.runId === input.runId);
      if (existing) return existing;
      const attachedAt = Date.now();
      const reference: WorkbenchProjectTaskRef = { ...input, attachedAt };
      write({
        ...ledger,
        projects: ledger.projects.map((project) => project.projectId === input.projectId ? { ...project, taskCount: project.taskCount + 1, updatedAt: attachedAt, lastTaskAt: attachedAt } : project),
        taskRefs: [...ledger.taskRefs, reference].slice(-MAX_TASK_REFS),
      });
      return reference;
    },
  };
}
