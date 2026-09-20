import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import type { ProxyRule } from '@/utils/types';

// ═══════════════════════════════════════════════════════════════════════════════
// F1：页面拦截器选中的规则必须在 SW 侧得到尊重
//
// 桥接层只下发复杂规则（content.ts 的 toInterceptorConfig），SW 却用全量规则重匹配，
// 于是一条更宽、优先级更高的简单规则会抢走请求：窄规则的 Mock/头注入静默失效，
// 窄规则是 blocked 时被阻断的请求真的发出去。
// ═══════════════════════════════════════════════════════════════════════════════

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: '',
    targetUrl: '',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 更宽的简单规则（纯重写 → 本该由 DNR 承载），优先级最高 */
const WIDE = makeRule({
  id: 'wide',
  name: '宽规则（简单）',
  matchPattern: 'https://api.example.com/*',
  targetUrl: 'https://uat.example.com',
  priority: 1,
});

/** 更窄的复杂规则（targetUrl 为空 → SW 通道），优先级低于宽规则 */
function narrow(overrides: Partial<ProxyRule>): ProxyRule {
  return makeRule({
    id: 'narrow',
    name: '窄规则（复杂）',
    matchPattern: 'https://api.example.com/admin/*',
    targetUrl: '',
    priority: 5,
    ...overrides,
  });
}

const ADMIN_URL = 'https://api.example.com/admin/users';

describe('handleProxyRequest — 拦截器已选规则优先于全量重匹配', () => {
  const store: Record<string, unknown> = {};
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    fetchMock.mockReset();
    vi.useFakeTimers();
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
    vi.stubGlobal(
      'fetch',
      fetchMock.mockImplementation(async () => new Response('real upstream', { status: 200, statusText: 'OK' })),
    );
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function request(data: { url: string; method: string; ruleId?: string }) {
    const { handleProxyRequest } = await import('@/entrypoints/background/proxyHandler');
    return handleProxyRequest({ requestId: 'req-1', headers: {}, ...data });
  }

  it('修复前会走宽规则真发请求：阻断窄规则带 ruleId 时必须被阻断', async () => {
    store['proxy_config'] = { enabled: true, rules: [WIDE, narrow({ blocked: true })] };

    const resp = await request({ url: ADMIN_URL, method: 'GET', ruleId: 'narrow' });

    expect(resp.statusText).toBe('Blocked');
    expect(resp.status).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Mock 窄规则同样优先：不回落到宽规则的真实上游', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [WIDE, narrow({ mockResponse: { body: '{"mocked":true}', status: 201 } })],
    };

    const resp = await request({ url: ADMIN_URL, method: 'GET', ruleId: 'narrow' });

    expect(resp.status).toBe(201);
    expect(resp.body).toContain('"mocked":true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不带 ruleId 时维持原有的全量重匹配（其他调用方与旧页面不受影响）', async () => {
    store['proxy_config'] = { enabled: true, rules: [WIDE, narrow({ blocked: true })] };

    const resp = await request({ url: ADMIN_URL, method: 'GET' });

    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resp.statusText).not.toBe('Blocked');
  });

  it('伪造的 ruleId 拿不到能力：规则不匹配该 URL 即回落重匹配', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [WIDE, narrow({ blocked: true }), makeRule({ id: 'elsewhere', matchPattern: 'https://other.com/*' })],
    };

    const resp = await request({ url: ADMIN_URL, method: 'GET', ruleId: 'elsewhere' });

    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ruleId 指向已停用规则时回落，不静默绕过', async () => {
    store['proxy_config'] = { enabled: true, rules: [WIDE, narrow({ blocked: true, enabled: false })] };

    const resp = await request({ url: ADMIN_URL, method: 'GET', ruleId: 'narrow' });

    expect(resp.status).toBe(200);
  });

  it('ruleId 指向不存在的规则时按无匹配处理，不抛错', async () => {
    store['proxy_config'] = { enabled: true, rules: [WIDE] };

    const resp = await request({ url: 'https://nomatch.example.com/x', method: 'GET', ruleId: 'ghost' });

    expect(resp.status).toBe(0);
    expect(resp.statusText).toBe('Proxy Bypass');
    expect(resp.body).toBe('No matching rule');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('方法不匹配时该 ruleId 不被采纳（窄规则的 methods 白名单仍是判据）', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [WIDE, narrow({ blocked: true, methods: ['POST'] })],
    };

    const resp = await request({ url: ADMIN_URL, method: 'GET', ruleId: 'narrow' });

    expect(resp.status).toBe(200);
  });
});

describe('MAIN world 拦截器 — 必须把已选规则带给 SW（源码契约）', () => {
  it('proxyFetch 的出站载荷带 ruleId（fetch 与 XHR 共用同一出口）', () => {
    const src = fs.readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');
    expect(src).toContain('ruleId: rule.id');
    expect(src.match(/type:\s*PROXY_REQUEST/g)).toHaveLength(1);
  });
});
