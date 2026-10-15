// 一个文件=一种作用：Gen UI 页面宿主——把 Agent 生成的 HTML 页面渲染进沙箱 iframe，
// 注入 guest 运行时（window.zcode），分发 `zcode/gen-ui/*` 调用，并在侧栏渲染 Tweak 控件。
//
// 分层与复用（与 McpAppHost 同构，但**不修改** McpAppHost）：
// - 隔离：sandbox 属性与 CSP 来自 `buildGenUiSandboxPolicy`（复用 b07 MCP Apps 隔离思路 +
//   CDN 静态域白名单）；文档经既有 `mcpapp://` 暂存通道以响应头 CSP 提供，不可用时回退 srcdoc。
// - 桥：guest → host 走 `createGenUiBridgeHost`（parse + 分发 + JSON-RPC 应答）；
//   host → guest 走 `zcode/gen-ui/context` 通知下发 widgetState / theme / Tweak 标注。
// - 状态：Widget 状态落在 `genUiStateStore`（按 workspace/session/path 隔离）。
// - Tweak：控件分组由 `GenUiTweakRegistry` 维护，本组件只负责渲染与值回传。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildGenUiContextNotification,
  buildGenUiSandboxPolicy,
  injectContentSecurityPolicy,
  injectGenUiGuestRuntime,
  injectGenUiInitialState,
  projectGenUiGlobals,
  type GenUiAnnotationControl,
  type GenUiStateTarget,
  type GenUiTweakAnnotation,
} from '@awo/protocol';
import { createGenUiBridgeHost } from '../../runtime/gen-ui/gen-ui-bridge-host';
import { GenUiTweakRegistry } from '../../runtime/gen-ui/gen-ui-tweak-registry';
import { genUiStateStore } from '../../runtime/gen-ui/gen-ui-state-store';
import { mcpAppDocumentUrl, releaseMcpAppDocument, stageMcpAppDocument } from '../../runtime/zcode/mcp-app-document-client';

export interface GenUiHostProps {
  /** 页面归属（workspace/session/path）；决定状态隔离键。 */
  readonly target: GenUiStateTarget;
  /** Agent 生成的页面 HTML（宿主注入 guest 运行时与初始状态后渲染）。 */
  readonly html: string;
  /** 页面请求追问时回调（把提示词送进当前会话）；未提供时以 internalError 应答。 */
  readonly onFollowUp?: (prompt: string, title: string | undefined) => void | Promise<void>;
  /** 准入策略违规回调（未知方法、超限、非法载荷），供审计记录。 */
  readonly onGateViolation?: (reason: string, detail: unknown) => void;
}

function currentTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function GenUiHost({ target, html, onFollowUp, onGateViolation }: GenUiHostProps) {
  const sandbox = useMemo(() => buildGenUiSandboxPolicy(), []);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const registryRef = useRef(new GenUiTweakRegistry());
  const [tweakGroups, setTweakGroups] = useState(() => registryRef.current.groups());
  const [tweakValues, setTweakValues] = useState<Record<string, string | number | boolean>>(() => ({ ...registryRef.current.values() }));

  // 页面文档：注入 guest 运行时 + 挂载时的状态快照；html 变化即视为新文档。
  const runtimeDocument = useMemo(
    () => injectGenUiInitialState(injectGenUiGuestRuntime(html), genUiStateStore.get(target)),
    [html, target],
  );

  const latest = useRef({ target, onFollowUp, onGateViolation });
  latest.current = { target, onFollowUp, onGateViolation };

  // host → guest 上下文推送：状态或 Tweak 标注变化时下发。
  const pushContext = useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    const annotation: GenUiTweakAnnotation = registryRef.current.annotation();
    const globals = projectGenUiGlobals({
      state: genUiStateStore.get(latest.current.target),
      theme: currentTheme(),
      annotation,
    });
    frame.contentWindow.postMessage(buildGenUiContextNotification(globals), '*');
  }, []);

  // 状态订阅：本页面（或同键页面）状态变化即推送。
  useEffect(() => {
    const subscription = genUiStateStore.onStateChanged(() => pushContext());
    return () => subscription.dispose();
  }, [pushContext]);

  // 文档来源：优先 mcpapp:// 暂存（响应头 CSP），不可用回退 srcdoc + 注入 CSP。
  const [servedUrl, setServedUrl] = useState<string>();
  const [fallbackDocument, setFallbackDocument] = useState<string>();
  const instanceIdRef = useRef(`genui-${crypto.randomUUID()}`);
  useEffect(() => {
    let cancelled = false;
    const csp = sandbox.contentSecurityPolicy;
    void (async () => {
      try {
        await stageMcpAppDocument(instanceIdRef.current, runtimeDocument, csp);
        if (!cancelled) {
          setFallbackDocument(undefined);
          setServedUrl(mcpAppDocumentUrl(instanceIdRef.current));
        }
      } catch {
        if (!cancelled) {
          setServedUrl(undefined);
          setFallbackDocument(injectContentSecurityPolicy(runtimeDocument, csp));
        }
      }
    })();
    return () => {
      cancelled = true;
      void releaseMcpAppDocument(instanceIdRef.current).catch(() => undefined);
    };
  }, [runtimeDocument, sandbox.contentSecurityPolicy]);

  // guest → host：桥分发 + 应答；Tweak 应答后刷新侧栏。
  useEffect(() => {
    const bridge = createGenUiBridgeHost({
      onSetState: (state) => {
        genUiStateStore.set(latest.current.target, state);
      },
      onFollowUp: async (prompt, title) => {
        const handler = latest.current.onFollowUp;
        if (handler === undefined) throw new Error('gen-ui-follow-up-unavailable');
        await handler(prompt, title);
      },
      onTweak: (message) => {
        const result = registryRef.current.handle(message);
        setTweakGroups([...registryRef.current.groups()]);
        setTweakValues({ ...registryRef.current.values() });
        pushContext();
        return result;
      },
      onPresentation: () => undefined,
      onViolation: (reason, detail) => latest.current.onGateViolation?.(reason, detail),
    });
    const handler = (event: MessageEvent): void => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      void bridge.handle(event.data).then((outcome) => {
        if (outcome.kind !== 'ignored' && outcome.message !== undefined) {
          void frame.contentWindow?.postMessage(outcome.message, '*');
        }
      });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [pushContext]);

  const updateValue = useCallback(
    (callback: string, value: string | number | boolean) => {
      if (!registryRef.current.setValue(callback, value)) return;
      setTweakValues({ ...registryRef.current.values() });
      pushContext();
    },
    [pushContext],
  );

  const groups = tweakGroups;
  return (
    <div data-gen-ui-path={target.path} style={{ display: 'grid', gap: 8 }}>
      {groups.length > 0 && (
        <section aria-label="Gen UI 参数控件" style={{ display: 'grid', gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
          {groups.map((group) => (
            <div key={group.registrationId} style={{ display: 'grid', gap: 6 }}>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>参数控件 · {group.title}</div>
              {group.controls.map((control) => (
                <TweakControlRow key={control.callback} control={control} value={tweakValues[control.callback] ?? control.currentValue} onChange={updateValue} />
              ))}
            </div>
          ))}
        </section>
      )}
      {servedUrl ? (
        <iframe
          ref={frameRef}
          sandbox={sandbox.sandboxAttributes.join(' ')}
          src={servedUrl}
          onLoad={pushContext}
          style={{ width: '100%', minHeight: 320, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--canvas)' }}
          title={target.path}
        />
      ) : (
        <iframe
          ref={frameRef}
          sandbox={sandbox.sandboxAttributes.join(' ')}
          srcDoc={fallbackDocument ?? ''}
          onLoad={pushContext}
          style={{ width: '100%', minHeight: 320, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--canvas)' }}
          title={target.path}
        />
      )}
    </div>
  );
}

function TweakControlRow({ control, value, onChange }: { readonly control: GenUiAnnotationControl; readonly value: string | number | boolean; readonly onChange: (callback: string, value: string | number | boolean) => void }) {
  const label = control.reference === undefined ? control.label : `${control.label} · ${control.reference}`;
  if (control.type === 'range') {
    return (
      <label style={{ display: 'grid', gap: 2, fontSize: 12 }}>
        <span>{label}（{String(value)}）</span>
        <input
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={typeof value === 'number' ? value : control.currentValue}
          onChange={(event) => onChange(control.callback, Number(event.target.value))}
        />
      </label>
    );
  }
  if (control.type === 'color') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span>{label}</span>
        <input type="color" value={typeof value === 'string' ? value : control.currentValue} onChange={(event) => onChange(control.callback, event.target.value)} />
      </label>
    );
  }
  if (control.type === 'toggle') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <input type="checkbox" checked={typeof value === 'boolean' ? value : control.currentValue} onChange={(event) => onChange(control.callback, event.target.checked)} />
        <span>{label}</span>
      </label>
    );
  }
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span>{label}</span>
      <select value={typeof value === 'string' ? value : control.currentValue} onChange={(event) => onChange(control.callback, event.target.value)}>
        {control.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
