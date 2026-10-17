import { useState } from 'react';
import { backendToggleNote, BROWSER_BACKEND_UNAVAILABLE_TEXT } from '../../runtime/browser-backend-note';
import type { BrowserBackendStatus } from '../../runtime/cdp-browser-tool-handler';

/**
 * 浏览器**真实后端**的开关。
 *
 * ## 为什么需要这个组件
 *
 * `cdp-browser-tool-handler.ts` 早就提供了 `setBrowserBackendEnabled` /
 * `readBrowserBackendStatus`，`use-direct-conversations` 也已经把它们暴露成
 * `browserBackend` 与 `setBrowserBackendEnabled` —— 但**没有任何界面调用**。
 * 结果是"能开"这件事只存在于代码里：用户看不到它，也开不了。
 *
 * 后端**缺省关闭**（与占位包的 fail-closed 纪律一致：绝不"因为代码在就默认可用"），
 * 所以没有这个开关时，浏览器工具永远走不到真实后端。
 *
 * ## 与"浏览会话控制面"的分工
 *
 * 本卡片管的是**执行后端**（CDP 连接、调试端口、活会话数）。
 * 同一页下面的账本管的是**授权策略**（记录目标主机、显式授权、暂停、结束）。
 * 两者不是一回事：后端开着，不等于某个站点被授权；反之亦然。
 */
export function BrowserBackendCard({
  backend,
  onToggle,
}: {
  /** 后端状态；`undefined` 表示读不到（非桌面运行时、命令缺失），按不可用处理。 */
  readonly backend?: BrowserBackendStatus;
  readonly onToggle: (enabled: boolean) => Promise<number>;
}) {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string>();
  const enabled = backend?.enabled === true;
  const available = backend !== undefined;

  const toggle = (): void => {
    if (!available || pending) return;
    setPending(true);
    setNote(undefined);
    void onToggle(!enabled)
      // 关闭会断开全部会话：这个数字必须说出来（见 backendToggleNote）。
      .then((disconnected) => setNote(backendToggleNote(enabled, disconnected)))
      .catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : '浏览器后端状态未更新。');
      })
      .finally(() => setPending(false));
  };

  return (
    <section className="browser-backend-card" aria-label="浏览器真实后端">
      <div className="browser-backend-heading">
        <div>
          <span className="panel-eyebrow">BROWSER BACKEND</span>
          <h2>浏览器真实后端</h2>
          <p>
            后端<strong>缺省关闭</strong>。启用后 Agent 才能通过 CDP 调用浏览器工具（导航、点击、截图等）；
            关闭会立刻断开全部会话。这里只管执行后端，站点授权由下方的会话控制面负责。
          </p>
        </div>
        <button
          type="button"
          disabled={!available || pending}
          onClick={toggle}
          title={available ? '开关真实 CDP 后端；关闭会断开全部会话。' : '当前运行时读不到后端状态，无法开关。'}
        >
          {!available ? '不可用' : pending ? '处理中…' : enabled ? '关闭后端' : '启用后端'}
        </button>
      </div>

      {!available && (
        <p className="browser-session-inline-note">{BROWSER_BACKEND_UNAVAILABLE_TEXT}</p>
      )}

      {available && (
        <div className="browser-backend-metrics">
          <div>
            <span>状态</span>
            <strong className={enabled ? 'browser-backend-on' : 'browser-backend-off'}>
              {enabled ? '已启用' : '已关闭'}
            </strong>
          </div>
          <div>
            <span>调试端口</span>
            <strong>{backend.debuggerPort}</strong>
          </div>
          <div>
            <span>活动会话</span>
            <strong>{backend.sessionCount}</strong>
          </div>
        </div>
      )}

      {note && <p className="browser-session-inline-note">{note}</p>}
    </section>
  );
}
