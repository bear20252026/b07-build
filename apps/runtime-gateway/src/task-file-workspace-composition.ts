import { RunWorkspaceLedger, SqliteRunWorkspaceLedgerStore, SqliteTaskFileWorkspaceStore, TaskFileWorkspace } from '@awo/agent-runtime';

export interface TaskFileWorkspaceComposition {
  readonly runWorkspaceStore: SqliteRunWorkspaceLedgerStore;
  readonly runWorkspace: RunWorkspaceLedger;
  readonly taskFileStore: SqliteTaskFileWorkspaceStore;
  readonly taskFiles: TaskFileWorkspace;
  close(): void;
}

/** 将 task artifact 元数据、受控内容根和交付 ZIP 组装为一个可独立关闭的本地边界。 */
export function createTaskFileWorkspaceComposition(
  runWorkspaceLedgerPath: string,
  taskFileWorkspacePath: string,
  taskFileRoot: string,
): TaskFileWorkspaceComposition {
  const runWorkspaceStore = new SqliteRunWorkspaceLedgerStore(runWorkspaceLedgerPath);
  const runWorkspace = new RunWorkspaceLedger(runWorkspaceStore);
  const taskFileStore = new SqliteTaskFileWorkspaceStore(taskFileWorkspacePath);
  const taskFiles = new TaskFileWorkspace(taskFileRoot, taskFileStore, runWorkspace);
  return {
    runWorkspaceStore,
    runWorkspace,
    taskFileStore,
    taskFiles,
    close(): void {
      taskFileStore.close();
      runWorkspaceStore.close();
    },
  };
}
