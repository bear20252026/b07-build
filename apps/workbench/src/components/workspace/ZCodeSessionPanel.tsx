import { useState } from 'react';
import type { AgentToolCallTreeNode } from '../../runtime/agent-tool-tree';
import type { ZcodeSessionController } from '../../runtime/zcode/use-zcode-session';
import { zcodeProcessErrorText } from '../../runtime/zcode/zcode-process-client';

/**
 * ZCode 会话面板：子 Agent 协议会话的审计视图。
 *
 * 只展示投影状态（文本流、工具调用层级、回合终态），不做任何自主操作——
 * 连接、发送、权限裁决都由主人显式点击。权限弹窗沿用 WorkspaceWriteApproval
 * 的「每次独立确认，不给总是允许」原则。
 */

const STATUS_LABEL: Record<string, string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  closed: '已关闭',
  error: '出错',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--muted-strong)',
  running: 'var(--accent-strong)',
  completed: 'var(--muted-strong)',
  failed: 'var(--danger)',
  denied: 'var(--danger)',
};

const RISK_COLOR: Record<string, string> = {
  low: 'var(--muted-strong)',
  medium: 'var(--accent-strong)',
  high: 'var(--danger)',
  critical: 'var(--danger)',
};

function ToolCallRow({ node, depth }: { node: AgentToolCallTreeNode; depth: number }) {
  const call = node.toolCall;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', paddingLeft: depth * 16 }}>
        <span style={{ flex: '0 0 auto', color: STATUS_COLOR[call.status] ?? 'var(--muted-strong)', fontSize: 10, fontWeight: 700 }}>
          {call.status === 'completed' ? '✓' : call.status === 'failed' || call.status === 'denied' ? '✗' : '…'}
        </span>
        <span style={{ color: 'var(--text-strong)', font: '650 11px var(--font-ui)', wordBreak: 'break-all' }}>{call.title}</span>
        <span style={{ color: 'var(--muted)', font: '10px var(--font-mono)', wordBreak: 'break-all' }}>{call.toolName}</span>
      </div>
      {call.error && <div style={{ paddingLeft: depth * 16 + 24, color: 'var(--danger)', fontSize: 10, wordBreak: 'break-all' }}>{call.error}</div>}
      {node.childToolCalls.map((child) => <ToolCallRow key={child.toolCall.toolId} node={child} depth={depth + 1} />)}
    </div>
  );
}

const EXECUTABLE_STORAGE_KEY = 'awo.zcode.executable.v1';

function loadExecutable(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): string {
  try { return storage?.getItem(EXECUTABLE_STORAGE_KEY) ?? ''; } catch { return ''; }
}

function saveExecutable(value: string, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage): void {
  try { storage?.setItem(EXECUTABLE_STORAGE_KEY, value); } catch { /* 本地偏好失败不阻塞会话 */ }
}

export function ZCodeSessionPanel({ session }: { session: ZcodeSessionController }) {
  const { status, sessionId, error, projection, toolTree } = session;
  const [executable, setExecutable] = useState(loadExecutable);
  const lastTurn = projection.lastTurn;
  const button = { minHeight: 32, padding: '0 14px', border: '1px solid var(--border)', borderRadius: 10, font: '650 12px var(--font-ui)', cursor: 'pointer' } as const;
  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: status === 'connected' ? 'var(--accent-strong)' : status === 'error' ? 'var(--danger)' : 'var(--muted-strong)', fontWeight: 700, fontSize: 11 }}>
          ● {STATUS_LABEL[status] ?? status}
        </span>
        {sessionId && <span style={{ color: 'var(--muted)', font: '10px var(--font-mono)', wordBreak: 'break-all' }}>{sessionId}</span>}
        {status === 'idle' || status === 'closed' || status === 'error'
          ? <button onClick={() => { saveExecutable(executable); session.connect({ executable }).catch(() => undefined); }} style={{ ...button, color: '#fff', borderColor: 'var(--accent-strong)', background: 'var(--accent-strong)' }} type="button">连接 ZCode 会话</button>
          : <button onClick={() => { void session.close(); }} style={{ ...button, color: 'var(--text-strong)', background: 'var(--panel)' }} type="button">关闭会话</button>}
        {status === 'connected' && <button onClick={() => { void session.send('请概述当前工作区结构。'); }} style={{ ...button, color: 'var(--text-strong)', background: 'var(--panel)' }} type="button">发送测试指令</button>}
      </div>
      {(status === 'idle' || status === 'closed' || status === 'error') && (
        <label style={{ display: 'grid', gap: 4, color: 'var(--muted-strong)', fontSize: 11 }}>
          ZCode CLI 路径或 PATH 上的命令名（如 zcode 或 D:\tools\zcode\zcode.exe）；原生侧固定追加 agent-server 子命令，不接受其它参数。
          <input
            onChange={(event) => setExecutable(event.currentTarget.value)}
            placeholder="zcode"
            style={{ minHeight: 32, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel)', color: 'var(--text-strong)', font: '11px var(--font-mono)' }}
            value={executable}
          />
        </label>
      )}
      {error && <div style={{ color: 'var(--danger)', fontSize: 11, wordBreak: 'break-all' }}>{zcodeProcessErrorText(error) !== 'ZCode Agent 操作未完成。' ? zcodeProcessErrorText(error) : error}</div>}

      {lastTurn && (
        <div style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--panel)' }}>
          {lastTurn.failed
            ? <span style={{ color: 'var(--danger)', fontWeight: 700, fontSize: 11 }}>回合失败：{lastTurn.error ?? '未知错误'}</span>
            : <span style={{ color: 'var(--muted-strong)', fontSize: 11 }}>
                回合完成{lastTurn.resultType && lastTurn.resultType !== 'success' ? `（${lastTurn.resultType}）` : ''}
                {lastTurn.tokenCount !== undefined ? ` · ${lastTurn.tokenCount} tokens` : ''}
              </span>}
        </div>
      )}

      {projection.text && (
        <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--panel)', color: 'var(--text-strong)', font: '12px/1.7 var(--font-ui)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {projection.text}
        </div>
      )}

      {projection.reasoning && (
        <details>
          <summary style={{ cursor: 'pointer', color: 'var(--muted-strong)', fontSize: 11 }}>推理流（{projection.reasoning.length} 字符）</summary>
          <div style={{ marginTop: 6, padding: 10, border: '1px dashed var(--border)', borderRadius: 12, color: 'var(--muted-strong)', font: '11px/1.6 var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{projection.reasoning}</div>
        </details>
      )}

      {toolTree.length > 0 && (
        <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--canvas)' }}>
          {toolTree.map((node) => <ToolCallRow key={node.toolCall.toolId} node={node} depth={0} />)}
        </div>
      )}

      {!projection.text && toolTree.length === 0 && status === 'connected' && (
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>已连接。发送指令后，回合文本、工具调用层级与权限请求会实时出现在这里。</div>
      )}

      {session.streamIncomplete && (
        <div style={{ color: 'var(--danger)', fontSize: 11 }}>⚠ 事件流存在未补齐的缺口，当前视图可能不完整；建议关闭并重新连接会话。</div>
      )}

      {session.pendingRequests.length > 0 && (
        <ZcodePermissionApproval
          request={session.pendingRequests[0]!}
          queued={session.pendingRequests.length - 1}
          onResolve={session.respondRequest}
        />
      )}
    </div>
  );
}

function ZcodePermissionApproval({ request, queued, onResolve }: { request: NonNullable<ZcodeSessionController['pendingRequests']>[number]; queued: number; onResolve(id: string, decision: 'allow' | 'deny', reason?: string, content?: unknown): void }) {
  const risk = request.riskLevel in RISK_COLOR ? request.riskLevel : 'unknown';
  const isUserInput = request.kind === 'userInput';
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState('');
  const button = { minHeight: 34, padding: '0 14px', border: '1px solid var(--border)', borderRadius: 10, font: '650 12px var(--font-ui)', cursor: 'pointer' } as const;
  const headline = isUserInput ? 'ZCODE USER INPUT · 需要你回答' : 'ZCODE PERMISSION · 需要你裁决';
  // 结构化作答（R1 审计 R2-04）：accept 必须携带界面上实际选择/输入的内容，
  // 而不是裸 accept——没有有效回答的 accept 可能被 ZCode 计划审批解释为拒绝。
  const buildContent = (): unknown => {
    if (!isUserInput) return undefined;
    if (request.questions?.length) {
      return {
        answers: request.questions.map((question) => ({ question: question.question, value: (answers[question.question] ?? []).join(', ') })),
      };
    }
    if (freeText.trim()) return { text: freeText.trim() };
    return undefined;
  };
  const canSubmit = !isUserInput || !request.questions?.length || request.questions.every((question) => (answers[question.question] ?? []).length > 0);
  const toggle = (question: string, value: string, multiSelect: boolean): void => {
    setAnswers((current) => {
      const selected = current[question] ?? [];
      if (!multiSelect) return { ...current, [question]: selected.includes(value) ? [] : [value] };
      return { ...current, [question]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value] };
    });
  };
  return (
    <div role="dialog" aria-modal="true" aria-label={`确认 ${request.toolName} 请求`} style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'grid', placeItems: 'center', padding: 20, background: 'color-mix(in srgb, var(--canvas) 55%, transparent)' }}>
      <div style={{ display: 'grid', gap: 12, width: 'min(640px, 100%)', maxHeight: 'min(85dvh, 760px)', overflow: 'auto', padding: 16, border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', boxShadow: 'var(--shadow-float)' }}>
        <div>
          <span style={{ color: 'var(--muted)', font: '760 10px var(--font-ui)', letterSpacing: '.08em' }}>{headline}{queued > 0 ? ` · 队列中还有 ${queued} 条` : ''}</span>
          <h2 style={{ margin: '6px 0 0', color: 'var(--text-strong)', font: '650 16px/1.2 var(--font-ui)', wordBreak: 'break-all' }}>{request.toolName}</h2>
        </div>
        <div style={{ display: 'flex', gap: 10, color: 'var(--muted-strong)', fontSize: 11 }}>
          {request.kind === 'permission' && risk !== 'unknown' && <span style={{ color: RISK_COLOR[risk], fontWeight: 700 }}>风险等级：{risk}</span>}
        </div>
        {request.reason && <p style={{ margin: 0, color: 'var(--muted-strong)', fontSize: 11, lineHeight: 1.55, wordBreak: 'break-word' }}>{request.reason}</p>}
        {isUserInput && request.questions?.map((question) => (
          <div key={question.question} style={{ display: 'grid', gap: 6 }}>
            <div style={{ color: 'var(--text-strong)', fontSize: 12, fontWeight: 650 }}>{question.header ? `${question.header}：` : ''}{question.question}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {question.options.map((option) => {
                const selected = (answers[question.question] ?? []).includes(option.value);
                return <button key={option.value} onClick={() => toggle(question.question, option.value, question.multiSelect === true)} style={{ ...button, color: selected ? '#fff' : 'var(--text-strong)', borderColor: selected ? 'var(--accent-strong)' : 'var(--border)', background: selected ? 'var(--accent-strong)' : 'var(--panel)' }} type="button">{option.label}</button>;
              })}
            </div>
          </div>
        ))}
        {isUserInput && !request.questions?.length && (
          <textarea onChange={(event) => setFreeText(event.currentTarget.value)} placeholder={request.reason ? '在此输入你的回答…' : '在此输入回答或直接选择拒绝…'} rows={3} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--canvas)', color: 'var(--text-strong)', font: '12px/1.6 var(--font-ui)', resize: 'vertical' }} value={freeText} />
        )}
        {!isUserInput && <div style={{ maxHeight: 200, overflow: 'auto', padding: 10, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--canvas)', font: '11px/1.6 var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{request.inputPreview}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => onResolve(request.id, 'deny', 'user declined')} style={{ ...button, color: 'var(--text-strong)', background: 'var(--panel)' }} type="button">拒绝</button>
          <button disabled={!canSubmit} onClick={() => onResolve(request.id, 'allow', undefined, buildContent())} style={{ ...button, color: canSubmit ? '#fff' : 'var(--muted)', borderColor: 'var(--accent-strong)', background: 'var(--accent-strong)', opacity: canSubmit ? 1 : .6 }} type="button">允许本次</button>
        </div>
      </div>
    </div>
  );
}
