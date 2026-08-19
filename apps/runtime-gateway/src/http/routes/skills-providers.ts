import type { RegisterSkillPackCandidateRequest, SkillPackManifestV1 } from '@awo/knowledge-workflow';
import type { RegisterProviderProfileRequest, UpdateProviderProfileRequest } from '@awo/provider-sdk';
import { readJsonBody, sendJson } from '../boundary.js';
import type { GatewayRoute } from '../route-contract.js';

/** 浏览器控制面不会取得 Skill Pack 正文；正文仅能在服务器显式上下文装配时消费。 */
function skillPackSummary(manifest: SkillPackManifestV1): Omit<SkillPackManifestV1, 'content'> {
  const { content: _content, ...summary } = manifest;
  return summary;
}

/** Skill Pack 与 Provider Profile metadata 的 HTTP 适配器。 */
export const handleSkillAndProviderRoutes: GatewayRoute = async ({ request, response, url, segments, dependencies }) => {
  const { skillPacks, providerProfiles } = dependencies;
  if (request.method === 'GET' && url.pathname === '/api/skills/packs') {
    sendJson(response, 200, skillPacks.list().map(skillPackSummary));
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/skills/packs') {
    const body = await readJsonBody(request) as Record<string, unknown>;
    if (
      typeof body.id !== 'string' || typeof body.version !== 'string' || typeof body.displayName !== 'string'
      || !body.source || typeof body.content !== 'string'
      || (body.estimatedTokens !== undefined && (!Number.isSafeInteger(body.estimatedTokens) || typeof body.estimatedTokens !== 'number'))
      || (body.maxInjectionTokens !== undefined && (!Number.isSafeInteger(body.maxInjectionTokens) || typeof body.maxInjectionTokens !== 'number'))
      || (body.note !== undefined && typeof body.note !== 'string')
    ) {
      sendJson(response, 400, { error: 'Skill Pack 候选必须提供 id、version、displayName、source 与纯文本 content；token 预算和 note 可选' });
      return true;
    }
    try {
      sendJson(response, 201, skillPackSummary(skillPacks.registerCandidate({
        ...(body as unknown as Omit<RegisterSkillPackCandidateRequest, 'at'>), at: Date.now(),
      })));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Skill Pack 候选无效' });
    }
    return true;
  }

  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'skills' && segments[2] === 'packs' && segments[3] && segments[4] && segments.length === 5) {
    const operation = segments[4];
    if (operation !== 'review' && operation !== 'publish' && operation !== 'disable' && operation !== 'revoke') {
      sendJson(response, 404, { error: 'Skill Pack 操作必须是 review、publish、disable 或 revoke' });
      return true;
    }
    const body = await readJsonBody(request) as { reviewedBy?: unknown; verifiedDigest?: unknown; note?: unknown };
    if (
      typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string')
      || (operation === 'publish' && typeof body.verifiedDigest !== 'string')
    ) {
      sendJson(response, 400, { error: operation === 'publish' ? 'Skill Pack 发布必须提供 reviewedBy 与 verifiedDigest' : 'Skill Pack 状态变更必须提供 reviewedBy' });
      return true;
    }
    try {
      const at = Date.now();
      const manifest = operation === 'review'
        ? skillPacks.review(segments[3], body.reviewedBy, at, body.note)
        : operation === 'publish'
          ? skillPacks.publish(segments[3], body.verifiedDigest as string, body.reviewedBy, at, body.note)
          : operation === 'disable'
            ? skillPacks.disable(segments[3], body.reviewedBy, at, body.note)
            : skillPacks.revoke(segments[3], body.reviewedBy, at, body.note);
      sendJson(response, 200, skillPackSummary(manifest));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Skill Pack 状态变更无效' });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/providers/profiles') {
    sendJson(response, 200, providerProfiles.list());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/providers/profiles') {
    const body = await readJsonBody(request) as Record<string, unknown>;
    if (
      typeof body.id !== 'string' || typeof body.displayName !== 'string' || !Array.isArray(body.driverIds)
      || typeof body.maximumDataBoundary !== 'string' || typeof body.reviewedBy !== 'string'
      || (body.credentialReference !== undefined && typeof body.credentialReference !== 'string')
      || (body.note !== undefined && typeof body.note !== 'string')
    ) {
      sendJson(response, 400, { error: 'Provider Profile 必须提供 id、displayName、driverIds、maximumDataBoundary 与 reviewedBy；仅可选 credentialReference 标识' });
      return true;
    }
    try {
      sendJson(response, 201, providerProfiles.register({
        ...(body as unknown as Omit<RegisterProviderProfileRequest, 'at'>), at: Date.now(),
      }));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Provider Profile 无效' });
    }
    return true;
  }

  if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'providers' && segments[2] === 'profiles' && segments[3] && segments[4] && segments.length === 5) {
    const operation = segments[4];
    if (operation !== 'update' && operation !== 'activate' && operation !== 'disable' && operation !== 'revoke' && operation !== 'rollback') {
      sendJson(response, 404, { error: 'Provider Profile 操作必须是 update、activate、disable、revoke 或 rollback' });
      return true;
    }
    const body = await readJsonBody(request) as Record<string, unknown>;
    if (typeof body.reviewedBy !== 'string' || (body.note !== undefined && typeof body.note !== 'string')) {
      sendJson(response, 400, { error: 'Provider Profile 变更必须提供 reviewedBy，note 只能为字符串' });
      return true;
    }
    if (operation === 'rollback' && (!Number.isSafeInteger(body.revision) || typeof body.revision !== 'number')) {
      sendJson(response, 400, { error: 'Provider Profile rollback 必须提供正整数 revision' });
      return true;
    }
    try {
      const at = Date.now();
      const profile = operation === 'update'
        ? providerProfiles.update(segments[3], { ...(body as unknown as Omit<UpdateProviderProfileRequest, 'at'>), at })
        : operation === 'activate'
          ? providerProfiles.activate(segments[3], body.reviewedBy, at, body.note as string | undefined)
          : operation === 'disable'
            ? providerProfiles.disable(segments[3], body.reviewedBy, at, body.note as string | undefined)
            : operation === 'revoke'
              ? providerProfiles.revoke(segments[3], body.reviewedBy, at, body.note as string | undefined)
              : providerProfiles.rollback(segments[3], body.revision as number, body.reviewedBy, at, body.note as string | undefined);
      sendJson(response, 200, profile);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Provider Profile 变更无效' });
    }
    return true;
  }

  return false;
};
