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
  /**
   * 这两条判的是「筛查有没有把危险模式挡在编译之前」，所以断的是**结果**而不是耗时。
   * 原先写的是 `expect(duration < 100 || result === false).toBe(true)`——重言式，
   * 而且喂的还是一支会匹配成功的输入，筛查整个摘掉也照样绿。
   * 现在喂的输入若筛查失效会得到 `true`，红得有指向。
   */
  it('嵌套量词 `(a+)+$` 不参与匹配：不是「跑得够快」，是压根不编译', () => {
    const dangerousRule = makeRule({ matchType: 'regex', matchPattern: '(a+)+$' });
    expect(matchRule('a'.repeat(100), dangerousRule)).toBe(false);
  });

  it('多重嵌套量词 `((a*)*)*` 同样被拒', () => {
    const rule = makeRule({ matchType: 'regex', matchPattern: '((a*)*)*' });
    expect(matchRule('a'.repeat(50), rule)).toBe(false);
  });

  it('对照组：安全正则照常匹配，否则上面两条只是在断「regex 永不命中」', () => {
    const safeRule = makeRule({ matchType: 'regex', matchPattern: '^https://a+\\.example\\.com/.*' });
    expect(matchRule('https://aaa.example.com/x', safeRule)).toBe(true);
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
