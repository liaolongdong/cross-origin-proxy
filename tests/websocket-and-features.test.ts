import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProxyRule, ProxyConfig } from '@/utils/types';
import { STORAGE_KEYS } from '@/utils/constants';

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: 'https://fat.example.com/*',
    targetUrl: 'https://uat.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/**
 * 驱动 SW 通道 handleProxyRequest：注入含单条规则的代理配置，断言最终 fetch 请求。
 * 每次调用前重置模块，确保 storage 内存缓存与匹配器缓存不跨用例串味。
 */
describe('handleProxyRequest — 方法过滤与查询参数注入（SW 通道）', () => {
  const store: Record<string, unknown> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function run(url: string, method: string, rules: ProxyRule[]) {
    const config: ProxyConfig = { enabled: true, rules };
    store[STORAGE_KEYS.PROXY_CONFIG] = config;
    const mod = await import('@/entrypoints/background/proxyHandler');
    return mod.handleProxyRequest({ requestId: 'req-1', url, method, headers: {}, body: null });
  }

  it('查询参数覆盖在重写后的目标 URL 上生效', async () => {
    const rule = makeRule({ queryOverrides: { env: 'uat', tag: 'g1' } });
    const res = await run('https://fat.example.com/api/users', 'GET', [rule]);
    expect(res.status).toBe(200);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('https://uat.example.com/api/users');
    expect(calledUrl).toContain('env=uat');
    expect(calledUrl).toContain('tag=g1');
  });

  it('methods 白名单不匹配时不代理（视为无命中，返回旁路）', async () => {
    const rule = makeRule({ methods: ['POST'] });
    const res = await run('https://fat.example.com/api/users', 'GET', [rule]);
    expect(res.status).toBe(0);
    expect(res.statusText).toBe('Proxy Bypass');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('methods 白名单匹配（大小写不敏感）时正常代理', async () => {
    const rule = makeRule({ methods: ['POST'] });
    const res = await run('https://fat.example.com/api/users', 'post', [rule]);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('无 methods 配置时任意方法均代理（向后兼容）', async () => {
    const rule = makeRule({});
    const res = await run('https://fat.example.com/api/users', 'DELETE', [rule]);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
