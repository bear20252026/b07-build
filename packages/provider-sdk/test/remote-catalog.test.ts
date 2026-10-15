// 一个文件=一种作用：远端目录同步与物化的验收测试。
// 全部用例使用注入的替身抓取器，测试过程不出网。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatalogSyncError,
  RemoteProviderCatalog,
  materializeRemoteCatalog,
  type CatalogFetcher,
  type ProviderDefinition,
} from '../src/index.js';

interface StubCall {
  readonly url: string;
}

function stubFetcher(handler: (call: StubCall) => Promise<unknown>): {
  readonly fetcher: CatalogFetcher;
  readonly calls: StubCall[];
} {
  const calls: StubCall[] = [];
  return {
    calls,
    fetcher: async (url) => {
      calls.push({ url });
      const result = (await handler({ url })) as { ok: boolean; status: number; body?: unknown; jsonThrows?: boolean };
      return {
        ok: result.ok,
        status: result.status,
        json: async () => {
          if (result.jsonThrows) throw new Error('boom');
          return result.body;
        },
      };
    },
  };
}

const REMOTE_PAYLOAD = {
  revision: 7,
  providers: [
    {
      providerId: 'remote-a',
      providerName: 'Remote A',
      protocol: 'openai-compatible',
      defaultBaseUrl: 'https://a.test/v1',
      defaultModel: 'a-1',
      models: [
        {
          modelId: 'a-1',
          optionSpecs: { reasoningLevel: { map: '{"reasoning_effort":"$reasoningLevel"}', values: ['low'], defaultValue: 'low' } },
        },
      ],
    },
  ],
};

function baseDefinition(providerId: string): ProviderDefinition {
  return {
    providerId,
    providerName: `${providerId} 内置`,
    protocol: 'openai-compatible',
    defaultBaseUrl: `https://${providerId}.test/v1`,
    defaultModel: 'builtin-1',
    models: [{ modelId: 'builtin-1', optionSpecs: {} }],
  };
}

test('远端目录：注入的抓取器被调用一次，返回冻结快照并记入 current()', async () => {
  const { fetcher, calls } = stubFetcher(async () => ({ ok: true, status: 200, body: REMOTE_PAYLOAD }));
  const catalog = new RemoteProviderCatalog({ url: 'https://catalog.test/v1/catalog.json', fetcher, now: () => 1_700_000_000_000 });

  assert.equal(catalog.current(), undefined);
  const snapshot = await catalog.sync();

  assert.deepEqual(calls, [{ url: 'https://catalog.test/v1/catalog.json' }]);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.revision, 7);
  assert.equal(snapshot.fetchedAt, 1_700_000_000_000);
  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.providers[0]?.providerId, 'remote-a');
  assert.equal(Object.isFrozen(snapshot.providers), true);
  assert.equal(catalog.current(), snapshot);
});

test('远端目录：传输抛错、HTTP 非 2xx、JSON 解析失败各自映射为稳定错误码', async () => {
  const network = new RemoteProviderCatalog({
    url: 'https://catalog.test/x',
    fetcher: async () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(network.sync(), (error: unknown) => {
    assert.ok(error instanceof CatalogSyncError);
    assert.equal(error.code, 'catalog-network-error');
    return true;
  });

  const http = new RemoteProviderCatalog({
    url: 'https://catalog.test/x',
    fetcher: stubFetcher(async () => ({ ok: false, status: 503 })).fetcher,
  });
  await assert.rejects(http.sync(), (error: unknown) => {
    assert.ok(error instanceof CatalogSyncError);
    assert.equal(error.code, 'catalog-http-error');
    assert.equal(error.status, 503);
    return true;
  });

  const badJson = new RemoteProviderCatalog({
    url: 'https://catalog.test/x',
    fetcher: stubFetcher(async () => ({ ok: true, status: 200, jsonThrows: true })).fetcher,
  });
  await assert.rejects(badJson.sync(), (error: unknown) => {
    assert.ok(error instanceof CatalogSyncError);
    assert.equal(error.code, 'catalog-invalid-payload');
    return true;
  });
});

test('远端目录：负载形状不合法即整批作废，不做部分接受', async () => {
  const cases: readonly unknown[] = [
    { revision: 1 },
    { revision: 1, providers: 'nope' },
    { revision: 1, providers: [{ providerId: 'bad id', providerName: 'x', protocol: 'openai-compatible', defaultBaseUrl: '', defaultModel: 'm' }] },
    { revision: 1, providers: [{ providerId: 'ok', providerName: 'x', protocol: 'grpc', defaultBaseUrl: '', defaultModel: 'm' }] },
    { revision: 1, providers: [{ providerId: 'ok', providerName: 'x', protocol: 'openai-compatible', defaultBaseUrl: '', defaultModel: 'm', models: [{ modelId: 'm', optionSpecs: { a: {} } }] }] },
  ];
  for (const body of cases) {
    const catalog = new RemoteProviderCatalog({
      url: 'https://catalog.test/x',
      fetcher: stubFetcher(async () => ({ ok: true, status: 200, body })).fetcher,
    });
    await assert.rejects(catalog.sync(), (error: unknown) => {
      assert.ok(error instanceof CatalogSyncError);
      assert.equal(error.code, 'catalog-invalid-payload');
      return true;
    }, `负载应被拒绝：${JSON.stringify(body)}`);
  }
});

test('物化：远端按 providerId 整条覆盖内置，其余内置条目原样保留', async () => {
  const { fetcher } = stubFetcher(async () => ({
    ok: true,
    status: 200,
    body: {
      revision: 2,
      providers: [{ ...REMOTE_PAYLOAD.providers[0], providerId: 'shared', providerName: '远端同名' }],
    },
  }));
  const snapshot = await new RemoteProviderCatalog({ url: 'https://catalog.test/x', fetcher }).sync();

  const { definitions, registry } = materializeRemoteCatalog({
    base: [baseDefinition('shared'), baseDefinition('kept')],
    snapshot,
  });

  assert.deepEqual(definitions.map((item) => item.providerId), ['shared', 'kept']);
  assert.equal(registry.getProvider('shared')?.providerName, '远端同名');
  assert.equal(registry.getProvider('shared')?.defaultBaseUrl, 'https://a.test/v1');
  assert.equal(registry.getProvider('kept')?.providerName, 'kept 内置');
  assert.deepEqual(registry.validateSelection({ providerId: 'shared', modelId: 'a-1' }), {
    ok: true,
    requestPatch: { reasoning_effort: 'low' },
  });
});
