/**
 * 正则规则的两通道重写差异：按「输入 → 答案」逐个核
 *
 * 判据承重的是**算出来的两个地址**，不是「它像不像一条正则规则」。所以每条用例都写明
 * 网络层会得到什么、后台通道会得到什么、以及为什么这一格该说话 / 该闭嘴。
 * 覆盖不全的正则（用例 1）是本功能存在的唯一理由：两条通道各给出一个地址、都不报错，
 * 用户看到的是「同一个请求两次结果不一样」，而这种症状最难查。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ProxyRule } from '@/utils/types';
import { rewriteUrl } from '@/utils/urlMatcher';
import { substitutionRefs } from '@/utils/dnrRules';
import { findRegexRewriteDivergence, renderRegexSubstitution } from '@/utils/channelDivergence';

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

const FAT = 'https://fat.example.com/api/user/1';
const UAT = 'https://uat.example.com/api/$1';

describe('findRegexRewriteDivergence — 只在两条通道真的给出不同地址时说话', () => {
  it('覆盖不全的正则：后台通道把原主机名夹在中间，网络层给的是干净替换', () => {
    const rule = makeRule({ matchType: 'regex', matchPattern: '/api/(.*)', targetUrl: UAT });
    expect(findRegexRewriteDivergence(FAT, rule)).toEqual({
      networkUrl: 'https://uat.example.com/api/user/1',
      extensionUrl: 'https://fat.example.comhttps://uat.example.com/api/user/1',
    });
  });

  it('整条锚定的正则：两通道同解，这一格必须闭嘴', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: '^https://fat\\.example\\.com/api/(.*)$',
      targetUrl: UAT,
    });
    expect(findRegexRewriteDivergence(FAT, rule)).toBeNull();
  });

  it('模式匹配但不带捕获、目标也不引用捕获组：两边都是同一个固定地址', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: '/api/',
      targetUrl: 'https://uat.example.com/v2/',
    });
    expect(findRegexRewriteDivergence(FAT, rule)).toEqual({
      networkUrl: 'https://uat.example.com/v2/',
      extensionUrl: 'https://fat.example.comhttps://uat.example.com/v2/user/1',
    });
  });

  it('复杂规则（带请求头覆盖）只走后台，压根没有第二条通道 → 不判', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: '/api/(.*)',
      targetUrl: UAT,
      headerOverrides: { 'X-A': 'b' },
    });
    expect(rule.headerOverrides).toBeDefined();
    expect(findRegexRewriteDivergence(FAT, rule)).toBeNull();
  });

  it('通配符与前缀不判：wildcard 末尾捕获为空时差一个分隔斜杠是另一条已接受的差异', () => {
    const wildcard = makeRule({ matchType: 'wildcard', matchPattern: 'https://a.com/*', targetUrl: 'https://b.com' });
    const prefix = makeRule({ matchType: 'prefix', matchPattern: 'https://a.com/', targetUrl: 'https://b.com/' });
    expect(findRegexRewriteDivergence('https://a.com/', wildcard)).toBeNull();
    expect(findRegexRewriteDivergence('https://a.com/x', prefix)).toBeNull();
  });

  it('没匹配上 / 目标为空 / URL 为空 / 正则非法，四种都返回 null 且不抛', () => {
    const base = { matchType: 'regex' as const, matchPattern: '/api/(.*)', targetUrl: UAT };
    expect(findRegexRewriteDivergence('https://other.com/x', makeRule(base))).toBeNull();
    expect(findRegexRewriteDivergence(FAT, makeRule({ ...base, targetUrl: '' }))).toBeNull();
    expect(findRegexRewriteDivergence('', makeRule(base))).toBeNull();
    expect(findRegexRewriteDivergence(FAT, makeRule({ ...base, matchPattern: '/api/(' }))).toBeNull();
  });

  it('长到不参与扫描的 URL 不判——那时后台通道原样返回，报出来的差异是编的', () => {
    const rule = makeRule({ matchType: 'regex', matchPattern: '/api/(.*)', targetUrl: UAT });
    const long = `https://fat.example.com/api/${'x'.repeat(8200)}`;
    expect(long.length).toBeGreaterThan(8192);
    expect(rewriteUrl(long, rule)).toBe(long); // 现网公式确实原样返回，这条判据才有意义
    expect(findRegexRewriteDivergence(long, rule)).toBeNull();
  });

  it('禁用的规则不判——分流与同步都轮不到它', () => {
    const rule = makeRule({ matchType: 'regex', matchPattern: '/api/(.*)', targetUrl: UAT, enabled: false });
    expect(findRegexRewriteDivergence(FAT, rule)).toBeNull();
  });
});

describe('判据只有一个出口 — 界面不许自己再算一遍', () => {
  it('URL 匹配测试读的是 findRegexRewriteDivergence，且在「浏览器不会应用这条规则」时不说话', () => {
    const src = readFileSync('components/options/UrlTestDialog.vue', 'utf8');
    expect(src).toContain("import { findRegexRewriteDivergence } from '@/utils/channelDivergence'");
    const block = src.slice(src.indexOf('const divergence = computed('));
    expect(block.slice(0, 600)).toContain('matchedDnrSkipReason.value');
    // 判定还没落到过一次同样不说话：那时「不会被应用」与「还不知道」在 Map 里长成同一个空集
    expect(block.slice(0, 600)).toContain('dnrSupportRead');
    // 第二份实现就长这样：界面里直接对规则跑 replace / 自己拼替换模板
    expect(src).not.toContain('.replace(new RegExp(');
    expect(src).not.toContain('buildRegexSubstitution');
  });
});

/**
 * 引用扫描全仓只有一把尺（`dnrRules.ts` 的 `substitutionSegments`）。
 * 这里按「同一个模板 → 守卫看到的引用」与「同一个模板 → 渲染出的地址」成对钉：
 * 两处一旦分家，预演就报出一个与浏览器不同的地址，而这件事没有任何界面症状。
 */
describe('渲染与越界守卫读同一批引用', () => {
  it('channelDivergence 自己不数反斜杠了', () => {
    const src = readFileSync('utils/channelDivergence.ts', 'utf8');
    expect(src).toContain('substitutionSegments');
    // 第二把尺长这样：自己往后扫数字
    expect(src).not.toMatch(/while\s*\([^)]*template\[j\]\s*>=/);
    expect(src).not.toMatch(/while\s*\([^)]*digits \+=/);
  });

  it.each([
    ['https://b.com/\\1', [1], 'https://b.com/A'],
    ['\\2-x/\\1', [2, 1], 'B-x/A'],
    ['a\\\\12', [], 'a\\12'],
    ['p\\12q', [12], 'pq'],
    ['tail\\', [], 'tail'],
  ])('%s：守卫的引用清单与渲染的取值出自同一批', (template, refs, rendered) => {
    const groups = ['', 'A', 'B', 'C'];
    expect(substitutionRefs(template)).toEqual(refs);
    expect(renderRegexSubstitution(template, groups)).toBe(rendered);
  });
});

describe('renderRegexSubstitution — 与 dnrRules 的引用扫描同一份口径', () => {
  it('\\1 引用捕获组，字面量段原样保留', () => {
    expect(renderRegexSubstitution('https://b.com/\\1', ['', 'user/1'])).toBe('https://b.com/user/1');
  });

  it('双反斜杠是字面量反斜杠，其后数字不构成引用', () => {
    expect(renderRegexSubstitution('a\\\\12', ['', 'X', 'Y', 'Z'])).toBe('a\\12');
  });

  it('多位引用按整段读取（这种规则本会在同步前被越界守卫拦掉，这里只保证两处读法一致）', () => {
    expect(renderRegexSubstitution('p\\12q', ['', 'X', 'Y'])).toBe('pq');
  });

  it('缺组替换为空串，结尾孤立的反斜杠丢弃', () => {
    expect(renderRegexSubstitution('\\3', ['', 'a'])).toBe('');
    expect(renderRegexSubstitution('tail\\', ['', 'a'])).toBe('tail');
  });
});
