import type { SessionPerformanceEntry, SessionPerformanceKind } from './session-performance-ledger';

export type SessionPerformanceHealthState = 'awaiting' | 'stable' | 'attention';
export interface SessionPerformanceHealthItem { readonly kind: SessionPerformanceKind; readonly label: string; readonly state: SessionPerformanceHealthState; readonly averageMs?: number; readonly samples: number; readonly detail: string; }

const LIMITS: Readonly<Record<SessionPerformanceKind, number>> = { 'conversation-persist': 60, 'stream-refresh': 16, 'timeline-frame': 34 };
const LABELS: Readonly<Record<SessionPerformanceKind, string>> = { 'conversation-persist': '本地持久化', 'stream-refresh': '流式 UI 调度', 'timeline-frame': '时间线下一帧' };

/** 设备无关的本地 UI 提示，不是 Provider 网络 SLA、token 或费用判断。 */
export function sessionPerformanceHealth(entries: readonly SessionPerformanceEntry[]): readonly SessionPerformanceHealthItem[] {
  return (Object.keys(LIMITS) as SessionPerformanceKind[]).map((kind) => {
    const samples = entries.filter((entry) => entry.kind === kind).slice(0, 24);
    if (!samples.length) return { kind, label: LABELS[kind], state: 'awaiting', samples: 0, detail: '等待本机操作产生脱敏数值样本。' };
    const averageMs = Math.round(samples.reduce((total, entry) => total + entry.elapsedMs, 0) / samples.length);
    const state: SessionPerformanceHealthState = averageMs > LIMITS[kind] ? 'attention' : 'stable';
    return { kind, label: LABELS[kind], state, averageMs, samples: samples.length, detail: state === 'stable' ? `近期平均 ${averageMs} ms，处于本机 UI 提示阈值内。` : `近期平均 ${averageMs} ms，超过 ${LIMITS[kind]} ms 的本机 UI 提示阈值；这不代表 Provider 网络异常。` };
  });
}
