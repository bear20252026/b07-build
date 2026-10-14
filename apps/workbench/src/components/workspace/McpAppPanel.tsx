import { useCallback, useRef, useState } from 'react';
import type { McpAppAdmission, McpAppHostingServer } from '@awo/protocol';
import { McpAppHost } from './McpAppHost';
import { ApprovalRequestQueue, type ApprovalDecision } from '../../runtime/zcode/approval-request-queue';
import { McpAppMountController } from '../../runtime/zcode/mcp-app-mount-controller';
import type { McpAppToolApprovalRequest, McpAppToolAuditEntry } from '../../runtime/zcode/mcp-app-tool-gateway';

/**
 * MCP Apps 挂载点：把已准入的应用渲染进沙箱宿主，并把工具调用接到宿主侧
 * 工具授权网关（R4-04 风险分级 + 人工裁决 + 并发/超时 + 审计轨迹）。
 *
 * 边界（与 McpAppHost 注释一致）：
 * - 准入来自 @awo/protocol 的 validateMcpAppManifest（服务器 + manifest 双向校验）；
 * - medium/high 工具调用必须经本面板的人工裁决（ApprovalRequestQueue，消耗即移除）；
 * - 真实 MCP 连接尚未接入：执行器走 McpAppMountController 的 fail-closed 缺省，
 *   调用以 mcpapp-executor-unavailable 明确失败（界面按 isError 呈现给应用）。
 */

interface MountFormState {
  readonly serverId: string;
  readonly declaredTools: string;
  readonly manifest: string;
  readonly html: string;
}

const EMPTY_FORM: MountFormState = { serverId: '', declaredTools: '', manifest: '', html: '' };

function parseDeclaredTools(text: string): readonly { readonly name: string }[] {
  return text
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

const outcomeLabel: Record<McpAppToolAuditEntry['outcome'], string> = {
  executed: '已执行',
  rejected: '已拒绝',
  timeout: '已超时',
  error: '执行出错',
};

export function McpAppPanel() {
  const controllerRef = useRef<McpAppMountController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new McpAppMountController();
  const approvalsRef = useRef<ApprovalRequestQueue | null>(null);
  if (approvalsRef.current === null) approvalsRef.current = new ApprovalRequestQueue();
  const approvalSeq = useRef(0);

  const [form, setForm] = useState<MountFormState>(EMPTY_FORM);
  const [admission, setAdmission] = useState<McpAppAdmission>();
  const [mountError, setMountError] = useState<string>();
  const [violations, setViolations] = useState<readonly { at: number; reason: string }[]>([]);
  const [audit, setAudit] = useState<readonly McpAppToolAuditEntry[]>([]);
  const [mirror, setMirror] = useState(0);

  const refreshMirror = useCallback(() => setMirror((value) => value + 1), []);

  const approve = useCallback((request: McpAppToolApprovalRequest): Promise<boolean> => {
    const queue = approvalsRef.current;
    if (queue === null) return Promise.resolve(false);
    approvalSeq.current += 1;
    return new Promise((resolve) => {
      queue.add({
        id: `mcpapp-approval-${approvalSeq.current}`,
        kind: 'permission',
        toolName: request.toolName,
        reason: `MCP 应用请求调用工具（${request.risk} 风险）`,
        riskLevel: request.risk,
        inputPreview: request.inputPreview,
        resolve: (decision: ApprovalDecision) => resolve(decision === 'allow'),
      });
      refreshMirror();
    });
  }, [refreshMirror]);

  const onToolCallRequest = useCallback(async (toolName: string, args: unknown): Promise<unknown> => {
    const result = await controllerRef.current?.callTool(toolName, args);
    setAudit(controllerRef.current?.audit ?? []);
    if (result === undefined || !result.ok) {
      // 网关拒绝/失败：抛给宿主，按 isError 的 CallToolResult 呈现给应用。
      throw new Error(result?.message ?? result?.reason ?? 'mcpapp-not-mounted');
    }
    return result.result;
  }, []);

  const onGateViolation = useCallback((reason: string) => {
    setViolations((previous) => [{ at: Date.now(), reason }, ...previous].slice(0, 50));
  }, []);

  const onMount = (): void => {
    let manifest: unknown;
    try {
      manifest = JSON.parse(form.manifest);
    } catch {
      setMountError('manifest-json-invalid');
      return;
    }
    const server: McpAppHostingServer = { id: form.serverId.trim(), declaredTools: parseDeclaredTools(form.declaredTools) };
    const result = controllerRef.current?.mount({ server, manifest, approve });
    if (result === undefined) return;
    if (!result.ok) {
      setMountError(result.reason);
      return;
    }
    setMountError(undefined);
    setViolations([]);
    setAdmission(result.admission);
    setAudit(controllerRef.current?.audit ?? []);
  };

  const onUnmount = (): void => {
    controllerRef.current?.unmount();
    approvalsRef.current?.denyAll('mcpapp-unmounted');
    setAdmission(undefined);
    setAudit([]);
  };

  const pendingApprovals = approvalsRef.current?.list() ?? [];
  void mirror; // 审批队列/审计镜像刷新依赖

  const inputStyle = { width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--canvas)', color: 'var(--text)' } as const;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {admission === undefined ? (
        <section style={{ display: 'grid', gap: 10, padding: 14, border: '1px solid var(--border)', borderRadius: 12 }}>
          <div>
            <span style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 750, letterSpacing: '.08em' }}>MCP APPS MOUNT</span>
            <h2 style={{ margin: '4px 0 6px', fontSize: 16 }}>挂载 MCP 应用</h2>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12, lineHeight: 1.6 }}>
              填写声明应用的服务器与其 manifest，粘贴应用 HTML 后挂载。准入、沙箱与工具裁决全部在宿主侧完成。
              真实 MCP 服务器的工具用 <code>mcp__&lt;服务器&gt;__&lt;工具&gt;</code> canonical 名；宿主注入连接池与连接提供器后
              工具调用直达真实服务器，未注入时以 unavailable 明确失败（界面可见），不会静默放行。
            </p>
          </div>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            服务器 ID
            <input style={inputStyle} value={form.serverId} onChange={(event) => setForm({ ...form, serverId: event.target.value })} placeholder="demo-server" />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            已注册工具（逗号分隔；manifest 请求的工具必须是其子集；真实服务器用 mcp__&lt;服务器&gt;__&lt;工具&gt; canonical 名）
            <input style={inputStyle} value={form.declaredTools} onChange={(event) => setForm({ ...form, declaredTools: event.target.value })} placeholder="read_note, write_note" />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            应用 manifest（JSON）
            <textarea style={{ ...inputStyle, minHeight: 120, fontFamily: 'monospace' }} value={form.manifest} onChange={(event) => setForm({ ...form, manifest: event.target.value })} placeholder={'{\n  "schemaVersion": 1,\n  "id": "mcpapp-demo-notes",\n  "serverId": "demo-server",\n  "displayName": "笔记",\n  "htmlResourceUri": "ui://demo/notes",\n  "requestedToolNames": ["read_note"]\n}'} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            应用 HTML（宿主注入 CSP 后经 mcpapp:// 独立来源渲染，原生不可用时回退 srcdoc）
            <textarea style={{ ...inputStyle, minHeight: 120, fontFamily: 'monospace' }} value={form.html} onChange={(event) => setForm({ ...form, html: event.target.value })} placeholder={'<!doctype html><html><head><meta charset="utf-8"></head><body>应用内容</body></html>'} />
          </label>
          {mountError !== undefined && <p role="alert" style={{ margin: 0, color: 'var(--danger, #c0392b)', fontSize: 12 }}>准入失败：{mountError}</p>}
          <div>
            <button type="button" onClick={onMount} title="校验 manifest 并挂载应用">挂载</button>
            <button type="button" onClick={() => { setForm(EMPTY_FORM); setMountError(undefined); }} title="清空表单">清空</button>
          </div>
        </section>
      ) : (
        <section style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 750, letterSpacing: '.08em' }}>MCP APPS MOUNT</span>
            <button type="button" onClick={onUnmount} title="卸载应用并丢弃网关与审计轨迹">卸载应用</button>
          </div>
          <McpAppHost admission={admission} html={form.html} onToolCallRequest={onToolCallRequest} onGateViolation={onGateViolation} />
        </section>
      )}

      {pendingApprovals.length > 0 && (
        <section style={{ display: 'grid', gap: 8, padding: 14, border: '1px solid var(--border)', borderRadius: 12 }} aria-label="工具调用人工裁决">
          <h3 style={{ margin: 0, fontSize: 14 }}>待裁决的工具调用（{pendingApprovals.length}）</h3>
          {pendingApprovals.map((entry) => (
            <div key={entry.id} style={{ display: 'grid', gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ fontSize: 13 }}>
                <strong>{entry.toolName}</strong>
                <span style={{ color: 'var(--muted)' }}> · 风险 {entry.riskLevel} · {entry.reason}</span>
              </div>
              <pre style={{ margin: 0, maxHeight: 96, overflow: 'auto', fontSize: 11, color: 'var(--muted)' }}>{entry.inputPreview}</pre>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => { approvalsRef.current?.respond(entry.id, 'allow'); refreshMirror(); }} title="允许本次工具调用">允许</button>
                <button type="button" onClick={() => { approvalsRef.current?.respond(entry.id, 'deny'); refreshMirror(); }} title="拒绝本次工具调用">拒绝</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {(violations.length > 0 || audit.length > 0) && (
        <section style={{ display: 'grid', gap: 8, padding: 14, border: '1px solid var(--border)', borderRadius: 12 }} aria-label="准入与执行轨迹">
          <h3 style={{ margin: 0, fontSize: 14 }}>审计轨迹（网关 {audit.length} 条 · 违规 {violations.length} 条）</h3>
          {violations.slice(0, 10).map((entry, index) => (
            <div key={`v-${entry.at}-${index}`} style={{ fontSize: 12, color: 'var(--danger, #c0392b)' }}>
              {formatTime(entry.at)} · 准入违规 {entry.reason}
            </div>
          ))}
          {audit.slice(-20).reverse().map((entry, index) => (
            <div key={`a-${entry.at}-${entry.toolName}-${index}`} style={{ fontSize: 12 }}>
              <span style={{ color: 'var(--muted)' }}>{formatTime(entry.at)}</span>
              <span style={{ marginLeft: 8 }}>{outcomeLabel[entry.outcome]}</span>
              <span style={{ marginLeft: 8 }}>{entry.toolName}</span>
              {entry.detail !== undefined && <span style={{ marginLeft: 8, color: 'var(--muted)' }}>{entry.detail}</span>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
