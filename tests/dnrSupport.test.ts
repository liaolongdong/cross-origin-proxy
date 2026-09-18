/**
 * DNR 可应用性诊断：界面上「已启用」不等于「浏览器会应用」
 *
 * `dnrManager` 同步前会跳过 RE2 不兼容的正则与捕获引用越界的替换串。被跳过的规则如果
 * 本应走 DNR 通道（`isSimpleRule` 为真），拦截器也不会接管它（只收 `!isSimpleRule`），
 * 于是它在列表里是一条启用却零作用的规则。`utils/dnrSupport.ts` 把同一个判定搬到可读侧，
 * 供规则列表徽章、URL 测试弹窗与保存提示复用。
 *
 * 关键约束：诊断必须与引擎的实际行为同口径——所以后台也改为调用同一函数（末尾有源码契约守卫）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ProxyRule } from '@/utils/types';

const isRegexSupported = vi.fn();

vi.stubGlobal('chrome', {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { getURL: vi.fn(() => 'chrome-extension://test/') },
  declarativeNetRequest: { isRegexSupported },
});

const { usesDnrChannel, checkDnrRule, findDnrSkippedRules } = await import('@/utils/dnrSupport');

function makeRule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchType: 'wildcard',
    matchPattern: 'https://fat-api.example.com/*',
    targetUrl: 'https://uat-api.example.com',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  isRegexSupported.mockReset();
  isRegexSupported.mockResolvedValue({ isSupported: true });
});

describe('usesDnrChannel：只有真正进 DNR 的规则才参与诊断', () => {
  it('启用 + 纯 URL 重写 → 走 DNR 通道', () => {
    expect(usesDnrChannel(makeRule())).toBe(true);
  });

  it('停用规则不参与（引擎本来就不会编译它）', () => {
    expect(usesDnrChannel(makeRule({ enabled: false }))).toBe(false);
  });

  const complexCases: [string, Partial<ProxyRule>][] = [
    ['请求头覆盖', { headerOverrides: { 'x-a': 'b' } }],
    ['Mock 响应', { mockResponse: { status: 200, body: '{}' } }],
    ['延迟', { delayMs: 100 }],
    ['拦截', { blocked: true }],
    ['重试', { retryCount: 2 }],
    ['方法过滤', { methods: ['GET'] }],
    ['查询参数覆盖', { queryOverrides: { tenant: 'uat' } }],
    ['空目标（不改写）', { targetUrl: '' }],
  ];
  for (const [label, overrides] of complexCases) {
    it(`${label} → 复杂规则走 SW 通道，不得被告警`, () => {
      expect(usesDnrChannel(makeRule(overrides))).toBe(false);
    });
  }
});

describe('checkDnrRule：与后台同步阶段同一判定', () => {
  it('复杂规则即使正则是 RE2 语法（JS 环视）也返回 null——它由 SW 通道执行，是有效的', async () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: 'https://fat/(?<seg>a)(?=b)',
      delayMs: 50,
    });
    expect(await checkDnrRule(rule)).toBeNull();
    expect(isRegexSupported).not.toHaveBeenCalled();
  });

  it('简单 regex 规则被 RE2 拒绝 → regexUnsupported', async () => {
    isRegexSupported.mockResolvedValue({ isSupported: false });
    const rule = makeRule({ matchType: 'regex', matchPattern: 'https://fat/(a)(?=b)' });
    expect(await checkDnrRule(rule)).toBe('regexUnsupported');
  });

  it('chrome API 抛错按「不支持」处理：后台同一条规则同样会被跳过，漏报比误报更糟', async () => {
    isRegexSupported.mockRejectedValue(new Error('bad argument'));
    const rule = makeRule({ matchType: 'regex', matchPattern: 'https://fat/(.*)' });
    expect(await checkDnrRule(rule)).toBe('regexUnsupported');
  });

  it('RE2 支持但替换串引用越界的 regex 规则 → substitutionInvalid', async () => {
    const rule = makeRule({ matchType: 'regex', matchPattern: '^https://fat/(.*)$', targetUrl: 'https://uat$2' });
    expect(await checkDnrRule(rule)).toBe('substitutionInvalid');
  });

  it('先判 RE2 再判替换串（与后台跳过顺序一致）', async () => {
    isRegexSupported.mockResolvedValue({ isSupported: false });
    const rule = makeRule({ matchType: 'regex', matchPattern: '^(a)(?=b)$', targetUrl: 'https://uat$9' });
    expect(await checkDnrRule(rule)).toBe('regexUnsupported');
  });

  it('wildcard / prefix 不查 RE2：regexFilter 由本扩展生成，语法可控', async () => {
    await checkDnrRule(makeRule({ matchType: 'wildcard' }));
    await checkDnrRule(makeRule({ matchType: 'prefix', matchPattern: 'https://fat-api.example.com' }));
    expect(isRegexSupported).not.toHaveBeenCalled();
  });

  it('正常可应用的简单规则返回 null', async () => {
    expect(await checkDnrRule(makeRule())).toBeNull();
    expect(
      await checkDnrRule(
        makeRule({ matchType: 'regex', matchPattern: '^https://fat/(.*)$', targetUrl: 'https://uat' }),
      ),
    ).toBeNull();
  });
});

describe('findDnrSkippedRules：只收录会被跳过的规则', () => {
  it('混合规则集：仅命中项入表，键为规则 id', async () => {
    isRegexSupported.mockImplementation(async ({ regex }: { regex: string }) => ({
      isSupported: !regex.includes('?='),
    }));
    const bad = makeRule({ id: 'bad', matchType: 'regex', matchPattern: 'https://fat/(a)(?=b)' });
    const complex = makeRule({
      id: 'complex',
      matchType: 'regex',
      matchPattern: 'https://fat/(a)(?=b)',
      blocked: true,
    });
    const good = makeRule({ id: 'good' });

    const skipped = await findDnrSkippedRules([bad, complex, good]);

    expect([...skipped.keys()]).toEqual(['bad']);
    expect(skipped.get('bad')).toBe('regexUnsupported');
  });

  it('空规则集得到空表', async () => {
    expect(await findDnrSkippedRules([])).toEqual(new Map());
  });
});

describe('后台与前端共用同一判定（源码契约）', () => {
  const managerSrc = readFileSync('entrypoints/background/dnrManager.ts', 'utf-8');

  it('dnrManager 委托 checkDnrRule，而不是自己再写一遍 RE2 校验', () => {
    expect(managerSrc).toContain("import { checkDnrRule, usesDnrChannel } from '@/utils/dnrSupport'");
    expect(managerSrc).toContain('await checkDnrRule(rule)');
    expect(managerSrc).not.toContain('isRegexSupported');
  });

  it('拦截器仍只收复杂规则：被跳过的简单规则无人接管，正是告警存在的前提', () => {
    expect(managerSrc).toContain('rules.filter(rule => !isSimpleRule(rule))');
  });
});

describe('告警文案与消费点（源码契约）', () => {
  // key 缺失时 t() 会把 key 原样渲染到界面上，比不显示更糟
  const SKIP_KEYS = [
    'dnrSkippedTag',
    'dnrSkippedIntro',
    'dnrSkippedRe2',
    'dnrSkippedSubstitution',
    'dnrSkippedHint',
    'dnrSkippedSummary',
    'dnrSkippedMsg',
  ];

  for (const ns of ['zh_CN', 'en'] as const) {
    it(`${ns} 侧的告警文案齐备`, () => {
      const dict = JSON.parse(readFileSync(`locales/${ns}/options.json`, 'utf-8')) as Record<string, string>;
      for (const key of SKIP_KEYS) {
        expect(dict[key], `${ns}/${key}`).toBeTruthy();
      }
    });
  }

  it('原因到文案 key 的映射只写在一处（composables/useDnrSupport）', () => {
    const composableSrc = readFileSync('composables/useDnrSupport.ts', 'utf-8');
    expect(composableSrc).toContain("t('dnrSkippedRe2')");
    expect(composableSrc).toContain("t('dnrSkippedSubstitution')");
  });

  it('三个消费点各自接上诊断结果', () => {
    const appSrc = readFileSync('components/options/App.vue', 'utf-8');
    const tableSrc = readFileSync('components/options/RuleTable.vue', 'utf-8');
    const testSrc = readFileSync('components/options/UrlTestDialog.vue', 'utf-8');

    // 计数行汇总 + 两个子组件的入参
    expect(appSrc).toContain('useDnrSupport(rules)');
    expect(appSrc).toContain(':dnr-skipped-rules="dnrSkippedRules"');
    expect(appSrc).toContain("t('dnrSkippedSummary'");
    // 保存后复核：命中时不再报「成功」，而是说明为什么不会被应用
    expect(appSrc).toContain('await checkDnrRule(savedRule)');
    expect(appSrc).toContain("t('dnrSkippedMsg'");

    expect(tableSrc).toContain('dnrSkippedRules: Map<string, DnrSkipReason>');
    expect(tableSrc).toContain('dnr-dead-tag');

    expect(testSrc).toContain('dnrSkippedRules: Map<string, DnrSkipReason>');
    expect(testSrc).toContain('matchedDnrSkipReason');
    expect(testSrc).toContain('dnr-skip-alert');
  });

  it('命中 DNR 且规则确实生效时，另有一行 CORS 说明', () => {
    const testSrc = readFileSync('components/options/UrlTestDialog.vue', 'utf-8');
    // 「绿色 DNR」只代表 URL 被改写，响应仍受浏览器 CORS 约束；被跳过的规则已有危险告警，不叠加
    expect(testSrc).toContain("t('urlTestCorsNote')");
    expect(testSrc).toContain('v-else-if="channelIsDnr"');
  });
});

describe('[P3] DNR 配置监听在同步阶段注册', () => {
  const managerSrc = readFileSync('entrypoints/background/dnrManager.ts', 'utf-8');
  const start = managerSrc.indexOf('export function initDnrManager');
  const body = managerSrc.slice(start, managerSrc.indexOf('\n}', start));
  const listenerAt = body.indexOf('chrome.storage.onChanged.addListener');

  it('initDnrManager 在第一个 await 之前就注册监听', () => {
    expect(start).toBeGreaterThan(-1);
    expect(listenerAt).toBeGreaterThan(-1);
    // SW 可能就是被这次 storage.onChanged 唤醒的，await 之后注册的监听收不到它
    expect(body.slice(0, listenerAt)).not.toContain('await');
  });

  it('启动全量同步挪到监听注册之后异步执行', () => {
    expect(body.indexOf('void initialSync()')).toBeGreaterThan(listenerAt);
    expect(body).not.toContain('getProxyConfig');
    expect(managerSrc).toMatch(
      /async function initialSync\(\)[\s\S]*?await getProxyConfig\(\)[\s\S]*?await syncDnrRules\(config\)/,
    );
  });
});
