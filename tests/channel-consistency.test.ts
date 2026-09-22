/**
 * 双通道等价性与审计修复回归测试
 *
 * 项目的硬约定（见 AGENTS.md「双通道分流」）：`isSimpleRule()` 判为简单的规则，
 * DNR 网络层与 SW 拦截层必须给出**同一命中集合**与**同一重写结果**。
 * 本文件先用 regexFilter + regexSubstitution 在 JS 里复算 DNR 的改写，再与
 * `rewriteUrl` 逐项比对——prefix 丢分隔斜杠、前缀模式里的 `*` 被 RE2 当量词
 * 这两类缺陷正是靠这层等价关系才暴露得出来。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  rewriteUrl,
  matchRule,
  findMatchingRule,
  isSimpleRule,
  applyQueryOverrides,
  normalizePriority,
  invalidateMatcherCache,
} from '@/utils/urlMatcher';
import { buildRegexFilter, buildRegexSubstitution, buildDnrRules, toDnrPriority } from '@/utils/dnrRules';
import { DEFAULT_RULE_PRIORITY } from '@/utils/constants';
import type { ProxyRule } from '@/utils/types';

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: 'https://fat-api.example.com/*',
    targetUrl: 'https://uat-api.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/**
 * 用 JS 复现 Chrome 对 `regexFilter` + `regexSubstitution` 的求值，
 * 免去真实浏览器即可与 SW 通道直接比对。
 * @returns 重定向后的 URL；未命中返回 null（该请求不会被 DNR 改写）
 */
function applyDnrRedirect(rule: ProxyRule, url: string): string | null {
  const matched = new RegExp(buildRegexFilter(rule)).exec(url);
  if (!matched) return null;
  return buildRegexSubstitution(rule).replace(/\\(\d)/g, (_match, digit: string) => matched[Number(digit)] ?? '');
}

/** 断言一条简单规则在两条通道上的命中判定与重写结果完全等价 */
function expectChannelsEquivalent(rule: ProxyRule, urls: string[]): void {
  expect(isSimpleRule(rule), '前置条件被破坏：该规则不该走 DNR 通道').toBe(true);
  for (const url of urls) {
    const dnrResult = applyDnrRedirect(rule, url);
    if (dnrResult === null) {
      expect(matchRule(url, rule), `DNR 未命中但 SW 判为命中：${url}`).toBe(false);
      expect(rewriteUrl(url, rule), `DNR 未命中但 SW 改写了：${url}`).toBe(url);
    } else {
      expect(matchRule(url, rule), `SW 未命中但 DNR 命中：${url}`).toBe(true);
      expect(rewriteUrl(url, rule), `两通道重写结果不一致：${url}`).toBe(dnrResult);
    }
  }
}

describe('双通道等价（prefix 分隔斜杠 / 前缀模式中的 *）', () => {
  it('prefix 模式与目标各带尾斜杠时不再拼出坏 URL（回归 v2users）', () => {
    const rule = makeRule({
      matchType: 'prefix',
      matchPattern: 'https://fat.com/api/',
      targetUrl: 'https://uat.com/v2/',
    });
    expect(rewriteUrl('https://fat.com/api/users', rule)).toBe('https://uat.com/v2/users');
    expectChannelsEquivalent(rule, ['https://fat.com/api/users', 'https://fat.com/api/', 'https://other.com/x']);
  });

  it('prefix 模式不以 / 结尾时保持原样拼接（未被修复波及）', () => {
    const rule = makeRule({
      matchType: 'prefix',
      matchPattern: 'https://fat.com/api',
      targetUrl: 'https://uat.com/v2',
    });
    expect(rewriteUrl('https://fat.com/api/users', rule)).toBe('https://uat.com/v2/users');
    expectChannelsEquivalent(rule, ['https://fat.com/api/users', 'https://fat.com/api']);
  });

  it('前缀模式里的 * 按字面量处理，两通道命中集合一致（回归 aaab 误命中）', () => {
    const rule = makeRule({
      matchType: 'prefix',
      matchPattern: 'https://fat.com/a*b',
      targetUrl: 'https://uat.com',
    });
    // SW 侧 startsWith 为字面量语义：aaab 不该命中，a*b/... 才该命中
    expect(rewriteUrl('https://fat.com/aaab', rule)).toBe('https://fat.com/aaab');
    expectChannelsEquivalent(rule, ['https://fat.com/aaab', 'https://fat.com/a*b/x', 'https://fat.com/a*b']);
  });

  it('wildcard 尾部为空时两通道差一个根斜杠（已知差异，非缺陷）', () => {
    const rule = makeRule({ matchPattern: 'https://fat.com/*', targetUrl: 'https://uat.com' });
    // DNR 的 regexSubstitution 是静态模板，无法按捕获是否为空分支，因此必然带尾斜杠；
    // SW 刻意省略它。`https://uat.com` 与 `https://uat.com/` 指向同一资源（RFC 3986
    // 空路径归一化为 /），且既有测试明确守护 SW 的简洁输出，故不做对齐。
    expect(rewriteUrl('https://fat.com/', rule)).toBe('https://uat.com');
    expect(applyDnrRedirect(rule, 'https://fat.com/')).toBe('https://uat.com/');
    // 捕获非空时两通道仍然一致
    expectChannelsEquivalent(rule, ['https://fat.com/api/users']);
  });
});

describe('优先级归一化（回归：NaN 让整批 updateDynamicRules 被拒）', () => {
  it('缺失/非有限的 priority 回落为默认值而非 NaN', () => {
    const badValues: unknown[] = [undefined, null, NaN, Infinity, -Infinity, 'abc'];
    for (const value of badValues) {
      expect(toDnrPriority(value as number), `priority=${String(value)}`).toBe(1000 - DEFAULT_RULE_PRIORITY);
    }
  });

  it('normalizePriority 不动合法值', () => {
    expect(normalizePriority(1)).toBe(1);
    expect(normalizePriority(9999)).toBe(9999);
    expect(normalizePriority(0)).toBe(0);
  });

  it('一条坏 priority 的规则不再连带打掉同批其它简单规则', () => {
    const broken = makeRule({ id: 'broken', priority: undefined as unknown as number });
    const good = makeRule({ id: 'good', priority: 5 });
    const { rules } = buildDnrRules([broken, good], true);

    expect(rules).toHaveLength(2);
    const priorities = rules.map(dnr => dnr.priority);
    expect(priorities).toContain(1000 - DEFAULT_RULE_PRIORITY);
    expect(priorities).toContain(995);
  });

  it('priority 缺失时排序结果确定：显式高优先者胜出，仅与默认值比较时按默认值定位', () => {
    // findMatchingRule 按 id+updatedAt 缓存排序结果，此处规则集不同但指纹相同，需显式失效
    invalidateMatcherCache();

    const shared = { matchPattern: 'https://shared.test/*', targetUrl: 'https://uat.test', updatedAt: 1 };
    const high = makeRule({ ...shared, id: 'high', priority: 1 });
    const unset = makeRule({ ...shared, id: 'unset', priority: undefined as unknown as number });
    const low = makeRule({ ...shared, id: 'low', priority: 900 });

    expect(findMatchingRule('https://shared.test/p', [low, unset, high])?.id).toBe('high');
    expect(findMatchingRule('https://shared.test/p', [low, unset])?.id).toBe('unset');
    expect(findMatchingRule('https://shared.test/p', [unset, high])?.id).toBe('high');
  });
});

describe('applyQueryOverrides（回归：不再重编码未触碰的参数）', () => {
  // 基础追加/覆盖与「空覆盖、非法 URL 原样返回」已由 tests/urlMatcher.test.ts 覆盖，此处不重复
  it('保留其余参数的原始编码，签名/回调地址不被打断', () => {
    // 修复前实测：redirect 的值被重新编码为 https%3A%2F%2Fy.com%3Fa%3D1
    expect(applyQueryOverrides('https://uat.com/x?redirect=https://y.com?a=1', { s: '1' })).toBe(
      'https://uat.com/x?redirect=https://y.com?a=1&s=1',
    );
    // 特征固化而非回归：`/` 本就在 form-urlencoded 的编码集内，修复前后都是 %2F
    expect(applyQueryOverrides('https://uat.com/x?sign=a%2Fb&ts=1', { env: 'uat' })).toBe(
      'https://uat.com/x?sign=a%2Fb&ts=1&env=uat',
    );
  });

  it('空格按 %20 注入而非表单编码的 +', () => {
    // 修复前实测得到 q=a+b——与依赖原文比对的签名/回调地址不兼容
    expect(applyQueryOverrides('https://a.com/x', { q: 'a b' })).toBe('https://a.com/x?q=a%20b');
    expect(applyQueryOverrides('https://a.com/x?q=a%20b', { env: 'uat' })).toBe('https://a.com/x?q=a%20b&env=uat');
  });

  it('同名重复项合并为一条', () => {
    expect(applyQueryOverrides('https://a.com/x?env=dev&env=old&keep=1', { env: 'uat' })).toBe(
      'https://a.com/x?env=uat&keep=1',
    );
  });

  it('hash 段保留在末尾，不被查询参数吞掉', () => {
    expect(applyQueryOverrides('https://a.com/x?y=1#/route', { env: 'uat' })).toBe(
      'https://a.com/x?y=1&env=uat#/route',
    );
  });
});

describe('setByPath 拒绝原型链键名（来自不可信导入配置）', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn() },
      },
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function importSetByPath() {
    const { setByPath } = await import('@/entrypoints/background/proxyHandler');
    return setByPath;
  }

  it('普通点分隔路径正常写入', async () => {
    const setByPath = await importSetByPath();
    const obj: Record<string, unknown> = { data: { token: 'old' } };
    expect(setByPath(obj, 'data.token', 'new')).toBe(true);
    expect(obj.data).toEqual({ token: 'new' });
  });

  it('缺失的中间层级会被创建', async () => {
    const setByPath = await importSetByPath();
    const obj: Record<string, unknown> = {};
    expect(setByPath(obj, 'a.b.c', 1)).toBe(true);
    expect(obj.a).toEqual({ b: { c: 1 } });
  });

  it('__proto__ / constructor / prototype 路径被拒绝且不改动对象', async () => {
    const setByPath = await importSetByPath();
    const paths = ['__proto__.polluted', 'constructor.prototype.polluted', 'prototype.x', 'a.__proto__.b'];
    for (const path of paths) {
      const obj: Record<string, unknown> = { keep: 1 };
      expect(setByPath(obj, path, true), path).toBe(false);
      expect(Object.keys(obj), path).toEqual(['keep']);
    }
    // 兜底：Object.prototype 确实未被污染（污染会波及每一次对象读取）
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/**
 * MAIN world 拦截器自包含、无法 import 共享模块，本轮修复的三类缺陷在它自己的
 * WebSocket / 排序镜像里同样存在。这里按源码契约固定，防止再次漂移。
 */
describe('MAIN world 镜像与 utils 侧同源', () => {
  const source = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');

  it('页面侧规则排序同样走 NaN 安全的优先级归一化', () => {
    expect(source).toMatch(/\.sort\(\(a, b\) => normalizePriority\(a\.priority\) - normalizePriority\(b\.priority\)\)/);
    expect(source).not.toMatch(/\.sort\(\(a, b\) => a\.priority - b\.priority\)/);
  });

  it('镜像里的默认优先级字面量与共享常量同值', () => {
    const mirrored = source.match(/const DEFAULT_RULE_PRIORITY = (\d+);/);
    expect(mirrored, '拦截器缺少 DEFAULT_RULE_PRIORITY 镜像').not.toBeNull();
    expect(Number(mirrored?.[1])).toBe(DEFAULT_RULE_PRIORITY);
  });

  it('WS prefix 重写补回被模式消耗的分隔符', () => {
    expect(source).toMatch(
      /const separator = rule\.matchPattern\.endsWith\('\/'\) \? '\/' : '';\s*\n\s*return applyWsQuery\(toWsUrl\(target \+ separator \+ rest\)/,
    );
  });

  it('WS 查询参数注入不再整体重编码 query', () => {
    expect(source).not.toMatch(/\.searchParams\.set\(/);
    expect(source).not.toMatch(/parsed\.toString\(\)/);
    // 定点改写：从原始串的 `?` 之后切片，而不是走 URL 的序列化器
    expect(source).toMatch(/function applyWsQuery[\s\S]*?beforeHash\s*\.slice\(\s*queryAt\s*\+\s*1\s*\)/);
  });
});

/**
 * 内容脚本的**注入范围**也是双通道一致性的一部分：MAIN world 拦截器与 ISOLATED world 桥接
 * 必须出现在同一批 document 里。只给桥接加 `allFrames`，iframe 的 `postMessage` 无人接；
 * 只给拦截器加，iframe 的消息出不了页面——两种半份注入都比「iframe 不生效」更难排查，
 * 因为桥接层会在自己的 world 里正常收发消息，只是对端不存在。
 */
describe('内容脚本注入范围成对声明', () => {
  const bridgeSrc = readFileSync('entrypoints/content.ts', 'utf-8');
  const interceptorSrc = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');

  /** 取出 `defineContentScript({ … })` 的声明块 */
  function declarationOf(source: string): string {
    const at = source.indexOf('defineContentScript({');
    expect(at, '入口缺少 defineContentScript 声明').toBeGreaterThan(-1);
    return source.slice(at, source.indexOf('main(', at));
  }

  it('两个 world 都注入全部 frame（缺一即半份注入）', () => {
    expect(declarationOf(bridgeSrc)).toMatch(/allFrames:\s*true/);
    expect(declarationOf(interceptorSrc)).toMatch(/allFrames:\s*true/);
  });

  it('matches 与 runAt 同样成对，避免时序或范围上的一方独占', () => {
    const bridge = declarationOf(bridgeSrc);
    const interceptor = declarationOf(interceptorSrc);
    expect(bridge).toMatch(/matches:\s*\['<all_urls>'\]/);
    expect(interceptor).toMatch(/matches:\s*\['<all_urls>'\]/);
    expect(bridge).toMatch(/runAt:\s*'document_start'/);
    expect(interceptor).toMatch(/runAt:\s*'document_start'/);
  });
});

/**
 * 下发给页面的配置读自 `storage.local`，那里的 `rules` 可能是手改出来的对象或字符串。
 * 两个 world 都拿不到 `utils/storage` 的 `configRules()`（MAIN world 自包含；桥接层一旦引入存储
 * 门面，就在每个 frame 注册一个它用不到的 `chrome.storage.onChanged` 监听），所以这道判据只能
 * 各自成立。只补一边就是半边同步照旧抛：桥接层抛在 `postSyncRules` 里、拦截器抛在
 * `rebuildRuleCache` 的 `[...rules]` 上，两处都没有 catch，症状同为「这一页的复杂规则静默走原生请求」。
 */
describe('页面侧规则数组的形状判据成对声明', () => {
  const bridgeSrc = readFileSync('entrypoints/content.ts', 'utf-8');
  const interceptorSrc = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');

  it('桥接层按数组取值，`?? []` 挡不住非数组对象', () => {
    expect(bridgeSrc).toMatch(/Array\.isArray\(\s*config\.rules\s*\)/);
    expect(bridgeSrc).not.toMatch(/config\.rules\s*\?\?\s*\[\]/);
  });

  it('拦截器喂给 rebuildRuleCache 的值经过同一道数组判据', () => {
    expect(interceptorSrc).toMatch(/rebuildRuleCache\(\s*Array\.isArray\(\s*config\.rules\s*\)/);
    expect(interceptorSrc).not.toMatch(/rebuildRuleCache\(\s*config\.rules\s*\|\|/);
  });
});
