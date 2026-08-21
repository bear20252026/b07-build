import { randomUUID } from 'node:crypto';
import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{2,80}$/.test(value);
}

/** P24 项目 route：只处理本地项目 metadata 与 task/run 引用，绝不访问 SQLite、文件或 Provider。 */
export const handleProjectRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  if (request.method === 'GET' && url.pathname === '/api/projects') {
    sendJson(response, 200, dependencies.projects.list());
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/projects') {
    if (request.headers['x-awo-operator-intent'] !== 'project-v1') {
      sendJson(response, 400, { error: '创建项目必须携带明确的 project-v1 操作者意图' });
      return true;
    }
    const body = await readJsonBody(request) as { title?: unknown; description?: unknown };
    try {
      sendJson(response, 201, dependencies.projects.create({ projectId: `project-${randomUUID()}`, title: typeof body.title === 'string' ? body.title : '', description: typeof body.description === 'string' ? body.description : undefined, at: Date.now() }));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '项目创建失败' });
    }
    return true;
  }
  if (!(segments[0] === 'api' && segments[1] === 'projects' && validIdentifier(segments[2]))) return false;
  const projectId = segments[2];
  if (request.method === 'GET' && segments.length === 4 && segments[3] === 'tasks') {
    try { sendJson(response, 200, dependencies.projects.listTasks(projectId)); } catch (error) { sendJson(response, 404, { error: error instanceof Error ? error.message : '项目不存在' }); }
    return true;
  }
  if (request.method === 'POST' && segments.length === 4 && segments[3] === 'tasks') {
    if (request.headers['x-awo-operator-intent'] !== 'project-v1') {
      sendJson(response, 400, { error: '关联任务必须携带明确的 project-v1 操作者意图' });
      return true;
    }
    const body = await readJsonBody(request) as { taskId?: unknown; runId?: unknown };
    if (!validIdentifier(body.taskId) || !validIdentifier(body.runId) || !dependencies.runtime.snapshot(body.taskId, body.runId)) {
      sendJson(response, 400, { error: '只能关联当前本机已存在的 task/run' });
      return true;
    }
    try { sendJson(response, 201, dependencies.projects.attachTask({ projectId, taskId: body.taskId, runId: body.runId, attachedAt: Date.now() })); } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : '项目任务关联失败' }); }
    return true;
  }
  return false;
};
