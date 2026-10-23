/**
 * `utils/mockFromLog.ts` —— 「把这条响应存成 Mock」的唯一判据出口
 *
 * 断言全部按外部可观察面写：交出的草稿形状（用户存完打开表单会看到什么）与五档拒绝各自的理由。
 * 两处刻意不锁死：`name` 的具体排版（标签而已），以及 `mockResponse` 的字段顺序。
 *
 * 承重的三条：
 * - **截断判据用真 `truncateForLog` 的产物造**。硬编码那行后缀，产出方一改这边就静默不再拒，
 *   表现是「Mock 交付半截 JSON、页面在 `JSON.parse` 上抛错」——那正是这条拒绝存在的理由。
 * - **`prefix` 掐到 path**：查询参数不参与匹配，所以这一条会对同一 path 的任意 query 返回同一份
 *   响应；界面必须说清（`mockFromLogQueryNote`），而判据这边要保证 query 真的不在模式里。
 * - **一律停用**：mock 一生效，页面拿到的是看着正常的假数据，代价比一次改写失败更难察觉。
 */
import { describe, it, expect } from 'vitest';
import { buildMockDraftFromLog } from '@/utils/mockFromLog';
import { truncateForLog } from '@/utils/formatters';
import { DEFAULT_RULE_PRIORITY, MAX_LOG_BODY_SIZE } from '@/utils/constants';
import type { RequestLogEntry } from '@/utils/types';

function log(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: 'l1',
    timestamp: 0,
    ruleId: 'r1',
    ruleName: 'rule',
    originalUrl: 'https://api.example/users?page=2',
    proxiedUrl: 'https://api.example/users?page=2',
    method: 'GET',
    proxyType: 'sw',
    ...overrides,
  };
}

describe('buildMockDraftFromLog — 合格形状', () => {
  it('prefix 到 path、query 被掐、目标留空、默认停用', () => {
    const result = buildMockDraftFromLog(
      log({
        responseHeaders: { 'content-type': 'application/json' },
        status: 200,
        responseBody: '{"ok":1}',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft).toMatchObject({
      enabled: false,
      matchType: 'prefix',
      matchPattern: 'https://api.example/users',
      targetUrl: '',
      priority: DEFAULT_RULE_PRIORITY,
      mockResponse: { body: '{"ok":1}', status: 200, contentType: 'application/json' },
    });
  });

  it('名字带方法与路径（列表里要看得出这是哪一条接口）', () => {
    const result = buildMockDraftFromLog(log({ method: 'POST', status: 201, responseBody: '{}' }));
    expect(result.ok && result.draft.name).toBe('Mock: POST /users');
  });

  it('响应头的大小写不固定，取到就用、取不到就不设', () => {
    const upper = buildMockDraftFromLog(
      log({ responseHeaders: { 'Content-Type': 'text/plain' }, status: 200, responseBody: 'hi' }),
    );
    expect(upper.ok && upper.draft.mockResponse?.contentType).toBe('text/plain');

    const missing = buildMockDraftFromLog(log({ status: 200, responseBody: 'hi' }));
    expect(missing.ok && 'contentType' in (missing.draft.mockResponse ?? {})).toBe(false);

    const blank = buildMockDraftFromLog(
      log({ responseHeaders: { 'content-type': '   ' }, status: 200, responseBody: 'hi' }),
    );
    expect(blank.ok && 'contentType' in (blank.draft.mockResponse ?? {})).toBe(false);
  });

  it('用被改写后的地址而不是原始地址——那才是这一笔真正打到的地方', () => {
    const result = buildMockDraftFromLog(
      log({
        originalUrl: 'https://fat.example/api/x',
        proxiedUrl: 'https://uat.example/api/x',
        status: 200,
        responseBody: '{}',
      }),
    );
    expect(result.ok && result.draft.matchPattern).toBe('https://uat.example/api/x');
  });

  it('根路径给出 origin + /，不是光秃的 origin', () => {
    const result = buildMockDraftFromLog(log({ proxiedUrl: 'https://api.example', status: 204, responseBody: '' }));
    expect(result.ok && result.draft.matchPattern).toBe('https://api.example/');
    // 空正文是合法的（204 就是这么回的），不该被当成「没记到正文」
    expect(result.ok).toBe(true);
  });
});

describe('buildMockDraftFromLog — 五档拒绝', () => {
  it('没有正文', () => {
    expect(buildMockDraftFromLog(log({ status: 200 }))).toEqual({ ok: false, reason: 'noBody' });
  });

  it('没有状态码（失败与未响应的那几笔），但 404/500 是有用的 mock', () => {
    expect(buildMockDraftFromLog(log({ responseBody: 'x' }))).toEqual({ ok: false, reason: 'noStatus' });
    for (const status of [404, 500, 204]) {
      expect(buildMockDraftFromLog(log({ responseBody: 'x', status })).ok).toBe(true);
    }
  });

  it('二进制响应（base64 存成文本 mock 会交付一份坏响应）', () => {
    expect(buildMockDraftFromLog(log({ status: 200, responseBody: 'QUJD', responseIsBase64: true }))).toEqual({
      ok: false,
      reason: 'base64',
    });
  });

  it('截断过的正文一律拒绝，且判据用真 truncateForLog 的产物造', () => {
    const truncated = truncateForLog('x'.repeat(MAX_LOG_BODY_SIZE + 10), MAX_LOG_BODY_SIZE);
    expect(buildMockDraftFromLog(log({ status: 200, responseBody: truncated }))).toEqual({
      ok: false,
      reason: 'truncated',
    });
    // 恰好等于上限不算截断（产出方在 `<=` 时原样返回）
    expect(buildMockDraftFromLog(log({ status: 200, responseBody: 'x'.repeat(MAX_LOG_BODY_SIZE) })).ok).toBe(true);
  });

  it.each([
    ['读不出 URL', 'not a url'],
    ['非 http(s) 协议', 'ws://api.example/socket'],
    ['空到只剩相对路径', '/users'],
  ])('%s：给的是 badUrl，不是那句「没记到正文」', (_label, address) => {
    expect(buildMockDraftFromLog(log({ proxiedUrl: address, status: 200, responseBody: 'x' }))).toEqual({
      ok: false,
      reason: 'badUrl',
    });
  });

  it('proxiedUrl 是空串时回落 originalUrl，而不是判成坏地址', () => {
    expect(buildMockDraftFromLog(log({ proxiedUrl: '', status: 200, responseBody: 'x' })).ok).toBe(true);
  });
});
