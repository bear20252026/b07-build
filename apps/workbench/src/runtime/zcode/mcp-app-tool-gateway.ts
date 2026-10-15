// 一个文件=一种作用：MCP App 工具调用的宿主侧授权网关（R1 审计 R4-04）。
//
// 审计结论：工具名在 admittedToolNames 白名单里只代表「允许应用看见并请求」，
// 不等于执行授权——插件不得越过 b07 的高影响操作审批机制。本网关是宿主侧
// 的统一收口，任何工具调用都必须依次通过：
//
//   1. 准入复查（白名单，纵深防御）；
//   2. 用户手势门（P2-2）：沙箱发起的特权操作必须被新鲜的一次性手势 token 背书；
//   3. 风险分级：未登记风险的工具按 high 处理（fail-closed）；
//   4. 人工裁决：medium/high 必须经 approve 回调批准，未提供裁决入口 = 拒绝；
//      low 直接放行（与 ZCode「app-only 工具复用工具授权路径」一致的最小闭环）；
//   5. 并发上限（缺省 4，对齐 ZCode 每实例并发）与单次超时（缺省 30 秒，
//      对齐 ZCode 执行期限）；超时后底层调用不再回投结果。
//
// 每次调用（无论成败）都留下审计轨迹（容量有界），供界面与后续审计导出。

export type McpAppToolRisk = 'low' | 'medium' | 'high';

export interface McpAppToolApprovalRequest {
  readonly appInstanceId: string;
  readonly toolName: string;
  readonly risk: McpAppToolRisk;
  readonly inputPreview: string;
}

export interface McpAppToolGatewayOptions {
  /** 已准入工具白名单（来自 validateMcpAppManifest 的 admission）。 */
  readonly admittedToolNames: readonly string[];
  readonly appInstanceId: string;
  /** 工具风险分级；未知工具一律按 high（必须人工裁决）。 */
  riskFor(toolName: string): McpAppToolRisk;
  /** medium/high 的人工裁决入口；未提供 = 这些风险一律拒绝（fail-closed）。 */
  approve?(request: McpAppToolApprovalRequest): Promise<boolean>;
  /**
   * 用户手势门（P2-2）：返回 true = 本次调用被新鲜的一次性手势 token 背书。
   * 沙箱应用发起的每一次工具执行都是宿主侧特权操作，必须由真实用户手势背书：
   * 没有手势 / token 已消费 / 超时一律拒绝（fail-closed）。未提供该端口 = 不做手势门
   * （保留旧接线语义；真实接线在 McpAppPanel 侧注入）。
   */
  consumeUserGesture?(): boolean;
  /** 底层执行器：真正连接 MCP 服务器执行工具的路径。 */
  execute(toolName: string, args: unknown): Promise<unknown>;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly inputPreviewLimit?: number;
}

export type McpAppToolGatewayResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      reason:
        | 'mcpapp-tool-not-admitted'
        | 'mcpapp-user-gesture-required'
        | 'mcpapp-approval-required'
        | 'mcpapp-approval-denied'
        | 'mcpapp-concurrency-limit'
        | 'mcpapp-tool-timeout'
        | 'mcpapp-tool-error';
      message?: string;
    }

export interface McpAppToolAuditEntry {
  readonly at: number;
  readonly appInstanceId: string;
  readonly toolName: string;
  readonly outcome: 'executed' | 'rejected' | 'timeout' | 'error';
  /** rejected 时的原因码；error 时的错误摘要。 */
  readonly detail?: string;
}

const AUDIT_CAPACITY = 256;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CONCURRENT = 4;

function inputPreview(args: unknown, limit: number): string {
  try {
    return JSON.stringify(args ?? null).slice(0, limit);
  } catch {
    return String(args).slice(0, limit);
  }
}

export class McpAppToolGateway {
  private readonly auditTrail: McpAppToolAuditEntry[] = [];
  private inFlight = 0;

  constructor(private readonly options: McpAppToolGatewayOptions) {}

  get audit(): readonly McpAppToolAuditEntry[] {
    return this.auditTrail;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  private record(entry: Omit<McpAppToolAuditEntry, 'at' | 'appInstanceId'>): void {
    this.auditTrail.push({
      at: Date.now(),
      appInstanceId: this.options.appInstanceId,
      ...entry,
    });
    if (this.auditTrail.length > AUDIT_CAPACITY) {
      this.auditTrail.splice(0, this.auditTrail.length - AUDIT_CAPACITY);
    }
  }

  /**
   * 工具调用唯一入口。返回 { ok: false, reason } 而不是抛出：拒绝是可预期的
   * 业务结果，调用方（宿主组件）把它转成给应用的结果信封。
   */
  async call(
    toolCallId: string,
    toolName: string,
    args: unknown,
    inputPreviewLimit = 2_000,
  ): Promise<McpAppToolGatewayResult> {
    // 1. 准入复查（纵深防御：渲染层门之后再来一道）。
    if (!this.options.admittedToolNames.includes(toolName)) {
      this.record({ toolName, outcome: 'rejected', detail: 'mcpapp-tool-not-admitted' });
      return { ok: false, reason: 'mcpapp-tool-not-admitted' };
    }
    // 2. 用户手势门（P2-2）：特权操作必须先消费一个新鲜的一次性手势 token；
    //    未提供打标端口或 token 不存在/过期/已消费都拒绝（fail-closed），
    //    且先于人工裁决——不给「无手势背书的调用」占用人的裁决预算。
    if (this.options.consumeUserGesture && !this.options.consumeUserGesture()) {
      this.record({ toolName, outcome: 'rejected', detail: 'mcpapp-user-gesture-required' });
      return { ok: false, reason: 'mcpapp-user-gesture-required' };
    }
    // 3. 风险分级：未知工具 fail-closed 按 high。
    const risk = this.options.riskFor(toolName) ?? 'high';
    const preview = inputPreview(args, inputPreviewLimit);
    // 4. 人工裁决：medium/high 必须经人；low 免批（最小闭环，与最小影响一致）。
    if (risk !== 'low') {
      const approve = this.options.approve;
      if (!approve) {
        this.record({ toolName, outcome: 'rejected', detail: 'mcpapp-approval-required' });
        return { ok: false, reason: 'mcpapp-approval-required' };
      }
      const approved = await approve({ appInstanceId: this.options.appInstanceId, toolName, risk, inputPreview: preview });
      if (!approved) {
        this.record({ toolName, outcome: 'rejected', detail: 'mcpapp-approval-denied' });
        return { ok: false, reason: 'mcpapp-approval-denied' };
      }
    }
    // 5. 并发上限：超出即拒（应用侧可稍后重试），不排队不让请求堆积。
    const maxConcurrent = this.options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (this.inFlight >= maxConcurrent) {
      this.record({ toolName, outcome: 'rejected', detail: 'mcpapp-concurrency-limit' });
      return { ok: false, reason: 'mcpapp-concurrency-limit' };
    }
    this.inFlight += 1;
    try {
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        this.options.execute(toolName, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('mcpapp-tool-timeout')), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      this.record({ toolName, outcome: 'executed' });
      return { ok: true, result };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'mcpapp-tool-timeout') {
        // 超时：底层调用不可取消，结果到达后按代际/账本规则丢弃。
        this.record({ toolName, outcome: 'timeout' });
        return { ok: false, reason: 'mcpapp-tool-timeout' };
      }
      this.record({ toolName, outcome: 'error', detail: message.slice(0, 500) });
      return { ok: false, reason: 'mcpapp-tool-error', message: message.slice(0, 500) };
    } finally {
      this.inFlight -= 1;
    }
  }
}
