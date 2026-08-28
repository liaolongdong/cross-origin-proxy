import { describe, it, expect, vi } from 'vitest';
import type { MockCondition, ProxyRule } from '@/utils/types';

// Mock chrome APIs before importing modules that depend on them
vi.stubGlobal('chrome', {
  storage: {
    local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { getURL: vi.fn().mockReturnValue('chrome-extension://test/') },
});

// Now import after mocking
const { isRetryableError, matchesMockCondition } = await import('@/entrypoints/background/proxyHandler');
const { deduplicateRules } = await import('@/entrypoints/background/messageRouter');

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: 'https://api.example.com/*',
    targetUrl: 'https://mock.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('isRetryableError', () => {
  it('5xx status is retryable', () => {
    expect(isRetryableError(null, 500)).toBe(true);
    expect(isRetryableError(null, 503)).toBe(true);
  });

  it('4xx status is NOT retryable', () => {
    expect(isRetryableError(null, 400)).toBe(false);
    expect(isRetryableError(null, 404)).toBe(false);
    expect(isRetryableError(null, 200)).toBe(false);
  });

  it('AbortError (timeout) is retryable', () => {
    const err = new Error('timeout');
    err.name = 'AbortError';
    expect(isRetryableError(err)).toBe(true);
  });

  it('TypeError (network error) is retryable', () => {
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('generic Error is NOT retryable without matching status', () => {
    expect(isRetryableError(new Error('some error'))).toBe(false);
  });
});

describe('matchesMockCondition', () => {
  it('empty condition matches everything', () => {
    const cond: MockCondition = { body: '{}' };
    expect(matchesMockCondition('https://api.example.com/test', 'GET', cond)).toBe(true);
  });

  it('URL regex match', () => {
    const cond: MockCondition = { body: '{}', matchUrl: '/users/\\d+' };
    expect(matchesMockCondition('https://api.example.com/users/123', 'GET', cond)).toBe(true);
    expect(matchesMockCondition('https://api.example.com/users/abc', 'GET', cond)).toBe(false);
  });

  it('method match (case-insensitive)', () => {
    const cond: MockCondition = { body: '{}', matchMethod: 'post' };
    expect(matchesMockCondition('https://api.example.com/test', 'POST', cond)).toBe(true);
    expect(matchesMockCondition('https://api.example.com/test', 'GET', cond)).toBe(false);
  });

  it('query param match', () => {
    const cond: MockCondition = { body: '{}', matchQuery: { page: '1', size: '10' } };
    expect(matchesMockCondition('https://api.example.com/test?page=1&size=10', 'GET', cond)).toBe(true);
    expect(matchesMockCondition('https://api.example.com/test?page=1', 'GET', cond)).toBe(false);
    expect(matchesMockCondition('https://api.example.com/test?page=2&size=10', 'GET', cond)).toBe(false);
  });

  it('combined conditions (AND logic)', () => {
    const cond: MockCondition = {
      body: '{}',
      matchUrl: '/api/',
      matchMethod: 'POST',
      matchQuery: { action: 'create' },
    };
    expect(
      matchesMockCondition('https://api.example.com/api/test?action=create', 'POST', cond),
    ).toBe(true);
    expect(
      matchesMockCondition('https://api.example.com/api/test?action=create', 'GET', cond),
    ).toBe(false);
  });

  it('invalid regex returns false', () => {
    const cond: MockCondition = { body: '{}', matchUrl: '[invalid' };
    expect(matchesMockCondition('https://api.example.com/test', 'GET', cond)).toBe(false);
  });
});

describe('deduplicateRules', () => {
  it('empty existing returns all incoming', () => {
    const incoming = [makeRule({ id: 'a', name: 'A', matchPattern: 'https://a.com/*' })];
    expect(deduplicateRules([], incoming)).toEqual(incoming);
  });

  it('empty incoming returns empty', () => {
    const existing = [makeRule({ id: 'a', name: 'A', matchPattern: 'https://a.com/*' })];
    expect(deduplicateRules(existing, [])).toEqual([]);
  });

  it('overlapping by name+matchPattern are filtered', () => {
    const existing = [makeRule({ id: 'a', name: 'A', matchPattern: 'https://a.com/*' })];
    const incoming = [
      makeRule({ id: 'b', name: 'A', matchPattern: 'https://a.com/*' }),
      makeRule({ id: 'c', name: 'C', matchPattern: 'https://c.com/*' }),
    ];
    const result = deduplicateRules(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c');
  });

  it('same name but different matchPattern is NOT duplicate', () => {
    const existing = [makeRule({ id: 'a', name: 'A', matchPattern: 'https://a.com/*' })];
    const incoming = [makeRule({ id: 'b', name: 'A', matchPattern: 'https://b.com/*' })];
    expect(deduplicateRules(existing, incoming)).toHaveLength(1);
  });

  it('same matchPattern but different name is NOT duplicate', () => {
    const existing = [makeRule({ id: 'a', name: 'A', matchPattern: 'https://a.com/*' })];
    const incoming = [makeRule({ id: 'b', name: 'B', matchPattern: 'https://a.com/*' })];
    expect(deduplicateRules(existing, incoming)).toHaveLength(1);
  });
});
