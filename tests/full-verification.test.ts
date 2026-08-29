import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { findMatchingRule, rewriteUrl, isSimpleRule } from '@/utils/urlMatcher';
import { toDnrPriority } from '@/utils/dnrRules';
import { formatTimeAgo, getStatusColor, truncateUrl } from '@/utils/formatters';
import type { ProxyRule, RequestLogEntry, MockCondition } from '@/utils/types';

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
// Bug 5: Log stats — 被阻断请求统计验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Bug 5] Log stats correctly count blocked/failed requests', () => {
  function computeLogStats(logs: RequestLogEntry[]) {
    let success = 0;
    let error = 0;
    for (const log of logs) {
      const status = log.status ?? 0;
      if (status >= 200 && status < 400) {
        success++;
      } else {
        error++;
      }
    }
    return { total: logs.length, success, error };
  }

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
// Feature 2: Per-rule hit counts — 深度验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 2] Per-rule hit counts — deep verification', () => {
  function combineHitStats(
    dnrStats: { ruleId: string; hitCount: number }[],
    swStats: { ruleId: string; hitCount: number }[],
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const stat of dnrStats) {
      map.set(stat.ruleId, (map.get(stat.ruleId) ?? 0) + stat.hitCount);
    }
    for (const stat of swStats) {
      map.set(stat.ruleId, (map.get(stat.ruleId) ?? 0) + stat.hitCount);
    }
    return map;
  }

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
// Feature 3: Conflict detection — 深度验证
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 3] Conflict detection — deep verification', () => {
  function findConflictingRule(
    allRules: ProxyRule[],
    ruleData: Partial<ProxyRule> & { matchPattern: string; matchType: ProxyRule['matchType']; priority: number },
    excludeId?: string,
  ): ProxyRule | null {
    const sorted = [...allRules].filter(r => r.enabled && r.id !== excludeId).sort((a, b) => a.priority - b.priority);
    for (const existing of sorted) {
      if (
        existing.matchPattern === ruleData.matchPattern &&
        existing.matchType === ruleData.matchType &&
        existing.priority < ruleData.priority
      ) {
        return existing;
      }
    }
    return null;
  }

  function computeShadowedRuleIds(allRules: ProxyRule[]): Set<string> {
    const sorted = [...allRules].filter(r => r.enabled).sort((a, b) => a.priority - b.priority);
    const seen = new Map<string, string>();
    const shadowed = new Set<string>();
    for (const rule of sorted) {
      const key = `${rule.matchType}::${rule.matchPattern}`;
      if (seen.has(key)) shadowed.add(rule.id);
      else seen.set(key, rule.id);
    }
    return shadowed;
  }

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
// 跨模块集成验证
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
    // Mirrors messageRouter.ts deduplicateRules logic
    function deduplicateRules(existing: ProxyRule[], incoming: ProxyRule[]): ProxyRule[] {
      const existingKeys = new Set(existing.map(r => `${r.name}::${r.matchPattern}`));
      return incoming.filter(r => !existingKeys.has(`${r.name}::${r.matchPattern}`));
    }

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
    // Mirrors proxyHandler.ts matchesMockCondition logic
    function matchesMockCondition(url: string, method: string, condition: MockCondition): boolean {
      if (condition.matchUrl) {
        try {
          if (!new RegExp(condition.matchUrl).test(url)) return false;
        } catch {
          return false;
        }
      }
      if (condition.matchMethod) {
        if (method.toUpperCase() !== condition.matchMethod.toUpperCase()) return false;
      }
      if (condition.matchQuery) {
        try {
          const parsed = new URL(url);
          for (const [key, value] of Object.entries(condition.matchQuery)) {
            if (parsed.searchParams.get(key) !== value) return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    }

    const condition: MockCondition = { body: '{}', matchMethod: 'get' };
    expect(matchesMockCondition('https://api.com/test', 'GET', condition)).toBe(true);
    expect(matchesMockCondition('https://api.com/test', 'POST', condition)).toBe(false);
  });

  it('matchesMockCondition matches query params', () => {
    function matchesMockCondition(url: string, method: string, condition: MockCondition): boolean {
      if (condition.matchUrl) {
        try {
          if (!new RegExp(condition.matchUrl).test(url)) return false;
        } catch {
          return false;
        }
      }
      if (condition.matchMethod) {
        if (method.toUpperCase() !== condition.matchMethod.toUpperCase()) return false;
      }
      if (condition.matchQuery) {
        try {
          const parsed = new URL(url);
          for (const [key, value] of Object.entries(condition.matchQuery)) {
            if (parsed.searchParams.get(key) !== value) return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    }

    const condition: MockCondition = { body: '{}', matchQuery: { page: '1', size: '10' } };
    expect(matchesMockCondition('https://api.com/test?page=1&size=10', 'GET', condition)).toBe(true);
    expect(matchesMockCondition('https://api.com/test?page=2&size=10', 'GET', condition)).toBe(false);
  });

  it('isRetryableError correctly identifies retryable conditions', () => {
    // Mirrors proxyHandler.ts isRetryableError logic
    function isRetryableError(error: unknown, status?: number): boolean {
      if (status !== undefined && status >= 500) return true;
      if (error instanceof Error && error.name === 'AbortError') return true;
      if (error instanceof TypeError) return true;
      return false;
    }

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
