// 一个文件=一种作用：MCP Apps 挂载控制器——挂载生命周期 + 工具执行网关 + 真实 MCP 连接接缝。
//
// 定位：McpAppHost（官方 ext-apps 桥宿主）与真实 MCP 连接之间的那一层。宿主
// 面板只跟本控制器打交道：manifest 准入 → 建工具网关 → 调用 → 审计投影。
//
// 「真实 MCP 连接」的接入点就是 McpAppToolExecutor：谁真正持握 MCP 服务器
// 连接（stdio/SSE 客户端、原生侧桥、ZCode agent-server 代理），谁实现这个
// 接口并在 mount() 时注入。未注入时使用 fail-closed 缺省执行器——工具调用
// 以明确原因失败，绝不放行、绝不静默成功。

import {
  validateMcpAppManifest,
  type McpAppAdmission,
  type McpAppAdmissionResult,
  type McpAppHostingServer,
  type ToolRegistry,
} from '@awo/protocol';
import {
  McpAppToolGateway,
  type McpAppToolApprovalRequest,
  type McpAppToolAuditEntry,
  type McpAppToolGatewayResult,
  type McpAppToolRisk,
} from './mcp-app-tool-gateway';

/** 真实 MCP 连接的执行器接缝：真正持握 MCP 服务器连接并执行工具的一端。 */
export interface McpAppToolExecutor {
  execute(toolName: string, args: unknown): Promise<unknown>;
}

/** 未接入真实连接时的缺省执行器：fail-closed，一切调用以 unavailable 原因失败。 */
export function createUnavailableMcpAppToolExecutor(reason = 'mcpapp-executor-unavailable'): McpAppToolExecutor {
  return {
    execute: async () => {
      throw new Error(reason);
    },
  };
}

/** 缺省风险分级：未登记风险的工具一律 high（与网关 fail-closed 语义一致）。 */
export function defaultMcpAppRisk(
  toolName: string,
  riskTable: Readonly<Record<string, McpAppToolRisk>> = {},
): McpAppToolRisk {
  return riskTable[toolName] ?? 'high';
}

/**
 * 契约优先的风险解析：工具注册表（ToolDescriptor.defaultRisk）→ 调用方
 * riskTable → fail-closed 的 high。网关侧再无 ad hoc riskFor 拼接。
 */
export function resolveMcpAppToolRisk(
  toolName: string,
  registry?: ToolRegistry,
  riskTable?: Readonly<Record<string, McpAppToolRisk>>,
): McpAppToolRisk {
  const descriptor = registry?.resolve(toolName);
  if (descriptor) return descriptor.defaultRisk;
  return defaultMcpAppRisk(toolName, riskTable);
}

export interface McpAppMountRequest {
  /** 声明该应用的 MCP 服务器（id + 已注册工具）；manifest 的工具必须是它的子集。 */
  readonly server: McpAppHostingServer;
  readonly manifest: unknown;
  /** 真实 MCP 连接的执行器；缺省 = fail-closed 执行器（调用以 unavailable 失败）。 */
  readonly executor?: McpAppToolExecutor;
  /** 工具风险分级表；缺省全部 high（必须人工裁决）。 */
  readonly riskTable?: Readonly<Record<string, McpAppToolRisk>>;
  /** 工具声明契约注册表；提供时风险从 ToolDescriptor.defaultRisk 读取。 */
  readonly tools?: ToolRegistry;
  /** medium/high 的人工裁决入口；未提供 = 这些风险一律拒绝（网关语义）。 */
  readonly approve?: (request: McpAppToolApprovalRequest) => Promise<boolean>;
  /** 应用实例标识；缺省由控制器按挂载次序生成。 */
  readonly appInstanceId?: string;
}

export class McpAppMountController {
  private gateway: McpAppToolGateway | undefined;
  private currentAdmission: McpAppAdmission | undefined;
  private instanceId: string | undefined;
  private mountCounter = 0;
  private callCounter = 0;

  /**
   * 挂载（或换代重挂）。准入失败时返回原因并**保留旧挂载不动**——坏 manifest
   * 不应把正在运行的好挂载踢掉；准入通过才换代网关（新审计账本从头开始）。
   */
  mount(request: McpAppMountRequest): McpAppAdmissionResult {
    const validated = validateMcpAppManifest(request.manifest, request.server);
    if (!validated.ok) return validated;
    this.mountCounter += 1;
    const appInstanceId = request.appInstanceId ?? `mcpapp-mount-${this.mountCounter}`;
    const executor = request.executor ?? createUnavailableMcpAppToolExecutor();
    this.gateway = new McpAppToolGateway({
      admittedToolNames: validated.admission.admittedToolNames,
      appInstanceId,
      riskFor: (toolName) => resolveMcpAppToolRisk(toolName, request.tools, request.riskTable),
      approve: request.approve,
      execute: (toolName, args) => executor.execute(toolName, args),
    });
    this.currentAdmission = validated.admission;
    this.instanceId = appInstanceId;
    return validated;
  }

  get mounted(): boolean {
    return this.gateway !== undefined;
  }

  /** 当前挂载的实例标识（网关 audit 轨迹里的 appInstanceId）。 */
  get appInstanceId(): string | undefined {
    return this.instanceId;
  }

  get admission(): McpAppAdmission | undefined {
    return this.currentAdmission;
  }

  get audit(): readonly McpAppToolAuditEntry[] {
    return this.gateway?.audit ?? [];
  }

  get inFlightCount(): number {
    return this.gateway?.inFlightCount ?? 0;
  }

  /**
   * 工具调用入口（宿主注入给 iframe 执行器的那条路径）。未挂载 = 明确拒绝，
   * 不抛未定义错误；网关拒绝（未准入/未批准/并发/超时/执行错误）按结果返回，
   * 由调用方决定如何呈现给应用（宿主把失败包成 isError 的 CallToolResult）。
   */
  async callTool(toolName: string, args: unknown): Promise<McpAppToolGatewayResult> {
    if (!this.gateway) {
      return { ok: false, reason: 'mcpapp-tool-error', message: 'mcpapp-not-mounted' };
    }
    this.callCounter += 1;
    return this.gateway.call(`call-${this.callCounter}`, toolName, args);
  }

  /** 卸载：丢弃网关与准入态；审计轨迹随之释放（宿主可按需先自行留存）。 */
  unmount(): void {
    this.gateway = undefined;
    this.currentAdmission = undefined;
    this.instanceId = undefined;
  }
}
