import type { SkillPackManifestV1 } from '@awo/knowledge-workflow';
import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

function summary(manifest: SkillPackManifestV1): Omit<SkillPackManifestV1, 'content'> {
  const { content: _content, ...rest } = manifest;
  return rest;
}

function operatorIntent(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  return request.headers['x-awo-operator-intent'] === 'agency-role-candidate-v1';
}

function emptyBody(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0;
}

/** Licensed static role catalog. It never scans disk, runs upstream scripts, injects role text, or grants capability. */
export const handleAgencyRoleRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  if (request.method === 'GET' && url.pathname === '/api/agency-roles') {
    sendJson(response, 200, dependencies.agencyRoles.list());
    return true;
  }
  if (segments[0] !== 'api' || segments[1] !== 'agency-roles' || !segments[2]) return false;
  const roleId = decodeURIComponent(segments[2]);
  if (request.method === 'GET' && segments.length === 3) {
    const role = dependencies.agencyRoles.get(roleId);
    if (!role) {
      sendJson(response, 404, { error: '预置角色不存在' });
      return true;
    }
    sendJson(response, 200, role);
    return true;
  }
  if (request.method === 'POST' && segments[3] === 'candidate' && segments.length === 4) {
    if (!operatorIntent(request)) {
      sendJson(response, 403, { error: '添加预置角色候选必须由本地操作者显式发起' });
      return true;
    }
    if (!emptyBody(await readJsonBody(request))) {
      sendJson(response, 400, { error: '预置角色候选不接受自定义正文、工具、权限、端点或密钥字段' });
      return true;
    }
    try {
      const candidate = dependencies.agencyRoles.toSkillPackCandidate(roleId, Date.now());
      const existing = dependencies.skillPacks.list().find((item) => item.id === candidate.id);
      if (existing) {
        sendJson(response, 200, { alreadyExists: true, pack: summary(existing) });
        return true;
      }
      sendJson(response, 201, { alreadyExists: false, pack: summary(dependencies.skillPacks.registerCandidate(candidate)) });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : '预置角色候选无效' });
    }
    return true;
  }
  return false;
};
