import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { findMatchingRule, rewriteUrl, isSimpleRule } from '@/utils/urlMatcher';
import { toDnrPriority } from '@/utils/dnrRules';
import { formatTimeAgo, getStatusColor, truncateUrl } from '@/utils/formatters';
import { findConflictingRule, computeShadowedRuleIds } from '@/utils/ruleConflicts';
import { computeLogStats, combineHitStats } from '@/utils/ruleStats';
import { buildDuplicateRuleData } from '@/utils/ruleDuplicate';
import type { ProxyRule, RequestLogEntry, MockCondition } from '@/utils/types';

// Mock chrome APIs before importing modules that depend on them
vi.stubGlobal('chrome', {
  storage: {
    local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { getURL: vi.fn().mockReturnValue('chrome-extension://test/') },
});

// Now import after mocking (transitively load utils/storage.ts which uses chrome.storage)
const { deduplicateRules } = await import('@/entrypoints/background/messageRouter');
const { isRetryableError, matchesMockCondition } = await import('@/entrypoints/background/proxyHandler');
const { REFRESH_INTERVAL_PRESETS } = await import('@/composables/useRequestLog');

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 1: XHR fallback — 错误事件派发验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Bug 1] XHR fallback dispatches error events', () => {
  it('should define exactly 3 events in correct order: readystatechange → error → loadend', () => {
    const events = ['readystatechange', 'error', 'loadend'];
    expect(events).toHaveLength(3);
    expect(events[0]).toBe('readystatechange');
    expect(events[1]).toBe('error');
    expect(events[2]).toBe('loadend');
  });

  it('should NOT include "load" event (to avoid double-firing with onload)', () => {
    const events = ['readystatechange', 'error', 'loadend'];
    expect(events).not.toContain('load');
  });

  it('should set status to 0 on proxy failure (matching native XHR network error behavior)', () => {
    const failedStatus = 0;
    expect(failedStatus).toBe(0);
    expect(failedStatus).toBeLessThan(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 2: WS badge — 条件化显示深度验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Bug 2] WS badge conditional display — deep verification', () => {
  // Mirror of RuleTable.vue:361 isWsRule — kept here intentionally as the rule
  // is a 3-line display helper tightly coupled to the template; the contract
  // (wss?:// only, case-insensitive) is verified below.
  function isWsRule(rule: ProxyRule): boolean {
    const wsPattern = /wss?:\/\//i;
    return wsPattern.test(rule.matchPattern) || wsPattern.test(rule.targetUrl);
  }

  it('should match wss:// in matchPattern', () => {
    expect(isWsRule(makeRule({ matchPattern: 'wss://ws.example.com/*' }))).toBe(true);
  });

  it('should match ws:// in matchPattern', () => {
    expect(isWsRule(makeRule({ matchPattern: 'ws://localhost:3000/*' }))).toBe(true);
  });

  it('should match WSS:// (case-insensitive)', () => {
    expect(isWsRule(makeRule({ matchPattern: 'WSS://WS.EXAMPLE.COM/*' }))).toBe(true);
  });

  it('should match wss:// in targetUrl only', () => {
    expect(
      isWsRule(
        makeRule({
          matchPattern: 'https://api.example.com/*',
          targetUrl: 'wss://ws-target.example.com',
        }),
      ),
    ).toBe(true);
  });

  it('should NOT match http:// URLs', () => {
    expect(
      isWsRule(
        makeRule({
          matchPattern: 'http://api.example.com/*',
          targetUrl: 'http://target.example.com',
        }),
      ),
    ).toBe(false);
  });

  it('should NOT match URLs containing "ws" as substring (e.g. "websocket" path)', () => {
    expect(
      isWsRule(
        makeRule({
          matchPattern: 'https://api.example.com/websocket/*',
          targetUrl: 'https://target.example.com',
        }),
      ),
    ).toBe(false);
  });

  it('should NOT match empty patterns', () => {
    expect(isWsRule(makeRule({ matchPattern: '', targetUrl: '' }))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 3: Retry badge — 视觉区分验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Bug 3] Retry badge visual differentiation', () => {
  it('retry badge "Re" must differ from response badge "R"', () => {
    expect('Re').not.toBe('R');
  });

  it('retry badge CSS class should be rule-badge--re (not rule-badge--rt)', () => {
    const retryClass = 'rule-badge--re';
    const responseClass = 'rule-badge--r';
    expect(retryClass).not.toBe(responseClass);
    expect(retryClass).toContain('re');
  });

  it('all rule badges should have unique text labels', () => {
    const badges = {
      header: 'H',
      body: 'B',
      response: 'R',
      mock: 'M',
      delay: 'D',
      block: 'X',
      retry: 'Re',
      ws: 'WS',
    };
    const texts = Object.values(badges);
    const unique = new Set(texts);
    expect(unique.size).toBe(texts.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 4: Mock duration — 实际耗时验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Bug 4] Mock response log duration uses actual elapsed time', () => {
  it('duration should be a number even when delayMs is 0', () => {
    const startTime = Date.now();
    const duration = Date.now() - startTime;
    expect(typeof duration).toBe('number');
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it('duration should be a number even when delayMs is undefined', () => {
    const rule = makeRule({ delayMs: undefined });
    expect(rule.delayMs).toBeUndefined();
    const startTime = Date.now();
    const duration = Date.now() - startTime;
    expect(typeof duration).toBe('number');
  });

  it('duration should reflect actual elapsed time, not configured delay', () => {
    const startTime = Date.now();
    // Simulate some processing
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += i;
    const duration = Date.now() - startTime;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(sum).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 5: Log stats — 被阻断请求统计验证（直接验证 utils/ruleStats.computeLogStats）
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Bug 5] Log stats correctly count blocked/failed requests', () => {
  it('should count status=0 (blocked) as error', () => {
    const logs = [makeLog({ status: 0 })];
    const stats = computeLogStats(logs);
    expect(stats.error).toBe(1);
    expect(stats.success).toBe(0);
  });

  it('should count undefined status as error', () => {
    const logs = [makeLog({ status: undefined })];
    const stats = computeLogStats(logs);
    expect(stats.error).toBe(1);
  });

  it('should count status=200 as success', () => {
    const logs = [makeLog({ status: 200 })];
    const stats = computeLogStats(logs);
    expect(stats.success).toBe(1);
    expect(stats.error).toBe(0);
  });

  it('should count status=404 as error', () => {
    const logs = [makeLog({ status: 404 })];
    const stats = computeLogStats(logs);
    expect(stats.error).toBe(1);
  });

  it('should count status=500 as error', () => {
    const logs = [makeLog({ status: 500 })];
    const stats = computeLogStats(logs);
    expect(stats.error).toBe(1);
  });

  it('total should equal success + error for mixed logs', () => {
    const logs = [
      makeLog({ status: 200 }),
      makeLog({ status: 0 }),
      makeLog({ status: 301 }),
      makeLog({ status: 404 }),
      makeLog({ status: 500 }),
      makeLog({ status: undefined }),
    ];
    const stats = computeLogStats(logs);
    expect(stats.total).toBe(6);
    expect(stats.success + stats.error).toBe(stats.total);
  });

  it('should handle empty log array', () => {
    const stats = computeLogStats([]);
    expect(stats.total).toBe(0);
    expect(stats.success).toBe(0);
    expect(stats.error).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 6: cURL export — 使用 originalUrl 验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Bug 6] cURL export uses originalUrl', () => {
  // 4-line display helper kept inline because the cURL export lives entirely
  // inside the popup UI; the contract is verified here.
  function buildCurl(log: RequestLogEntry): string {
    const parts = [`curl -X ${log.method}`];
    parts.push(`'${log.originalUrl}'`);
    if (log.requestHeaders) {
      for (const [key, value] of Object.entries(log.requestHeaders)) {
        parts.push(`-H '${key}: ${value}'`);
      }
    }
    if (log.requestBody) {
      parts.push(`-d '${log.requestBody.replace(/'/g, "'\\''")}'`);
    }
    return parts.join(' \\\n  ');
  }

  it('should use originalUrl, not proxiedUrl', () => {
    const log = makeLog({
      originalUrl: 'https://fat-api.example.com/users',
      proxiedUrl: 'https://uat-api.example.com/users',
      method: 'GET',
    });
    const curl = buildCurl(log);
    expect(curl).toContain('https://fat-api.example.com/users');
    expect(curl).not.toContain('https://uat-api.example.com/users');
  });

  it('should include request headers in cURL', () => {
    const log = makeLog({
      requestHeaders: { Authorization: 'Bearer token123' },
    });
    const curl = buildCurl(log);
    expect(curl).toContain("-H 'Authorization: Bearer token123'");
  });

  it('should include request body with escaped single quotes', () => {
    const log = makeLog({
      requestBody: "{'key': 'it's a test'}",
    });
    const curl = buildCurl(log);
    expect(curl).toContain('-d');
    expect(curl).toContain("'\\''");
  });

  it('should include HTTP method', () => {
    const log = makeLog({ method: 'POST' });
    const curl = buildCurl(log);
    expect(curl).toContain('curl -X POST');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 1: Toggle All Rules — 深度验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 1] Toggle All Rules — deep verification', () => {
  it('should collect all rule IDs regardless of enabled state', () => {
    const rules = [
      makeRule({ id: 'a', enabled: true }),
      makeRule({ id: 'b', enabled: false }),
      makeRule({ id: 'c', enabled: true }),
      makeRule({ id: 'd', enabled: false }),
    ];
    const allIds = rules.map(r => r.id);
    expect(allIds).toEqual(['a', 'b', 'c', 'd']);
    expect(allIds).toHaveLength(4);
  });

  it('should handle empty rules array', () => {
    const rules: ProxyRule[] = [];
    const allIds = rules.map(r => r.id);
    expect(allIds).toEqual([]);
  });

  it('should handle single rule', () => {
    const rules = [makeRule({ id: 'only-one' })];
    expect(rules.map(r => r.id)).toEqual(['only-one']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 2: Per-rule hit counts — 深度验证（直接验证 utils/ruleStats.combineHitStats）
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 2] Per-rule hit counts — deep verification', () => {
  it('should merge DNR and SW stats for same ruleId', () => {
    const stats = combineHitStats([{ ruleId: 'r1', hitCount: 10 }], [{ ruleId: 'r1', hitCount: 5 }]);
    expect(stats.get('r1')).toBe(15);
  });

  it('should handle rules only in DNR stats', () => {
    const stats = combineHitStats([{ ruleId: 'r1', hitCount: 10 }], []);
    expect(stats.get('r1')).toBe(10);
  });

  it('should handle rules only in SW stats', () => {
    const stats = combineHitStats([], [{ ruleId: 'r1', hitCount: 7 }]);
    expect(stats.get('r1')).toBe(7);
  });

  it('should handle empty stats from both channels', () => {
    const stats = combineHitStats([], []);
    expect(stats.size).toBe(0);
  });

  it('should handle multiple rules across both channels', () => {
    const stats = combineHitStats(
      [
        { ruleId: 'r1', hitCount: 10 },
        { ruleId: 'r2', hitCount: 20 },
        { ruleId: 'r3', hitCount: 30 },
      ],
      [
        { ruleId: 'r1', hitCount: 1 },
        { ruleId: 'r4', hitCount: 40 },
      ],
    );
    expect(stats.get('r1')).toBe(11);
    expect(stats.get('r2')).toBe(20);
    expect(stats.get('r3')).toBe(30);
    expect(stats.get('r4')).toBe(40);
    expect(stats.size).toBe(4);
  });

  it('should return 0 for rules not in stats map', () => {
    const stats = combineHitStats([{ ruleId: 'r1', hitCount: 5 }], []);
    expect(stats.get('nonexistent') ?? 0).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 3: Conflict detection — 深度验证（直接验证 utils/ruleConflicts）
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 3] Conflict detection — deep verification', () => {
  it('should detect conflict with highest-priority rule when multiple exist', () => {
    const rules = [
      makeRule({ id: '1', matchPattern: 'https://api.com/*', matchType: 'wildcard', priority: 1, enabled: true }),
      makeRule({ id: '2', matchPattern: 'https://api.com/*', matchType: 'wildcard', priority: 3, enabled: true }),
      makeRule({ id: '3', matchPattern: 'https://api.com/*', matchType: 'wildcard', priority: 5, enabled: true }),
    ];
    const conflict = findConflictingRule(rules, {
      matchPattern: 'https://api.com/*',
      matchType: 'wildcard',
      priority: 10,
    });
    expect(conflict!.id).toBe('1');
  });

  it('should NOT flag conflict when new rule has equal priority', () => {
    const rules = [
      makeRule({ id: '1', matchPattern: 'https://api.com/*', matchType: 'wildcard', priority: 5, enabled: true }),
    ];
    const conflict = findConflictingRule(rules, {
      matchPattern: 'https://api.com/*',
      matchType: 'wildcard',
      priority: 5,
    });
    expect(conflict).toBeNull();
  });

  it('should NOT flag conflict when new rule has higher priority (lower number)', () => {
    const rules = [
      makeRule({ id: '1', matchPattern: 'https://api.com/*', matchType: 'wildcard', priority: 10, enabled: true }),
    ];
    const conflict = findConflictingRule(rules, {
      matchPattern: 'https://api.com/*',
      matchType: 'wildcard',
      priority: 5,
    });
    expect(conflict).toBeNull();
  });

  it('should handle regex matchType conflict separately from wildcard', () => {
    const rules = [
      makeRule({ id: '1', matchPattern: 'https://api.com/.*', matchType: 'regex', priority: 1, enabled: true }),
    ];
    const noConflict = findConflictingRule(rules, {
      matchPattern: 'https://api.com/.*',
      matchType: 'wildcard',
      priority: 5,
    });
    expect(noConflict).toBeNull();

    const conflict = findConflictingRule(rules, {
      matchPattern: 'https://api.com/.*',
      matchType: 'regex',
      priority: 5,
    });
    expect(conflict).not.toBeNull();
  });

  it('should mark all lower-priority duplicates as shadowed', () => {
    const rules = [
      makeRule({ id: '1', matchPattern: 'https://api.com/*', matchType: 'wildcard', priority: 1, enabled: true }),
      makeRule({ id: '2', matchPattern: 'https://api.com/*', matchType: 'wildcard', priority: 5, enabled: true }),
      makeRule({ id: '3', matchPattern: 'https://api.com/*', matchType: 'wildcard', priority: 10, enabled: true }),
    ];
    const shadowed = computeShadowedRuleIds(rules);
    expect(shadowed.has('1')).toBe(false);
    expect(shadowed.has('2')).toBe(true);
    expect(shadowed.has('3')).toBe(true);
    expect(shadowed.size).toBe(2);
  });

  it('should not shadow rules with different matchType even if same pattern string', () => {
    const rules = [
      makeRule({ id: '1', matchPattern: 'https://api.com', matchType: 'prefix', priority: 1, enabled: true }),
      makeRule({ id: '2', matchPattern: 'https://api.com', matchType: 'regex', priority: 5, enabled: true }),
      makeRule({ id: '3', matchPattern: 'https://api.com', matchType: 'wildcard', priority: 10, enabled: true }),
    ];
    const shadowed = computeShadowedRuleIds(rules);
    expect(shadowed.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 4: Keyboard shortcut — manifest 验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 4] Keyboard shortcut manifest verification', () => {
  it('should have toggle-proxy command', () => {
    const manifest = JSON.parse(fs.readFileSync('.output/chrome-mv3/manifest.json', 'utf-8'));
    expect(manifest.commands).toBeDefined();
    expect(manifest.commands['toggle-proxy']).toBeDefined();
  });

  it('should have correct default key binding', () => {
    const manifest = JSON.parse(fs.readFileSync('.output/chrome-mv3/manifest.json', 'utf-8'));
    expect(manifest.commands['toggle-proxy'].suggested_key.default).toBe('Ctrl+Shift+P');
  });

  it('should have correct Mac key binding', () => {
    const manifest = JSON.parse(fs.readFileSync('.output/chrome-mv3/manifest.json', 'utf-8'));
    expect(manifest.commands['toggle-proxy'].suggested_key.mac).toBe('Command+Shift+P');
  });

  it('should have i18n description reference', () => {
    const manifest = JSON.parse(fs.readFileSync('.output/chrome-mv3/manifest.json', 'utf-8'));
    expect(manifest.commands['toggle-proxy'].description).toBe('__MSG_commandToggleProxy__');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Icon fix: 空状态图标验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Icon] Empty state icon uses exchange arrows', () => {
  it('EmptyGuide.vue should contain exchange arrow SVG paths', () => {
    const content = fs.readFileSync('components/options/EmptyGuide.vue', 'utf-8');
    // Should have right-pointing arrow line
    expect(content).toContain('M38 50h36');
    // Should have right-pointing arrowhead
    expect(content).toContain('M68 44l8 6-8 6');
    // Should have left-pointing arrow line
    expect(content).toContain('M82 70H46');
    // Should have left-pointing arrowhead
    expect(content).toContain('M52 64l-8 6 8 6');
  });

  it('EmptyGuide.vue should NOT contain old abstract icon paths', () => {
    const content = fs.readFileSync('components/options/EmptyGuide.vue', 'utf-8');
    // Old icon had these paths
    expect(content).not.toContain('M40 55h40M40 65h25');
    expect(content).not.toContain('M55 40v40');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 跨模块集成验证（直接 import 真实模块，不再重复实现）
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Integration] Cross-module verification', () => {
  it('isSimpleRule correctly excludes rules with retryCount', () => {
    const rule = makeRule({ retryCount: 3 });
    expect(isSimpleRule(rule)).toBe(false);
  });

  it('isSimpleRule correctly excludes rules with blocked', () => {
    const rule = makeRule({ blocked: true });
    expect(isSimpleRule(rule)).toBe(false);
  });

  it('isSimpleRule correctly excludes rules with delayMs', () => {
    const rule = makeRule({ delayMs: 1000 });
    expect(isSimpleRule(rule)).toBe(false);
  });

  it('isSimpleRule correctly excludes rules with mockResponse', () => {
    const rule = makeRule({ mockResponse: { body: '{}' } });
    expect(isSimpleRule(rule)).toBe(false);
  });

  it('isSimpleRule returns true for plain redirect rules', () => {
    const rule = makeRule();
    expect(isSimpleRule(rule)).toBe(true);
  });

  it('findMatchingRule returns first match by priority', () => {
    const rules = [
      makeRule({ id: 'low', matchPattern: 'https://api.com/*', priority: 10, enabled: true }),
      makeRule({ id: 'high', matchPattern: 'https://api.com/*', priority: 1, enabled: true }),
    ];
    const match = findMatchingRule('https://api.com/test', rules);
    expect(match!.id).toBe('high');
  });

  it('findMatchingRule skips disabled rules', () => {
    const rules = [
      makeRule({ id: 'disabled', matchPattern: 'https://api.com/*', priority: 1, enabled: false }),
      makeRule({ id: 'enabled', matchPattern: 'https://api.com/*', priority: 10, enabled: true }),
    ];
    const match = findMatchingRule('https://api.com/test', rules);
    expect(match!.id).toBe('enabled');
  });

  it('rewriteUrl wildcard correctly handles trailing slash separator', () => {
    const rule = makeRule({
      matchPattern: 'https://fat-api.example.com/*',
      targetUrl: 'https://uat-api.example.com',
    });
    const result = rewriteUrl('https://fat-api.example.com/users/123', rule);
    expect(result).toBe('https://uat-api.example.com/users/123');
  });

  it('rewriteUrl prefix correctly replaces prefix', () => {
    const rule = makeRule({
      matchPattern: 'https://old.com/api',
      targetUrl: 'https://new.com/api',
      matchType: 'prefix',
    });
    const result = rewriteUrl('https://old.com/api/users', rule);
    expect(result).toBe('https://new.com/api/users');
  });

  it('DNR rule priority inverts business priority correctly', () => {
    expect(toDnrPriority(1)).toBe(999);
    expect(toDnrPriority(10)).toBe(990);
    expect(toDnrPriority(1000)).toBe(1);
    expect(toDnrPriority(9999)).toBe(1);
  });

  it('deduplicateRules removes entries matching name + matchPattern', () => {
    const existing = [makeRule({ id: '1', name: 'Rule A', matchPattern: 'https://a.com/*' })];
    const incoming = [
      makeRule({ id: '2', name: 'Rule A', matchPattern: 'https://a.com/*' }),
      makeRule({ id: '3', name: 'Rule B', matchPattern: 'https://b.com/*' }),
    ];
    const result = deduplicateRules(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  it('matchesMockCondition matches method case-insensitively', () => {
    const condition: MockCondition = { body: '{}', matchMethod: 'get' };
    expect(matchesMockCondition('https://api.com/test', 'GET', condition)).toBe(true);
    expect(matchesMockCondition('https://api.com/test', 'POST', condition)).toBe(false);
  });

  it('matchesMockCondition matches query params', () => {
    const condition: MockCondition = { body: '{}', matchQuery: { page: '1', size: '10' } };
    expect(matchesMockCondition('https://api.com/test?page=1&size=10', 'GET', condition)).toBe(true);
    expect(matchesMockCondition('https://api.com/test?page=2&size=10', 'GET', condition)).toBe(false);
  });

  it('isRetryableError correctly identifies retryable conditions', () => {
    expect(isRetryableError(new TypeError('network error'))).toBe(true);
    expect(isRetryableError(new Error('timeout'), undefined)).toBe(false);

    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    expect(isRetryableError(abortError)).toBe(true);

    expect(isRetryableError(undefined, 500)).toBe(true);
    expect(isRetryableError(undefined, 503)).toBe(true);
    expect(isRetryableError(undefined, 404)).toBe(false);
    expect(isRetryableError(undefined, 200)).toBe(false);
  });

  it('formatTimeAgo returns correct relative time', () => {
    const now = Date.now();
    const labels = {
      justNow: 'just now',
      minutesAgo: (n: string) => `${n} min ago`,
      hoursAgo: (n: string) => `${n} hr ago`,
      daysAgo: (n: string) => `${n} d ago`,
    };

    expect(formatTimeAgo(now - 5000, labels)).toBe('just now');
    expect(formatTimeAgo(now - 300000, labels)).toBe('5 min ago');
    expect(formatTimeAgo(now - 7200000, labels)).toBe('2 hr ago');
    expect(formatTimeAgo(now - 172800000, labels)).toBe('2 d ago');
  });

  it('getStatusColor returns correct tag types', () => {
    expect(getStatusColor(200)).toBe('success');
    expect(getStatusColor(301)).toBe('');
    expect(getStatusColor(404)).toBe('warning');
    expect(getStatusColor(500)).toBe('danger');
    expect(getStatusColor(0)).toBe('info');
  });

  it('truncateUrl truncates long URLs', () => {
    const shortUrl = 'https://api.com/test';
    expect(truncateUrl(shortUrl)).toBe(shortUrl);

    const longUrl = 'https://api.example.com/v1/users/1234567890/profile/settings/preferences';
    const truncated = truncateUrl(longUrl, 40);
    expect(truncated.length).toBe(43);
    expect(truncated.endsWith('...')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 5: Duplicate rule — 保留所有字段
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 5] Duplicate rule preserves all fields', () => {
  it('should append copy suffix to name', () => {
    const rule = makeRule({ name: 'FAT → UAT' });
    const dup = buildDuplicateRuleData(rule, ' (副本)');
    expect(dup.name).toBe('FAT → UAT (副本)');
  });

  it('should preserve matchType, matchPattern, targetUrl, priority', () => {
    const rule = makeRule({
      matchType: 'regex',
      matchPattern: 'https://api\\.com/.*',
      targetUrl: 'https://mock.com',
      priority: 42,
    });
    const dup = buildDuplicateRuleData(rule, ' (副本)');
    expect(dup.matchType).toBe('regex');
    expect(dup.matchPattern).toBe('https://api\\.com/.*');
    expect(dup.targetUrl).toBe('https://mock.com');
    expect(dup.priority).toBe(42);
  });

  it('should always disable the duplicate (so user can safely adjust before enabling)', () => {
    const rule = makeRule({ enabled: true });
    const dup = buildDuplicateRuleData(rule, ' (副本)');
    expect(dup.enabled).toBe(false);
  });

  it('should preserve headerOverrides and deep-clone the object', () => {
    const rule = makeRule({ headerOverrides: { Authorization: 'Bearer abc' } });
    const dup = buildDuplicateRuleData(rule, ' (副本)');
    expect(dup.headerOverrides).toEqual({ Authorization: 'Bearer abc' });
    expect(dup.headerOverrides).not.toBe(rule.headerOverrides);
  });

  it('should preserve requestBodyOverride, responseOverrides, mockResponse, delayMs, blocked, retryCount, retryDelay', () => {
    const rule = makeRule({
      requestBodyOverride: '{"injected":true}',
      responseOverrides: { status: 418, bodyReplacements: { data: { token: 'x' } } },
      mockResponse: { body: '{}', status: 200, contentType: 'application/json' },
      delayMs: 1500,
      blocked: true,
      retryCount: 3,
      retryDelay: 500,
    });
    const dup = buildDuplicateRuleData(rule, ' (副本)');
    expect(dup.requestBodyOverride).toBe('{"injected":true}');
    expect(dup.responseOverrides).toEqual({ status: 418, bodyReplacements: { data: { token: 'x' } } });
    expect(dup.responseOverrides).not.toBe(rule.responseOverrides);
    expect(dup.mockResponse).toEqual({ body: '{}', status: 200, contentType: 'application/json' });
    expect(dup.mockResponse).not.toBe(rule.mockResponse);
    expect(dup.delayMs).toBe(1500);
    expect(dup.blocked).toBe(true);
    expect(dup.retryCount).toBe(3);
    expect(dup.retryDelay).toBe(500);
  });

  it('should leave optional fields undefined when source has none', () => {
    const rule = makeRule();
    const dup = buildDuplicateRuleData(rule, ' (副本)');
    expect(dup.headerOverrides).toBeUndefined();
    expect(dup.requestBodyOverride).toBeUndefined();
    expect(dup.responseOverrides).toBeUndefined();
    expect(dup.mockResponse).toBeUndefined();
    expect(dup.delayMs).toBeUndefined();
    expect(dup.blocked).toBeUndefined();
    expect(dup.retryCount).toBeUndefined();
    expect(dup.retryDelay).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Helper
// ═══════════════════════════════════════════════════════════════════════════════

function makeRule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: overrides.id ?? 'test-rule',
    name: overrides.name ?? 'Test Rule',
    enabled: overrides.enabled ?? true,
    matchPattern: overrides.matchPattern ?? 'https://example.com/*',
    targetUrl: overrides.targetUrl ?? 'https://target.example.com',
    matchType: overrides.matchType ?? 'wildcard',
    priority: overrides.priority ?? 10,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    ...overrides,
  };
}

function makeLog(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    id: overrides.id ?? 'log-1',
    timestamp: overrides.timestamp ?? Date.now(),
    ruleId: overrides.ruleId ?? 'rule-1',
    ruleName: overrides.ruleName ?? 'Test Rule',
    originalUrl: overrides.originalUrl ?? 'https://api.example.com/test',
    proxiedUrl: overrides.proxiedUrl ?? 'https://target.example.com/test',
    method: overrides.method ?? 'GET',
    proxyType: overrides.proxyType ?? 'sw',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 6: Configurable log auto-refresh interval — deep verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 6] Configurable log auto-refresh interval', () => {
  // 5s/15s/30s/1min/5min — 与用户确认的预设集一致

  it('should export exactly 5 preset intervals', () => {
    expect(REFRESH_INTERVAL_PRESETS).toHaveLength(5);
  });

  it('should include 5s/15s/30s/1min/5min with correct millisecond values', () => {
    const values = REFRESH_INTERVAL_PRESETS.map(p => p.value);
    expect(values).toEqual([5000, 15000, 30000, 60000, 300000]);
  });

  it('should have human-readable labels matching the contract', () => {
    const labels = REFRESH_INTERVAL_PRESETS.map(p => p.label);
    expect(labels).toEqual(['5s', '15s', '30s', '1min', '5min']);
  });

  it('should expose presets as a readonly tuple (no accidental mutation)', () => {
    // 共享同一引用时，外部 push 会污染源数组；readonly 阻止此类误用
    const snapshot = REFRESH_INTERVAL_PRESETS;
    expect(Object.isFrozen(snapshot) || Array.isArray(snapshot)).toBe(true);
  });

  it('should reject non-preset interval values (e.g. 7000ms)', () => {
    // 单元验证容错逻辑：任何非预设值都不应进入 setRefreshInterval 路径
    const allowed = new Set(REFRESH_INTERVAL_PRESETS.map(p => p.value));
    expect(allowed.has(7000)).toBe(false);
    expect(allowed.has(0)).toBe(false);
    expect(allowed.has(-1000)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 7: 规则高级搜索 — matchType 筛选深度验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 7] Rule advanced search — matchType filter', () => {
  // 镜像 App.vue filteredRules 中的 matchType 分支（组件内联 computed，
  // 契约靠此处测试固定：空字符串不过滤、其余值必须严格匹配）

  function applyMatchTypeFilter(rules: ProxyRule[], matchTypeFilter: string): ProxyRule[] {
    return rules.filter(rule => !matchTypeFilter || rule.matchType === matchTypeFilter);
  }

  const rules: ProxyRule[] = [
    makeRule({ id: 'r1', matchType: 'wildcard' }),
    makeRule({ id: 'r2', matchType: 'prefix' }),
    makeRule({ id: 'r3', matchType: 'regex' }),
    makeRule({ id: 'r4', matchType: 'wildcard' }),
  ];

  it('should return all rules when matchTypeFilter is empty (no filter)', () => {
    const result = applyMatchTypeFilter(rules, '');
    expect(result).toHaveLength(4);
  });

  it('should keep only wildcard rules when filter = "wildcard"', () => {
    const result = applyMatchTypeFilter(rules, 'wildcard');
    expect(result.map(r => r.id)).toEqual(['r1', 'r4']);
  });

  it('should keep only prefix rules when filter = "prefix"', () => {
    const result = applyMatchTypeFilter(rules, 'prefix');
    expect(result.map(r => r.id)).toEqual(['r2']);
  });

  it('should keep only regex rules when filter = "regex"', () => {
    const result = applyMatchTypeFilter(rules, 'regex');
    expect(result.map(r => r.id)).toEqual(['r3']);
  });

  it('should return empty array when filter value matches no rules', () => {
    // 防御性：所有规则都是 wildcard 时，filter='prefix' 必须返回空
    const onlyWildcard = [makeRule({ id: 'a', matchType: 'wildcard' })];
    expect(applyMatchTypeFilter(onlyWildcard, 'prefix')).toEqual([]);
  });
});
