import { describe, it, expect } from 'vitest';
import { isSimpleRule } from '@/utils/urlMatcher';
import type { ProxyRule } from '@/utils/types';

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

describe('isSimpleRule - mock/delay/block routing', () => {
  it('should be simple with no overrides', () => {
    expect(isSimpleRule(makeRule({}))).toBe(true);
  });

  it('should NOT be simple with headerOverrides', () => {
    expect(isSimpleRule(makeRule({ headerOverrides: { 'X-Test': '1' } }))).toBe(false);
  });

  it('should NOT be simple with mockResponse', () => {
    expect(
      isSimpleRule(
        makeRule({
          mockResponse: { body: '{"mock": true}', status: 200, contentType: 'application/json' },
        }),
      ),
    ).toBe(false);
  });

  it('should NOT be simple with delayMs', () => {
    expect(isSimpleRule(makeRule({ delayMs: 1000 }))).toBe(false);
  });

  it('should NOT be simple with blocked', () => {
    expect(isSimpleRule(makeRule({ blocked: true }))).toBe(false);
  });

  it('should NOT be simple with requestBodyOverride', () => {
    expect(isSimpleRule(makeRule({ requestBodyOverride: '{"override": true}' }))).toBe(false);
  });

  it('should NOT be simple with responseOverrides', () => {
    expect(
      isSimpleRule(
        makeRule({
          responseOverrides: { status: 201, headers: { 'X-Custom': 'test' } },
        }),
      ),
    ).toBe(false);
  });

  it('should NOT be simple with multiple overrides combined', () => {
    expect(
      isSimpleRule(
        makeRule({
          mockResponse: { body: '{}', status: 200 },
          delayMs: 500,
          blocked: false,
        }),
      ),
    ).toBe(false);
  });

  it('should be simple with empty headerOverrides', () => {
    expect(isSimpleRule(makeRule({ headerOverrides: {} }))).toBe(true);
  });

  it('should be simple with blocked=false (falsy)', () => {
    expect(isSimpleRule(makeRule({ blocked: false }))).toBe(true);
  });

  it('should be simple with delayMs=0 (falsy)', () => {
    expect(isSimpleRule(makeRule({ delayMs: 0 }))).toBe(true);
  });
});
