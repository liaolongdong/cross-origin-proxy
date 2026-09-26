import { describe, it, expect } from 'vitest';
import {
  matchRule,
  rewriteUrl,
  findMatchingRule,
  isSimpleRule,
  isWebSocketRule,
  applyQueryOverrides,
  isRegexSafe,
  isPatternUsable,
  isUrlTooLongForScan,
  MAX_MATCH_URL_LENGTH,
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

  it('白名单里那条写法的大小写不算数：文件里写 post 照样放行 POST', () => {
    // `HTTP_METHODS` 七个值全是大写，界面选不出小写，所以这一格的来路只有导入文件（cURL/HAR/JSON）
    // 与手改 storage——`utils/types.ts` 那句「大小写不敏感」承诺的就是这条来路。
    const lower = makeRule({ id: 'l', matchPattern: 'https://a.com/*', methods: ['post'] });
    expect(matchRule('https://a.com/x', lower, 'POST')).toBe(true);
    expect(matchRule('https://a.com/x', lower, 'post')).toBe(true);
    expect(matchRule('https://a.com/x', lower, 'GET')).toBe(false);
    // 后台代发入口同样按这条来路命中（`findMatchingRule` 是 `proxyHandler` 用的那一个）
    expect(findMatchingRule('https://a.com/x', [lower], 'POST')?.id).toBe('l');
  });

  it('空数组是「不限方法」，不是「一个都不许」', () => {
    // 表单只在 `methodsList.length > 0` 时才写 `methods`，所以 `[]` 也是文件／手改那条来路。
    // 它必须与「字段不存在」同义：否则同一份 storage 里的一条规则，方法过滤在两条通道上一个放行、
    // 一个谁都别想过去——而分流判据那边已经把 `methods: []` 当作「不限方法」（见 `isSimpleRule` 那组用例）。
    const empty = makeRule({ id: 'e', matchPattern: 'https://a.com/*', methods: [] });
    expect(matchRule('https://a.com/x', empty, 'GET')).toBe(true);
    expect(matchRule('https://a.com/x', empty, 'DELETE')).toBe(true);
    expect(findMatchingRule('https://a.com/x', [empty], 'GET')?.id).toBe('e');
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

/**
 * M-1（2026-09-26 评审轮）：ReDoS 的两道闸
 *
 * 第一道管形状。旧清单只有「量词套量词」三条，而 `[^)]*` 跨不过交替组里的那个 `|`，
 * 于是 `(a|aa)+$` 被放行——它的回溯树比 `(a+)+` 更宽（n=32 实测过百毫秒，随长度指数增长）。
 * 可达链是「导入文件里的一条模式 + 一笔页面可控的长 URL」，代价是单线程 SW 冻秒级。
 * 第二道管输入规模：用户正则的形状不由我们决定，超限主题上的平方级回溯同样足以冻结 SW，
 * 所以超限的 URL 在 wildcard/regex 两条通道上按「不匹配」处理（与非法模式同档降级）。
 */
describe('isRegexSafe — 量词化的交替组与相邻量词串', () => {
  const dangerous = [
    '(a+)+', // 旧清单就有
    '(a*)*b',
    'a++b',
    '(a+){2}',
    '(a|aa)+$', // 新增：组内含 | 时旧判据看不见
    '(a|ab){2,}',
    '(a|a?)+x',
    '.*.*x', // 新增：相邻量词串
    '^(https?|)://.*.*$',
  ];
  // 常规写法一律不许误伤——误伤的代价是用户去改一个根本没坏的模式
  const benign = ['(a|b)$', '(a|aa)x', '/users/\\d+', '^(?:https?|ws)s?://', '^https://a\\.com/.*\\.js$'];

  it.each(dangerous)('点名危险形状：%s', pattern => {
    expect(isRegexSafe(pattern)).toBe(false);
  });

  it.each(benign)('放行常规写法：%s', pattern => {
    expect(isRegexSafe(pattern)).toBe(true);
  });

  it('匹配与「模式可用性」同口径：不会出现拦下它却说它没坏', () => {
    const rule = makeRule({ matchType: 'regex', matchPattern: '(a|aa)+$' });
    expect(isPatternUsable(rule)).toBe(false);
    expect(matchRule(`https://a.com/${'a'.repeat(30)}`, rule)).toBe(false);
  });
});

describe('超限 URL 不进 wildcard/regex 扫描', () => {
  const tail = 'a'.repeat(MAX_MATCH_URL_LENGTH);
  const over = `https://a.com/${tail}`;

  it('判据是「超过」而不是「达到」', () => {
    expect(isUrlTooLongForScan('x'.repeat(MAX_MATCH_URL_LENGTH))).toBe(false);
    expect(isUrlTooLongForScan('x'.repeat(MAX_MATCH_URL_LENGTH + 1))).toBe(true);
  });

  it('wildcard 与 regex 判不匹配，重写原样返回，findMatchingRule 因此选不出规则', () => {
    const wildcard = makeRule({ matchPattern: 'https://a.com/*', targetUrl: 'https://b.com/' });
    const regex = makeRule({
      matchType: 'regex',
      matchPattern: '^https://a\\.com/.*$',
      targetUrl: 'https://b.com/',
    });
    expect(matchRule(over, wildcard)).toBe(false);
    expect(matchRule(over, regex)).toBe(false);
    expect(findMatchingRule(over, [wildcard, regex])).toBeNull();
    expect(rewriteUrl(over, wildcard)).toBe(over);
    expect(rewriteUrl(over, regex)).toBe(over);
  });

  it('prefix 不受此限：startsWith 线性，而页面上传的长 data: 地址命中的正是前缀规则', () => {
    const prefix = makeRule({
      matchType: 'prefix',
      matchPattern: 'https://a.com/',
      targetUrl: 'https://b.com/',
    });
    expect(matchRule(over, prefix)).toBe(true);
    expect(rewriteUrl(over, prefix)).toBe(`https://b.com/${tail}`);
  });

  it('空目标本就跳过所有扫描，超限与否同一条答案', () => {
    const noTarget = makeRule({ matchPattern: 'https://a.com/*' });
    expect(rewriteUrl(over, noTarget)).toBe(over);
    expect(rewriteUrl('https://a.com/x', noTarget)).toBe('https://a.com/x');
  });
});
