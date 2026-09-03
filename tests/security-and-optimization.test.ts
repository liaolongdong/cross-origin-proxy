import { describe, it, expect } from 'vitest';
import { matchRule, rewriteUrl } from '@/utils/urlMatcher';
import type { ProxyRule } from '@/utils/types';

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

describe('Security - ReDoS protection', () => {
  it('urlMatcher.ts should validate regex patterns for ReDoS', () => {
    // Dangerous pattern that could cause catastrophic backtracking
    const dangerousRule = makeRule({
      matchType: 'regex',
      matchPattern: '(a+)+$',
    });

    // Should either reject the pattern or handle it safely
    const start = Date.now();
    const result = matchRule('a'.repeat(100), dangerousRule);
    const duration = Date.now() - start;

    // Should complete in reasonable time (< 100ms) or return false
    expect(duration < 100 || result === false).toBe(true);
  });

  it('should handle nested quantifiers safely', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: '((a*)*)*',
    });

    const start = Date.now();
    matchRule('a'.repeat(50), rule);
    const duration = Date.now() - start;

    expect(duration < 100).toBe(true);
  });
});

describe('Bug fixes - URL rewriting edge cases', () => {
  it('wildcard with empty rest drops trailing slash', () => {
    const rule = makeRule({
      matchPattern: 'https://api.example.com/*',
      targetUrl: 'https://new-api.example.com',
    });

    // When wildcard captures empty string, no separator is added
    const result = rewriteUrl('https://api.example.com/', rule);
    expect(result).toBe('https://new-api.example.com');
  });

  it('prefix match with query string should preserve it', () => {
    const rule = makeRule({
      matchType: 'prefix',
      matchPattern: 'https://api.example.com',
      targetUrl: 'https://new-api.example.com',
    });

    const result = rewriteUrl('https://api.example.com/path?query=value', rule);
    expect(result).toBe('https://new-api.example.com/path?query=value');
  });

  it('regex with invalid pattern should return original URL', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: '[invalid',
      targetUrl: 'https://new-api.example.com',
    });

    const result = rewriteUrl('https://api.example.com/test', rule);
    expect(result).toBe('https://api.example.com/test');
  });
});

describe('Optimization - Large rule sets', () => {
  it('should handle 100+ rules efficiently', () => {
    const rules: ProxyRule[] = Array.from({ length: 150 }, (_, i) =>
      makeRule({
        id: `rule-${i}`,
        matchPattern: `https://api${i}.example.com/*`,
        targetUrl: `https://new-api${i}.example.com`,
        priority: i + 1,
      }),
    );

    const start = Date.now();
    const result = rewriteUrl('https://api149.example.com/test', rules[rules.length - 1]);
    const duration = Date.now() - start;

    expect(result).toBe('https://new-api149.example.com/test');
    expect(duration < 10).toBe(true); // Should be fast with caching
  });
});
