/**
 * 后台失败信封不得让页面把失败读成成功
 *
 * `respondAsync` 在 Promise reject 时回 `{ success: false, error }`——既无 `requestId`
 * 也无 `status`。它经桥接层原样转发给 MAIN world 后有两种坏结局：
 * 无 requestId ⇒ 拦截器无人认领，页面挂满 35s 超时后**回退原生请求**；
 * 有 requestId 无 status ⇒ `new Response(body, { status: undefined })` 静默变成 **HTTP 200**。
 *
 * 整形发生在 `utils/proxyResponse.ts`（可直接单测），拦截器侧的区间守卫是自包含
 * world 里的第二层兜底，只能用源码契约固定（与 round3 对 computeProxyTimeout 的做法同源）。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeProxyResponse } from '@/utils/proxyResponse';

vi.stubGlobal('chrome', {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { getURL: vi.fn(() => 'chrome-extension://test/') },
});

const { clampResponseStatus } = await import('@/entrypoints/background/proxyHandler');

describe('normalizeProxyResponse：后台失败信封（回归：挂到超时后回退原生请求）', () => {
  const REQ_ID = 'req-7-1700000000000';

  it('补回 requestId，让拦截器能兑现挂起请求而不是等超时', () => {
    const out = normalizeProxyResponse({ success: false, error: 'storage exploded' }, REQ_ID);
    expect(out.requestId).toBe(REQ_ID);
  });

  it('status 缺失回落为 0（拦截器据此判失败，而不是构造出 200）', () => {
    expect(normalizeProxyResponse({ success: false, error: 'x' }, REQ_ID).status).toBe(0);
  });

  it('不外泄后台内部错误文案给页面', () => {
    const out = normalizeProxyResponse({ success: false, error: 'chrome.storage quota' }, REQ_ID);
    expect(out.body).not.toContain('quota');
    expect(out.statusText).toBe('Proxy Error');
  });

  it('回包为 undefined / null / 非对象时仍产出完整载荷', () => {
    for (const raw of [undefined, null, 'nope', 42]) {
      const out = normalizeProxyResponse(raw, REQ_ID);
      expect(out).toMatchObject({ requestId: REQ_ID, status: 0, headers: {}, body: '', isBase64: false });
    }
  });
});

describe('normalizeProxyResponse：正常回包原样透传', () => {
  const ok = {
    requestId: 'req-1-1',
    status: 204,
    statusText: 'No Content',
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    isBase64: false,
  };

  it('六个字段逐一保持，不夹带加工', () => {
    expect(normalizeProxyResponse(ok, 'fallback-id')).toEqual(ok);
  });

  it('status 为 0 的旁路/阻断响应不被改写（拦截器靠它判失败）', () => {
    const bypassed = { ...ok, status: 0, statusText: 'Blocked', body: 'Request blocked by proxy rule' };
    expect(normalizeProxyResponse(bypassed, 'fallback-id')).toEqual(bypassed);
  });

  it('保留后端真实状态码（4xx/5xx 不是代理失败）', () => {
    expect(normalizeProxyResponse({ ...ok, status: 503, statusText: 'Unavailable' }, 'x').status).toBe(503);
  });

  it('headers 含非字符串值时整体退回空对象，不拼接脏数据', () => {
    const out = normalizeProxyResponse({ ...ok, headers: { a: 1, b: '2' } }, 'x');
    expect(out.headers).toEqual({});
  });

  it('requestId 类型不端时用桥接层持有的 id 顶替', () => {
    expect(normalizeProxyResponse({ ...ok, requestId: 123 }, 'bridge-id').requestId).toBe('bridge-id');
  });
});

describe('拦截器第二层守卫契约（MAIN world 自包含，无法导入被测函数）', () => {
  const source = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');

  it('构造 Response 前先把非数字 status 归一化为 0', () => {
    const normalizeAt = source.search(/typeof\s+data\?\.status\s*===\s*'number'\s*\?\s+data\.status\s*:\s*0/);
    const responseAt = source.search(/resolve\(new Response\(/);
    expect(normalizeAt).toBeGreaterThan(-1);
    expect(responseAt).toBeGreaterThan(normalizeAt);
  });

  it('不再使用对 undefined 三个比较全放行的旧写法', () => {
    expect(source).not.toMatch(/data\.status === 0 \|\| data\.status < 200/);
  });

  it('阻断判定兼看本地 rule.blocked，超时/异常时也不回退原生 fetch', () => {
    expect(source).toMatch(
      /if\s*\(rule\?\.blocked \|\|\s*\(error as \{ __proxyBlocked\?: boolean \}\)\?\.__proxyBlocked\)/,
    );
  });
});

describe('状态码钳制（clampResponseStatus）：越界值不得让前端构造 Response 失败', () => {
  it('区间内原样保留，含 4xx/5xx 这类后端真实状态', () => {
    for (const status of [200, 204, 404, 499, 503, 599]) {
      expect(clampResponseStatus(status)).toBe(status);
    }
  });

  it('贴着边界的外侧值收进区间', () => {
    expect(clampResponseStatus(199)).toBe(200);
    expect(clampResponseStatus(600)).toBe(599);
  });

  it('0、负数与超界值都落到可构造区间，而不是原样透传', () => {
    expect(clampResponseStatus(0)).toBe(200);
    expect(clampResponseStatus(-5)).toBe(200);
    expect(clampResponseStatus(999)).toBe(599);
  });

  it('小数取整，NaN 与非有限值回落 200/599，绝不产出 undefined 或 NaN', () => {
    expect(clampResponseStatus(404.7)).toBe(404);
    expect(clampResponseStatus(NaN)).toBe(200);
    expect(clampResponseStatus(Infinity)).toBe(599);
    expect(clampResponseStatus(-Infinity)).toBe(200);
  });
});
