import { useCallback, useEffect, useState } from 'react';
import type { WorkbenchPage } from '../components/layout/workbench-page';
import { createProjectClient, type WorkbenchProject, type WorkbenchProjectTaskRef } from './project-client';

export interface ProjectWorkspaceController {
  readonly projects: readonly WorkbenchProject[];
  readonly selectedProjectId: string | undefined;
  readonly projectTasks: readonly WorkbenchProjectTaskRef[];
  readonly pending: boolean;
  readonly error: string | undefined;
  create(input: { title: string; description?: string }): void;
  select(projectId: string): void;
  clearSelection(): void;
  attachCurrentTask(task: { taskId: string; runId: string } | undefined): void;
  reset(): void;
}

/** 项目只管理本地 metadata 与 task/run 归属；不读取文件、密钥、任务事件正文或执行能力。 */
export function useProjectWorkspace(
  activePage: WorkbenchPage,
  errorText: (error: unknown) => string,
  client = createProjectClient(),
): ProjectWorkspaceController {
  const [projects, setProjects] = useState<readonly WorkbenchProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [projectTasks, setProjectTasks] = useState<readonly WorkbenchProjectTaskRef[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void client.list()
      .then((items) => { if (!disposed) setProjects(items); })
      .catch((nextError: unknown) => { if (!disposed) setError(errorText(nextError)); });
    return () => { disposed = true; };
  }, [activePage, client, errorText]);

  useEffect(() => {
    if (!selectedProjectId || activePage !== 'projects') return;
    let disposed = false;
    void client.listTasks(selectedProjectId)
      .then((items) => { if (!disposed) setProjectTasks(items); })
      .catch((nextError: unknown) => { if (!disposed) setError(errorText(nextError)); });
    return () => { disposed = true; };
  }, [activePage, client, errorText, selectedProjectId]);

  const create = useCallback((input: { title: string; description?: string }): void => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    void client.create(input)
      .then((created) => {
        setProjects((items) => [created, ...items]);
        setSelectedProjectId(created.projectId);
        setProjectTasks([]);
      })
      .catch((nextError: unknown) => setError(errorText(nextError)))
      .finally(() => setPending(false));
  }, [client, errorText, pending]);

  const select = useCallback((projectId: string): void => {
    setSelectedProjectId(projectId);
    setProjectTasks([]);
    setError(undefined);
  }, []);

  const clearSelection = useCallback((): void => {
    setSelectedProjectId(undefined);
    setProjectTasks([]);
    setError(undefined);
  }, []);

  const attachCurrentTask = useCallback((task: { taskId: string; runId: string } | undefined): void => {
    if (!task || !selectedProjectId || pending) return;
    setPending(true);
    setError(undefined);
    void client.attachTask({ projectId: selectedProjectId, ...task })
      .then((reference) => {
        setProjectTasks((items) => items.some((item) => item.taskId === reference.taskId && item.runId === reference.runId) ? items : [...items, reference]);
        setProjects((items) => items.map((project) => project.projectId === selectedProjectId
          ? { ...project, taskCount: project.taskCount + 1, updatedAt: reference.attachedAt, lastTaskAt: reference.attachedAt }
          : project));
      })
      .catch((nextError: unknown) => setError(errorText(nextError)))
      .finally(() => setPending(false));
  }, [client, errorText, pending, selectedProjectId]);

  const reset = useCallback((): void => {
    setProjects([]);
    setSelectedProjectId(undefined);
    setProjectTasks([]);
    setPending(false);
    setError(undefined);
  }, []);

  return { projects, selectedProjectId, projectTasks, pending, error, create, select, clearSelection, attachCurrentTask, reset };
}
