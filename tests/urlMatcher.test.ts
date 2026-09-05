import { describe, it, expect } from 'vitest';
import {
  matchRule,
  rewriteUrl,
  findMatchingRule,
  isSimpleRule,
  isWebSocketRule,
  applyQueryOverrides,
} from '@/utils/urlMatcher';
import type { ProxyRule } from '@/utils/types';

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: 'https://a.com/*',
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
    expect(isSimpleRule(makeRule({ targetUrl: 'https://b.com' }))).toBe(true);
    expect(isSimpleRule(makeRule({ targetUrl: 'https://b.com', headerOverrides: {} }))).toBe(true);
    expect(isSimpleRule(makeRule({ targetUrl: 'https://b.com', headerOverrides: { 'X-Env': 'uat' } }))).toBe(false);
  });

  it('不以 * 结尾的 wildcard 非简单规则（DNR 重写会丢失末尾固定文本）', () => {
    expect(isSimpleRule(makeRule({ targetUrl: 'https://b.com', matchPattern: 'https://a.com/*/suffix' }))).toBe(false);
    expect(isSimpleRule(makeRule({ targetUrl: 'https://b.com', matchPattern: 'https://a.com/*' }))).toBe(true);
  });

  it('空目标规则非简单（仅注入请求头场景走 SW 通道）', () => {
    expect(isSimpleRule(makeRule({ targetUrl: '' }))).toBe(false);
  });

  it('WebSocket 规则非简单（DNR 资源类型不含 websocket）——Bug 回归核心断言', () => {
    // 纯重写的 wss:// 规则以前会被误判为简单→只进 DNR→WS 静默不被代理
    expect(
      isSimpleRule(makeRule({ matchPattern: 'wss://fat.example.com/*', targetUrl: 'wss://uat.example.com' })),
    ).toBe(false);
    expect(isSimpleRule(makeRule({ matchPattern: 'ws://localhost:3000/*', targetUrl: 'ws://localhost:4000' }))).toBe(
      false,
    );
    // 目标为 wss 但模式为 https 的规则也归为 WS
    expect(isSimpleRule(makeRule({ matchPattern: 'https://a.com/*', targetUrl: 'wss://b.com' }))).toBe(false);
  });

  it('方法过滤 / 查询参数覆盖规则非简单（强制走 SW）', () => {
    expect(isSimpleRule(makeRule({ targetUrl: 'https://b.com', methods: ['GET'] }))).toBe(false);
    expect(isSimpleRule(makeRule({ targetUrl: 'https://b.com', methods: [] }))).toBe(true);
    expect(isSimpleRule(makeRule({ targetUrl: 'https://b.com', queryOverrides: { env: 'uat' } }))).toBe(false);
    expect(isSimpleRule(makeRule({ targetUrl: 'https://b.com', queryOverrides: {} }))).toBe(true);
  });
});

describe('isWebSocketRule', () => {
  it('识别 ws/wss 写法（大小写不敏感，不误判 websocket 路径）', () => {
    expect(isWebSocketRule({ matchPattern: 'wss://a.com/*', targetUrl: 'wss://b.com' })).toBe(true);
    expect(isWebSocketRule({ matchPattern: 'WS://a.com/*', targetUrl: '' })).toBe(true);
    expect(isWebSocketRule({ matchPattern: 'https://a.com/websocket/*', targetUrl: 'https://b.com' })).toBe(false);
    expect(isWebSocketRule({ matchPattern: 'https://a.com/*', targetUrl: 'wss://b.com' })).toBe(true);
  });
});

describe('method 过滤匹配', () => {
  it('matchRule 按方法白名单收窄（大小写不敏感）', () => {
    const rule = makeRule({ matchPattern: 'https://a.com/*', methods: ['POST'] });
    expect(matchRule('https://a.com/x', rule, 'post')).toBe(true);
    expect(matchRule('https://a.com/x', rule, 'GET')).toBe(false);
  });

  it('未配置 methods 时放行任意方法；无方法信息时不因方法收窄', () => {
    const rule = makeRule({ matchPattern: 'https://a.com/*' });
    expect(matchRule('https://a.com/x', rule, 'DELETE')).toBe(true);
    const postOnly = makeRule({ matchPattern: 'https://a.com/*', methods: ['POST'] });
    // method 为 undefined（如命中测试）不因方法维度排除
    expect(matchRule('https://a.com/x', postOnly)).toBe(true);
  });

  it('findMatchingRule 传递 method 后跳过方法不符的高优先规则', () => {
    const postOnly = makeRule({ id: 'p', matchPattern: 'https://a.com/*', methods: ['POST'], priority: 1 });
    const anyRule = makeRule({ id: 'a', matchPattern: 'https://a.com/*', priority: 20 });
    expect(findMatchingRule('https://a.com/x', [postOnly, anyRule], 'POST')?.id).toBe('p');
    expect(findMatchingRule('https://a.com/x', [postOnly, anyRule], 'GET')?.id).toBe('a');
  });
});

describe('applyQueryOverrides', () => {
  it('追加与覆盖查询参数', () => {
    expect(applyQueryOverrides('https://a.com/api?x=1', { env: 'uat' })).toBe('https://a.com/api?x=1&env=uat');
    expect(applyQueryOverrides('https://a.com/api?env=dev', { env: 'uat' })).toBe('https://a.com/api?env=uat');
  });

  it('空覆盖或非法 URL 时原样返回', () => {
    expect(applyQueryOverrides('https://a.com/api', {})).toBe('https://a.com/api');
    expect(applyQueryOverrides('https://a.com/api', undefined)).toBe('https://a.com/api');
    expect(applyQueryOverrides('not-a-url', { env: 'uat' })).toBe('not-a-url');
  });
});
