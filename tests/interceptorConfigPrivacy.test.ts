import { describe, it, expect } from 'vitest';
import { toInterceptorConfig } from '@/entrypoints/content';
import type { ProxyConfig, ProxyRule } from '@/utils/types';

// ═══════════════════════════════════════════════════════════════════════════════
// S3：下发给页面的规则副本只保留页面侧真正要用的能力
//
// 配置经 postMessage 送达 MAIN world，同页面的任意脚本都能监听（入站校验只挡跨窗口，
// 挡不住同源）。凭据字段必须按「本 world 用不用得到」收窄，而不是整份规则原样广播。
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

const CREDENTIAL_FIELDS = ['headerOverrides', 'requestBodyOverride', 'responseOverrides', 'mockResponse'] as const;

function httpComplexRule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return makeRule({
    id: 'http',
    matchPattern: 'https://fat.example.com/api/*',
    targetUrl: 'https://uat.example.com/api',
    headerOverrides: { Authorization: 'Bearer secret-token' },
    queryOverrides: { tenant: 'secret-tenant', api_key: 'k-123' },
    delayMs: 50,
    ...overrides,
  });
}

function wsComplexRule(): ProxyRule {
  return makeRule({
    id: 'ws',
    matchPattern: 'wss://fat.example.com/ws/*',
    targetUrl: 'wss://uat.example.com/ws',
    queryOverrides: { session: 's-abc' },
  });
}

function configOf(rules: ProxyRule[]): ProxyConfig {
  return { enabled: true, rules };
}

describe('toInterceptorConfig — 页面侧凭据面收窄', () => {
  it('HTTP 复杂规则：SW 专属能力与查询参数注入一律不外泄', () => {
    const [pageRule] = toInterceptorConfig(configOf([httpComplexRule()])).rules;

    for (const field of CREDENTIAL_FIELDS) {
      expect(pageRule[field as keyof ProxyRule]).toBeUndefined();
    }
    expect(pageRule.queryOverrides).toBeUndefined();
  });

  it('HTTP 规则保留本 world 要用的匹配与转发字段', () => {
    const [pageRule] = toInterceptorConfig(configOf([httpComplexRule()])).rules;

    expect(pageRule.id).toBe('http');
    expect(pageRule.matchPattern).toBe('https://fat.example.com/api/*');
    expect(pageRule.targetUrl).toBe('https://uat.example.com/api');
    expect(pageRule.matchType).toBe('wildcard');
    expect(pageRule.enabled).toBe(true);
    // 阻断与延迟由拦截器本身消费，不属于凭据
    expect(pageRule.delayMs).toBe(50);
  });

  it('WS 规则仍带 queryOverrides（rewriteWsUrl 在本 world 追加参数）', () => {
    const [pageRule] = toInterceptorConfig(configOf([wsComplexRule()])).rules;

    expect(pageRule.queryOverrides).toEqual({ session: 's-abc' });
  });

  it('剥离只发生在副本上：storage 侧的完整规则不受影响', () => {
    const rule = httpComplexRule();
    toInterceptorConfig(configOf([rule]));

    expect(rule.headerOverrides).toEqual({ Authorization: 'Bearer secret-token' });
    expect(rule.queryOverrides).toEqual({ tenant: 'secret-tenant', api_key: 'k-123' });
  });

  it('简单规则仍被过滤（存量分流行为不变）', () => {
    const simple = makeRule({
      id: 'dnr',
      matchPattern: 'https://fat.example.com/*',
      targetUrl: 'https://uat.example.com',
    });

    expect(toInterceptorConfig(configOf([simple, httpComplexRule()])).rules.map(r => r.id)).toEqual(['http']);
  });

  it('「携带 Cookie」开关不外泄：拦截器不做 fetch，页侧读到它没有任何作用', () => {
    const [pageRule] = toInterceptorConfig(configOf([httpComplexRule({ sendCredentials: true })])).rules;

    expect(pageRule).not.toHaveProperty('sendCredentials');
  });

  it('仅因 sendCredentials 转 SW 的规则照样下发（否则页面不拦截、凭据路径直接失效）', () => {
    const credentialed = makeRule({
      id: 'cred',
      matchPattern: 'https://fat.example.com/api/*',
      targetUrl: 'https://uat.example.com/api',
      sendCredentials: true,
    });

    const out = toInterceptorConfig(configOf([credentialed]));
    expect(out.rules.map(r => r.id)).toEqual(['cred']);
    expect(out.rules[0]).not.toHaveProperty('sendCredentials');
  });
});
