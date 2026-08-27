import { describe, it, expect } from 'vitest';
import { matchRule, rewriteUrl, findMatchingRule, isSimpleRule } from '@/utils/urlMatcher';
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

describe('matchRule', () => {
  it('wildcard 匹配末尾通配', () => {
    const rule = makeRule({ matchPattern: 'https://fat-api.example.com/*' });
    expect(matchRule('https://fat-api.example.com/api/users', rule)).toBe(true);
    expect(matchRule('https://other.example.com/api', rule)).toBe(false);
  });

  it('prefix 前缀匹配', () => {
    const rule = makeRule({ matchType: 'prefix', matchPattern: 'https://fat-api.example.com' });
    expect(matchRule('https://fat-api.example.com/api', rule)).toBe(true);
    expect(matchRule('https://uat-api.example.com/api', rule)).toBe(false);
  });

  it('regex 正则匹配（非法正则不抛错）', () => {
    const rule = makeRule({ matchType: 'regex', matchPattern: '^https://fat-.*\\.example\\.com/' });
    expect(matchRule('https://fat-api.example.com/api', rule)).toBe(true);
    const bad = makeRule({ matchType: 'regex', matchPattern: '([' });
    expect(matchRule('https://x.com', bad)).toBe(false);
  });

  it('停用规则不匹配', () => {
    const rule = makeRule({ matchPattern: 'https://a.com/*', enabled: false });
    expect(matchRule('https://a.com/x', rule)).toBe(false);
  });
});

describe('rewriteUrl', () => {
  it('wildcard 重写补回分隔斜杠（回归：曾拼出坏 URL）', () => {
    const rule = makeRule({
      matchPattern: 'https://fat-api.example.com/*',
      targetUrl: 'https://uat-api.example.com',
    });
    expect(rewriteUrl('https://fat-api.example.com/api/users', rule)).toBe('https://uat-api.example.com/api/users');
  });

  it('wildcard 目标 URL 末尾斜杠被规整', () => {
    const rule = makeRule({
      matchPattern: 'https://fat-api.example.com/*',
      targetUrl: 'https://uat-api.example.com/',
    });
    expect(rewriteUrl('https://fat-api.example.com/api', rule)).toBe('https://uat-api.example.com/api');
  });

  it('prefix 重写保留剩余路径', () => {
    const rule = makeRule({
      matchType: 'prefix',
      matchPattern: 'https://fat-api.example.com',
      targetUrl: 'https://uat-api.example.com',
    });
    expect(rewriteUrl('https://fat-api.example.com/api?a=1', rule)).toBe('https://uat-api.example.com/api?a=1');
  });

  it('regex 重写支持捕获组引用', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: '^https://fat-api\\.example\\.com/(.*)$',
      targetUrl: 'https://uat-api.example.com/$1',
    });
    expect(rewriteUrl('https://fat-api.example.com/api/users', rule)).toBe('https://uat-api.example.com/api/users');
  });
});

describe('findMatchingRule', () => {
  it('按优先级（数值小者优先）返回首个匹配', () => {
    const low = makeRule({ id: 'low', matchPattern: 'https://a.com/*', priority: 20 });
    const high = makeRule({ id: 'high', matchPattern: 'https://a.com/*', priority: 1 });
    expect(findMatchingRule('https://a.com/x', [low, high])?.id).toBe('high');
  });

  it('无匹配返回 null', () => {
    const rule = makeRule({ matchPattern: 'https://a.com/*' });
    expect(findMatchingRule('https://b.com/x', [rule])).toBeNull();
  });
});

describe('isSimpleRule', () => {
  it('无 headerOverrides 为简单规则', () => {
    expect(isSimpleRule(makeRule({}))).toBe(true);
    expect(isSimpleRule(makeRule({ headerOverrides: {} }))).toBe(true);
    expect(isSimpleRule(makeRule({ headerOverrides: { 'X-Env': 'uat' } }))).toBe(false);
  });
});
