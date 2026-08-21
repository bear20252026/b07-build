import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LocalProject, ProjectTaskRef, ProjectWorkspaceStore } from '../../project-workspace.js';

interface ProjectRow { project_json: string; }
interface TaskRow { project_id: string; task_id: string; run_id: string; attached_at_ms: number; }

/** SQLite WAL 项目适配器；领域服务拥有输入校验与排序，路由永远不直接访问数据库。 */
export class SqliteProjectWorkspaceStore implements ProjectWorkspaceStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_projects (
        project_id TEXT PRIMARY KEY,
        project_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_project_tasks (
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        attached_at_ms INTEGER NOT NULL,
        PRIMARY KEY (project_id, task_id, run_id),
        FOREIGN KEY (project_id) REFERENCES local_projects(project_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS local_project_tasks_idx ON local_project_tasks(project_id, attached_at_ms DESC);
    `);
  }

  save(project: LocalProject): void {
    this.db.prepare('INSERT OR REPLACE INTO local_projects(project_id, project_json) VALUES (?, ?)').run(project.projectId, JSON.stringify(project));
  }

  load(projectId: string): LocalProject | undefined {
    const row = this.db.prepare('SELECT project_json FROM local_projects WHERE project_id = ?').get(projectId) as ProjectRow | undefined;
    return row ? { ...(JSON.parse(row.project_json) as LocalProject) } : undefined;
  }

  list(): readonly LocalProject[] {
    const rows = this.db.prepare('SELECT project_json FROM local_projects').all() as unknown as ProjectRow[];
    return rows.map((row) => ({ ...(JSON.parse(row.project_json) as LocalProject) }));
  }

  attachTask(reference: ProjectTaskRef): void {
    this.db.prepare('INSERT OR IGNORE INTO local_project_tasks(project_id, task_id, run_id, attached_at_ms) VALUES (?, ?, ?, ?)').run(reference.projectId, reference.taskId, reference.runId, reference.attachedAt);
  }

  listTasks(projectId: string): readonly ProjectTaskRef[] {
    const rows = this.db.prepare('SELECT project_id, task_id, run_id, attached_at_ms FROM local_project_tasks WHERE project_id = ? ORDER BY attached_at_ms DESC, task_id ASC, run_id ASC').all(projectId) as unknown as TaskRow[];
    return rows.map((row) => ({ projectId: row.project_id, taskId: row.task_id, runId: row.run_id, attachedAt: row.attached_at_ms }));
  }

  close(): void { this.db.close(); }
}
