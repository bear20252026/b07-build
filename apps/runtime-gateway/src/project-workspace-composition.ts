import { LocalProjectWorkspaceService, SqliteProjectWorkspaceStore } from '@awo/agent-runtime';

/** P24 项目领域的单独装配点；HTTP 路由只接收 service，不创建 SQLite 资源。 */
export function createProjectWorkspaceComposition(filePath: string): { projects: LocalProjectWorkspaceService; close(): void } {
  const store = new SqliteProjectWorkspaceStore(filePath);
  const projects = new LocalProjectWorkspaceService(store);
  return { projects, close: () => projects.close() };
}
