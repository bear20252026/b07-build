import type { LocalKnowledgeDocument } from '../../runtime/local-knowledge-ledger';
import type { ProviderDiagnosticEntry } from '../../runtime/provider-diagnostics';

export type RealProgressTone = 'complete' | 'active' | 'idle' | 'attention';
export interface RealProgressStage { readonly id: 'provider' | 'knowledge' | 'chat'; readonly label: string; readonly detail: string; readonly tone: RealProgressTone; }

export function createRealProgressStages(input: Readonly<{ connectionCount: number; pendingProviderId?: string; diagnostics: readonly ProviderDiagnosticEntry[]; knowledge: readonly LocalKnowledgeDocument[]; streaming: boolean; chatError?: string; messageCount: number }>): readonly RealProgressStage[] {
  const latest = input.diagnostics[0];
  const provider: RealProgressStage = input.pendingProviderId ? { id: 'provider', label: '桌面原生连接测试', detail: '正在等待本次已明确触发的连接或探针回执。', tone: 'active' }
    : latest?.outcome === 'failed' ? { id: 'provider', label: '桌面原生连接测试', detail: `最近一次 ${latest.stage} 未完成${latest.errorCode ? ` · ${latest.errorCode}` : ''}。`, tone: 'attention' }
      : latest?.outcome === 'succeeded' ? { id: 'provider', label: '桌面原生连接测试', detail: `最近一次 ${latest.stage} 已由同一原生会话确认。`, tone: 'complete' }
        : input.connectionCount > 0 ? { id: 'provider', label: '桌面原生连接测试', detail: `已恢复 ${input.connectionCount} 个本地 Provider 会话；尚无本轮测试回执。`, tone: 'idle' }
          : { id: 'provider', label: '桌面原生连接测试', detail: '尚未保存桌面原生 Provider 连接。', tone: 'idle' };
  const knowledge: RealProgressStage = input.knowledge.length > 0 ? { id: 'knowledge', label: '显式本地知识库', detail: `已索引 ${input.knowledge.length} 项主人明确加入的本地资料。`, tone: 'complete' }
    : { id: 'knowledge', label: '显式本地知识库', detail: '尚无已索引资料；此处不会扫描、上传或自动加入模型上下文。', tone: 'idle' };
  const chat: RealProgressStage = input.streaming ? { id: 'chat', label: '第三方流式接收', detail: '正在接收第三方 Provider 的文本分块。', tone: 'active' }
    : input.chatError ? { id: 'chat', label: '第三方流式接收', detail: '最近一轮聊天未完成；请在对话工作面查看实际错误。', tone: 'attention' }
      : input.messageCount > 0 ? { id: 'chat', label: '第三方流式接收', detail: `当前本地会话保留 ${input.messageCount} 条消息；没有进行中的接收。`, tone: 'complete' }
        : { id: 'chat', label: '第三方流式接收', detail: '尚未开始当前会话的 Provider 流式接收。', tone: 'idle' };
  return [provider, knowledge, chat];
}
