import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelRouter,
  type ChatRequest,
  type ModelCapabilities,
  type ModelDriver,
} from '../src/index.js';

class FakeDriver implements ModelDriver {
  constructor(
    private readonly driverId: string,
    private readonly profile: ModelCapabilities,
  ) {}

  id(): string {
    return this.driverId;
  }

  capabilities(): ModelCapabilities {
    return this.profile;
  }

  async *chat(_request: ChatRequest, _apiKey: string): AsyncIterable<string> {
    yield this.driverId;
  }
}

function router(): ModelRouter {
  const value = new ModelRouter();
  value.register(new FakeDriver('local-code', {
    contextWindow: 32_000,
    supportsTools: true,
    supportsVision: false,
    isLocal: true,
    costTier: 'low',
  }));
  value.register(new FakeDriver('remote-vision', {
    contextWindow: 128_000,
    supportsTools: true,
    supportsVision: true,
    isLocal: false,
    costTier: 'high',
  }));
  value.register(new FakeDriver('remote-cheap', {
    contextWindow: 16_000,
    supportsTools: false,
    supportsVision: false,
    isLocal: false,
    costTier: 'low',
  }));
  return value;
}

test('local-preferred 研究任务优先选择满足上下文要求的本地模型', () => {
  const decision = router().decide({ kind: 'research', dataBoundary: 'local-preferred' });
  assert.equal(decision.driver.id(), 'local-code');
  assert.match(decision.reason, /本地优先/);
});

test('local-only 和工具需求会硬过滤不满足边界或能力的模型', () => {
  const decision = router().decide({
    kind: 'code',
    dataBoundary: 'local-only',
    minContextTokens: 20_000,
    needsTools: true,
  });
  assert.equal(decision.driver.id(), 'local-code');
  assert.deepEqual(decision.candidates.map((candidate) => candidate.driverId), ['local-code']);
});

test('视觉任务选择支持视觉的模型，严格边界无候选时明确失败', () => {
  const value = router();
  assert.equal(value.decide({ kind: 'chat', needsVision: true }).driver.id(), 'remote-vision');
  assert.throws(
    () => value.decide({ kind: 'code', dataBoundary: 'local-only', minContextTokens: 64_000 }),
    /no model satisfies/,
  );
});

test('同分候选按 driverId 稳定排序，保证任务回放可预测', () => {
  const value = new ModelRouter();
  for (const id of ['zeta', 'alpha']) {
    value.register(new FakeDriver(id, {
      contextWindow: 8_000,
      supportsTools: false,
      supportsVision: false,
      isLocal: false,
      costTier: 'medium',
    }));
  }
  assert.equal(value.decide({ kind: 'chat' }).driver.id(), 'alpha');
});
