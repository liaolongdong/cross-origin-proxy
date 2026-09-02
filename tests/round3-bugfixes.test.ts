import { describe, it, expect } from 'vitest';
import { isSimpleRule } from '@/utils/urlMatcher';
import {
  buildRegexFilter,
  buildRegexSubstitution,
  buildDnrRules,
  countCaptureGroups,
  maxSubstitutionRef,
  isSubstitutionValid,
} from '@/utils/dnrRules';
import { logsToHar } from '@/utils/har';
import type { ProxyRule, RequestLogEntry, HarEntry } from '@/utils/types';

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: 'https://a.com/*',
    targetUrl: 'https://b.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('B1: 空目标规则不得进入 DNR 通道', () => {
  it('isSimpleRule 对空目标一律返回 false', () => {
    expect(isSimpleRule(makeRule({ targetUrl: '' }))).toBe(false);
    expect(isSimpleRule(makeRule({ targetUrl: '', matchType: 'prefix', matchPattern: 'https://a.com' }))).toBe(false);
    expect(isSimpleRule(makeRule({ targetUrl: '', matchType: 'regex', matchPattern: '^https://a\\.com/' }))).toBe(false);
  });

  it('正常目标仍是简单规则（不误伤）', () => {
    expect(isSimpleRule(makeRule({}))).toBe(true);
  });

  it('buildDnrRules 不再为空目标规则生成非法重定向', () => {
    const { rules } = buildDnrRules([makeRule({ targetUrl: '' }), makeRule({ id: 'r2', name: 'ok' })]);
    expect(rules).toHaveLength(1);
    // 生成的唯一规则来自有效目标，替换串为绝对地址
    expect(rules[0].action.redirect?.regexSubstitution).toContain('https://b.com');
  });
});

describe('B2: DNR 替换引用越界校验', () => {
  it('countCaptureGroups 区分捕获/非捕获/命名/转义', () => {
    expect(countCaptureGroups('^https://a\\.com/(.*)$')).toBe(1);
    expect(countCaptureGroups('(a)(b)(c)')).toBe(3);
    expect(countCaptureGroups('(?:abc)(?=x)(?!y)(?<=z)(?<!w)')).toBe(0);
    expect(countCaptureGroups('(?<name>x)')).toBe(1);
    expect(countCaptureGroups('\\((\\d+)\\)')).toBe(1);
  });

  it('maxSubstitutionRef 正确处理转义', () => {
    expect(maxSubstitutionRef('https://b.com/\\1')).toBe(1);
    expect(maxSubstitutionRef('https://b.com/\\2/\\1')).toBe(2);
    expect(maxSubstitutionRef('https://b.com/')).toBe(-1);
    // \\ 是字面量反斜杠，其后的 1 不是引用
    expect(maxSubstitutionRef('https://b.com/\\\\1')).toBe(-1);
  });

  it('isSubstitutionValid 检出越界引用', () => {
    expect(isSubstitutionValid('(abc)', 'x\\1')).toBe(true);
    expect(isSubstitutionValid('(abc)', 'x\\2')).toBe(false);
    expect(isSubstitutionValid('abc', 'x\\1')).toBe(false);
    expect(isSubstitutionValid('abc', 'plain')).toBe(true);
  });

  it('regex 规则目标含 $1 但模式无捕获组 → 校验失败', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: '^https://a\\.com/.*',
      targetUrl: 'https://b.com/$1',
    });
    const filter = buildRegexFilter(rule);
    const substitution = buildRegexSubstitution(rule);
    expect(isSubstitutionValid(filter, substitution)).toBe(false);
  });

  it('regex 规则带捕获组时校验通过', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: '^https://a\\.com/(.*)',
      targetUrl: 'https://b.com/$1',
    });
    expect(isSubstitutionValid(buildRegexFilter(rule), buildRegexSubstitution(rule))).toBe(true);
  });
});

describe('B6: 代理超时上限公式', () => {
  // 与 entrypoints/main-interceptor.content.ts 的 computeProxyTimeout 保持一致
  // （MAIN world 脚本自包含无法导入，此处复制公式以固化契约）
  function computeProxyTimeout(rule: Partial<ProxyRule>): number {
    const retries = rule.retryCount ?? 0;
    return (rule.delayMs || 0) + 30000 * (retries + 1) + (rule.retryDelay ?? 1000) * retries + 5000;
  }

  it('无延迟无重试：单尝试 30s + 5s 桥接余量', () => {
    expect(computeProxyTimeout({})).toBe(35000);
  });

  it('延迟计入超时上限', () => {
    expect(computeProxyTimeout({ delayMs: 2000 })).toBe(37000);
  });

  it('重试按次数线性放大', () => {
    // 3 次尝试 × 30s + 2 次间隔 × 1s + 5s
    expect(computeProxyTimeout({ retryCount: 2, retryDelay: 1000 })).toBe(97000);
  });

  it('延迟 + 重试叠加', () => {
    expect(computeProxyTimeout({ delayMs: 5000, retryCount: 1, retryDelay: 2000 })).toBe(5000 + 60000 + 2000 + 5000);
  });
});

describe('B7: HAR 导出使用真实 content-type', () => {
  function makeLog(overrides: Partial<RequestLogEntry>): RequestLogEntry {
    return {
      id: 'log1',
      timestamp: 0,
      ruleId: 'r1',
      ruleName: 'test',
      originalUrl: 'https://a.com/x',
      proxiedUrl: 'https://b.com/x',
      method: 'POST',
      status: 200,
      proxyType: 'sw',
      responseBody: '{}',
      ...overrides,
    };
  }

  function firstEntry(log: RequestLogEntry): HarEntry {
    const har = logsToHar([log]) as { log: { entries: HarEntry[] } };
    expect(har.log.entries).toHaveLength(1);
    return har.log.entries[0];
  }

  it('请求/响应 mimeType 取自各自 content-type（大小写不敏感）', () => {
    const entry = firstEntry(
      makeLog({
        requestBody: 'a=1',
        requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseHeaders: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    expect(entry.request.postData?.mimeType).toBe('application/x-www-form-urlencoded');
    expect(entry.response.content?.mimeType).toBe('text/html; charset=utf-8');
  });

  it('缺失 content-type 时回退 application/json', () => {
    const entry = firstEntry(makeLog({ requestBody: '{}' }));
    expect(entry.request.postData?.mimeType).toBe('application/json');
    expect(entry.response.content?.mimeType).toBe('application/json');
  });
});
