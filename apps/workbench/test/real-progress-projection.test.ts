import assert from 'node:assert/strict';
import test from 'node:test';
import { createRealProgressStages } from '../src/components/observability/real-progress-projection.js';

const diagnostic = { schemaVersion: 1 as const, traceId: 'direct-test-1', at: 1, elapsedMs: 30, providerId: 'provider-1', displayName: '示例连接', protocol: 'openai-compatible' as const, baseUrl: 'https://api.example.test/v1', model: 'example-model', stage: 'probe' as const, outcome: 'succeeded' as const, includedImages: false, sharedNativeSession: true };

test('真实阶段投影只依据已有回执、显式知识库索引和当前聊天状态，不产生计时步骤', () => {
  const stages = createRealProgressStages({ connectionCount: 1, diagnostics: [diagnostic], knowledge: [{ schemaVersion: 1 as const, id: 'knowledge-1', title: '显式资料', sourceKind: 'manual-text' as const, declaredBytes: 1, indexedAt: 1, termIndex: [], sourcePreview: '仅本地预览。' }], streaming: true, messageCount: 4 });
  assert.deepEqual(stages.map((stage) => [stage.id, stage.tone]), [['provider', 'complete'], ['knowledge', 'complete'], ['chat', 'active']]);
  assert.match(stages[2]?.detail ?? '', /文本分块/);
});

test('失败回执与缺失资料保持可解释等待状态，而不伪造已完成进度', () => {
  const stages = createRealProgressStages({ connectionCount: 0, diagnostics: [{ ...diagnostic, outcome: 'failed', errorCode: 'provider-connect-failed' }], knowledge: [], streaming: false, chatError: '第三方服务未响应', messageCount: 0 });
  assert.deepEqual(stages.map((stage) => stage.tone), ['attention', 'idle', 'attention']);
});
