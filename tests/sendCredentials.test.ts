import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import type { ProxyRule } from '@/utils/types';
import { isSimpleRule } from '@/utils/urlMatcher';

// ═══════════════════════════════════════════════════════════════════════════════
// F3：规则级「携带 Cookie」（sendCredentials，默认关闭）
//
// SW 以 chrome-extension:// 发起 fetch，默认 credentials: 'same-origin' 对跨源目标一律
// 不带 Cookie，需要登录态的接口在代理后始终 401。开启这条能力的规则必须走 SW 通道
// （DNR 重定向后由浏览器直接发请求，扩展无从干预其 Cookie），且默认关闭 = 出站请求零变化。
// ═══════════════════════════════════════════════════════════════════════════════

function makeRule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r1',
    name: 'FAT → UAT',
    enabled: true,
    matchPattern: 'https://api.example.com/*',
    targetUrl: 'https://uat.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('isSimpleRule — 携带凭据的规则强制走 SW 通道', () => {
  it('未开启时仍是简单规则（由 DNR 承载，出站行为与改动前一致）', () => {
    expect(isSimpleRule(makeRule())).toBe(true);
  });

  it('显式开启后必须走 SW：DNR 无法为跨站子请求附带 Cookie', () => {
    expect(isSimpleRule(makeRule({ sendCredentials: true }))).toBe(false);
  });

  it('false 与未设置等价', () => {
    expect(isSimpleRule(makeRule({ sendCredentials: false }))).toBe(true);
  });

  it('导入文件里的真值字符串不算开启（不可信输入不能单边打开凭据）', () => {
    expect(isSimpleRule(makeRule({ sendCredentials: 'yes' as unknown as boolean }))).toBe(true);
  });
});

describe('handleProxyRequest — credentials 只在规则显式开启时附带', () => {
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
      fetchMock.mockImplementation(async () => new Response('upstream', { status: 200, statusText: 'OK' })),
    );
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function request(url = 'https://api.example.com/users') {
    const { handleProxyRequest } = await import('@/entrypoints/background/proxyHandler');
    return handleProxyRequest({ requestId: 'req-1', url, method: 'GET', headers: {} });
  }

  it('开启的规则：fetch 带 credentials: include', async () => {
    store['proxy_config'] = { enabled: true, rules: [makeRule({ sendCredentials: true })] };

    const resp = await request();

    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('未开启的规则：fetchOptions 里根本不出现 credentials 键（默认路径逐字节不变）', async () => {
    store['proxy_config'] = { enabled: true, rules: [makeRule()] };

    await request();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('credentials');
  });

  it('真值字符串不触发 include，与 isSimpleRule 同判据', async () => {
    store['proxy_config'] = { enabled: true, rules: [makeRule({ sendCredentials: 'yes' as unknown as boolean })] };

    await request();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('credentials');
  });
});

describe('分流与执行必须同判据（源码契约）', () => {
  it('isSimpleRule、proxyHandler 两侧都按 === true 判定，页面侧则整字段剥离', () => {
    expect(fs.readFileSync('utils/urlMatcher.ts', 'utf-8')).toContain('rule.sendCredentials === true');
    expect(fs.readFileSync('entrypoints/background/proxyHandler.ts', 'utf-8')).toContain(
      'rule.sendCredentials === true',
    );
    expect(fs.readFileSync('entrypoints/content.ts', 'utf-8')).toContain("'sendCredentials'");
  });
});
