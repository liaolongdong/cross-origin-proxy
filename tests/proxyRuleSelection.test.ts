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

  it('`rules` 被手改成非数组：按「没有规则命中」落定，而不是抛一句 rules.find is not a function', async () => {
    // 代发路径取规则数组只走 `configRules()`。结局本来一样（桥接层拿不到可代发的规则 → 页面回退原生），
    // 差别在日志与回包上留下的是「无匹配规则」还是一行看着像上游故障的 TypeError。
    store['proxy_config'] = { enabled: true, rules: { '0': { id: 'wide' } } };

    const resp = await request({ url: ADMIN_URL, method: 'GET', ruleId: 'wide' });

    expect(resp.status).toBe(0);
    expect(resp.statusText).toBe('Proxy Bypass');
    expect(resp.body).toBe('No matching rule');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── 出站协议白名单（`utils/proxyProtocol.ts`）────────────────────────────────
  // 这两格各自都「什么都不会发生」，而漏掉的那一格是扩展替页面出门取东西、把正文交回它手里。

  it('页面点名 `file://`：一条合法形状的宽匹配空目标规则不足以让它出门', async () => {
    // 三件事各自都对、叠起来是洞：`{wildcard,'*',targetUrl:''}` 过形状闸（`isValidRuleShape` 只要求
    // `matchPattern` 非空白、`targetUrl` 是串）、`wildcardToRegex('*')` 命中任何串、
    // `isSimpleRule` 因空目标**强制**把它交给 SW、`rewriteUrl` 对空目标原样返回 URL。
    // 于是 `data.url` 那一句由页面说了算，而 `<all_urls>` 由扩展持有。
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ id: 'all', name: '宽到一切', matchPattern: '*', targetUrl: '', headerOverrides: { x: 'y' } })],
    };

    const resp = await request({ url: 'file:///Users/me/.aws/credentials', method: 'GET' });

    expect(resp.status).toBe(0);
    expect(resp.statusText).toBe('Proxy Bypass');
    expect(resp.body).toBe('Unsupported protocol');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('白名单管协议、不管主机：内网与元数据地址是 http 就照常代发', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ id: 'all', name: '宽到一切', matchPattern: '*', targetUrl: '', headerOverrides: { x: 'y' } })],
    };

    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:6379/']) {
      // 这一档**故意放行**：白名单管协议，不管主机。用户写了宽到一切的规则，内网 http 端点
      // 本来就在这条规则的射程里；把主机也拦进来就是替用户决定他的代理该覆盖哪些地址。
      fetchMock.mockClear();
      const resp = await request({ url, method: 'GET' });
      expect(resp.body, url).not.toBe('Unsupported protocol');
      expect(fetchMock, url).toHaveBeenCalledTimes(1);
    }

    // 而 `ftp:` 那一档不管主机都要拒：不是 fetch 发不出去，是「扩展不该替页面出这种门」
    fetchMock.mockClear();
    const ftp = await request({ url: 'ftp://internal/x', method: 'GET' });
    expect(ftp.body).toBe('Unsupported protocol');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('规则把目标写成 `file://` 时也不出门：入站那一道闸管不到重写之后的串', async () => {
    // 第二条门在另一边：`targetUrl` 同样是自由文本（手改存储、别人分享的导入文件）。
    // 只守入站那一头的规则会漏掉这一格——页面给的是 https（过闸），重写出来是个本地路径。
    // 这条规则刻意不带 mock / block：只有真走到 `fetch` 那一支才谈得上「出门」。
    store['proxy_config'] = {
      enabled: true,
      rules: [
        makeRule({
          id: 'evil',
          name: '目标是本地文件',
          matchType: 'prefix',
          matchPattern: 'https://api.example.com/',
          targetUrl: 'file:///etc/passwd',
          headerOverrides: { 'x-a': 'b' },
        }),
      ],
    };

    const resp = await request({ url: ADMIN_URL, method: 'GET' });

    expect(resp.status).toBe(0);
    expect(resp.body).toBe('Unsupported protocol');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MAIN world 拦截器 — 必须把已选规则带给 SW（源码契约）', () => {
  it('proxyFetch 的出站载荷带 ruleId（fetch 与 XHR 共用同一出口）', () => {
    const src = fs.readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');
    expect(src).toContain('ruleId: rule.id');
    expect(src.match(/type:\s*PROXY_REQUEST/g)).toHaveLength(1);
  });
});
