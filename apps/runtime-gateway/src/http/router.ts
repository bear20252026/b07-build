import type { IncomingMessage, ServerResponse } from 'node:http';
import { applyWorkbenchCors, createHttpRequestContext, errorStatus, sendJson } from './boundary.js';
import type { GatewayDependencies } from './gateway-dependencies.js';
import type { GatewayRoute } from './route-contract.js';
import { handleAgentAdapterRoutes } from './routes/agent-adapters.js';
import { handleApiUsageRoutes } from './routes/api-usage.js';
import { handleControlPlaneDiagnosticRoutes } from './routes/control-plane-diagnostics.js';
import { handleComponentLockReportRoutes } from './routes/component-lock-report.js';
import { handleComponentManagementReportRoutes } from './routes/component-management-report.js';
import { handleNativeHostAuthenticationReportRoutes } from './routes/native-host-authentication-report.js';
import { handleProviderConnectionRoutes } from './routes/provider-connections.js';
import { handleProjectRoutes } from './routes/projects.js';
import { handleWindowsNativeReleaseReportRoutes } from './routes/windows-native-release-report.js';
import { handleExtensionRoutes } from './routes/extensions.js';
import { handleKnowledgeRoutes } from './routes/knowledge.js';
import { handleLocalModelRoutes } from './routes/local-models.js';
import { handleScheduleRoutes } from './routes/schedules.js';
import { handleSecurityPostureAuditRoutes } from './routes/security-posture-audit.js';
import { handleSkillAndProviderRoutes } from './routes/skills-providers.js';
import { handleTaskRoutes } from './routes/tasks.js';

/**
 * 路由管道只确定能力族的匹配顺序；不创建领域对象、不连接数据库，也不承载状态机。
 * 每个 handler 处理后返回 true，未匹配时将请求交给下一条显式管道。
 */
const ROUTE_PIPELINE: readonly GatewayRoute[] = [
  handleControlPlaneDiagnosticRoutes,
  handleSecurityPostureAuditRoutes,
  handleComponentLockReportRoutes,
  handleComponentManagementReportRoutes,
  handleNativeHostAuthenticationReportRoutes,
  handleWindowsNativeReleaseReportRoutes,
  handleScheduleRoutes,
  handleAgentAdapterRoutes,
  handleLocalModelRoutes,
  handleProviderConnectionRoutes,
  handleApiUsageRoutes,
  handleSkillAndProviderRoutes,
  handleExtensionRoutes,
  handleKnowledgeRoutes,
  handleProjectRoutes,
  handleTaskRoutes,
];

export async function handleGatewayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: GatewayDependencies,
): Promise<void> {
  const corsAllowed = applyWorkbenchCors(request, response);
  if (request.method === 'OPTIONS') {
    if (!corsAllowed) sendJson(response, 403, { error: 'Gateway 仅允许已审核的本地 Workbench 来源附着' });
    else response.writeHead(204).end();
    return;
  }
  const context = { ...createHttpRequestContext(request, response), dependencies };
  try {
    for (const route of ROUTE_PIPELINE) {
      if (await route(context)) return;
    }
    sendJson(response, 404, { error: '未找到任务运行时路由' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown local runtime error';
    sendJson(response, errorStatus(error), { error: message });
  }
}
