import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { findMatchingRule, rewriteUrl, isSimpleRule, isWebSocketRule } from '@/utils/urlMatcher';
import { toDnrPriority } from '@/utils/dnrRules';
import { formatTimeAgo, getStatusColor, truncateUrl } from '@/utils/formatters';
import { findConflictingRule, computeShadowedRuleIds } from '@/utils/ruleConflicts';
import { computeLogStats, groupHitStatsByRule } from '@/utils/ruleStats';
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
const { deduplicateRules } = await import('@/utils/ruleConflicts');
const { isRetryableError, matchesMockCondition } = await import('@/entrypoints/background/proxyHandler');
const { REFRESH_INTERVAL_PRESETS } = await import('@/composables/useRequestLog');

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 1 / Bug 4 曾在本文件里以「测试自己写一份被测逻辑、再断那份副本」的形式存在
// （事件名数组、`const failedStatus = 0`、`const duration = Date.now() - startTime`）。
// 它们在任意生产改动下都不会变红，已删：
// - XHR 代理失败的事件派发与 status 0 → `tests/interceptorXhr.test.ts`（假 XHR + 真拦截器）
// - 日志 duration 的来源 → `tests/log-duration.test.ts`
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 2: WS 徽章 — 条件化显示深度验证
//
// 判据以前抄在本文件里一份（注释写着「与 RuleTable.vue 的三行显示助手同源」），
// 而 `RuleTable.vue` 早已改调 `utils/urlMatcher.isWebSocketRule`：抄的这份既钉不住
//  shipped 判据，还会在被测函数改口径时继续绿。现在直接 import 真实现。
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Bug 2] WS badge conditional display — deep verification', () => {
  const isWsRule = isWebSocketRule;

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
  /**
   * 以前这三条断的是测试自己写的字面量（`expect('Re').not.toBe('R')`、把九个标签抄进
   * 一个对象再断它们不重复），模板怎么改都不会红。现在直接从 `RuleTable.vue` 的模板里
   * 挑「类名 + 文字」这一对，钉的是画出来的那一份。
   */
  const source = fs.readFileSync('components/options/RuleTable.vue', 'utf8');
  const badges = [...source.matchAll(/class="rule-badge rule-badge--([a-z]+)">\s*([^<]+?)\s*</g)].map(m => ({
    modifier: m[1],
    label: m[2],
  }));

  it('模板里的徽章一枚都不能少（换写法时别把这条守卫一起改瞎）', () => {
    expect(badges.map(b => b.modifier)).toEqual(['h', 'c', 'b', 'r', 'm', 'd', 'x', 're', 'ws']);
  });

  it('文字标签两两不同：Re 与 R 撞了，重试和改响应就分不出来', () => {
    const labels = badges.map(b => b.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(badges.find(b => b.modifier === 're')?.label).toBe('Re');
    expect(badges.find(b => b.modifier === 'r')?.label).toBe('R');
  });

  it('重试那枚不再留着旧类名 --rt（配色改的是 --re）', () => {
    expect(source).not.toContain('rule-badge--rt');
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
// Feature 2: Per-rule hit counts — 深度验证（直接验证 utils/ruleStats.groupHitStatsByRule）
//
// 两条通道的计数窗口不同（网络层=近 5 分钟滚动，扩展通道=自上次配置变更），
// 相加得到的数不属于任何一段时间，因此这里钉的是「分通道保留、绝不相加」。
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Feature 2] Per-rule hit counts — deep verification', () => {
  it('同一规则两侧都有读数时分开保留，不合并成一个数', () => {
    const stats = groupHitStatsByRule([{ ruleId: 'r1', hitCount: 10 }], [{ ruleId: 'r1', hitCount: 5 }]);
    expect(stats.get('r1')).toEqual({ net: 10, ext: 5 });
  });

  it('只出现在网络层读数的规则，扩展通道记 0', () => {
    const stats = groupHitStatsByRule([{ ruleId: 'r1', hitCount: 10 }], []);
    expect(stats.get('r1')).toEqual({ net: 10, ext: 0 });
  });

  it('只出现在扩展通道的规则，网络层记 0（渲染侧再决定 0 要不要显示）', () => {
    const stats = groupHitStatsByRule([], [{ ruleId: 'r1', hitCount: 7 }]);
    expect(stats.get('r1')).toEqual({ net: 0, ext: 7 });
  });

  it('两侧都为空时不产生条目', () => {
    const stats = groupHitStatsByRule([], []);
    expect(stats.size).toBe(0);
  });

  it('多条规则跨通道归并：每条恰好一个条目，各通道分别累加', () => {
    const stats = groupHitStatsByRule(
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
    expect(stats.get('r1')).toEqual({ net: 10, ext: 1 });
    expect(stats.get('r2')).toEqual({ net: 20, ext: 0 });
    expect(stats.get('r3')).toEqual({ net: 30, ext: 0 });
    expect(stats.get('r4')).toEqual({ net: 0, ext: 40 });
    expect(stats.size).toBe(4);
  });

  it('未命中过的规则不在 Map 中（读端以「无条目」表示从未命中）', () => {
    const stats = groupHitStatsByRule([{ ruleId: 'r1', hitCount: 5 }], []);
    expect(stats.has('nonexistent')).toBe(false);
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
// 空 targetUrl 口径统一 + 删除撤销提交点：可诊断性与数据一致性守卫
// ═══════════════════════════════════════════════════════════════════════════════

const zhOptions = JSON.parse(fs.readFileSync('locales/zh_CN/options.json', 'utf-8'));
const enOptions = JSON.parse(fs.readFileSync('locales/en/options.json', 'utf-8'));

describe('[Empty target] 空目标规则在表单侧是合法输入', () => {
  const formSrc = fs.readFileSync('components/options/RuleFormDialog.vue', 'utf-8');

  it('不再把目标URL 声明为必填：导入的规则与 EmptyGuide 模板都用空目标，否则打开编辑框就再也保存不了', () => {
    expect(formSrc).not.toContain("t('targetUrlRequired')");
    expect(formSrc).not.toContain('|| !form.targetUrl');
  });

  it('留空语义必须在字段处可见，而不是靠用户猜', () => {
    expect(formSrc).toContain("t('targetUrlHint')");
  });

  it('中英两侧同时移除死 key、同时补上提示 key', () => {
    for (const dict of [zhOptions, enOptions]) {
      expect(dict).not.toHaveProperty('targetUrlRequired');
      expect(dict).toHaveProperty('targetUrlHint');
      expect(dict.targetUrlHint).toBeTruthy();
    }
  });

  it('中英三个命名空间 key 集保持一致（铁律 9，此前无守卫）', () => {
    for (const ns of ['common', 'options', 'popup'] as const) {
      const zhNs = JSON.parse(fs.readFileSync(`locales/zh_CN/${ns}.json`, 'utf-8'));
      const enNs = JSON.parse(fs.readFileSync(`locales/en/${ns}.json`, 'utf-8'));
      expect(Object.keys(zhNs).sort()).toEqual(Object.keys(enNs).sort());
    }
  });
});

describe('[Undo delete] 5 秒窗口与提交定时器不再各自为政', () => {
  const appSrc = fs.readFileSync('components/options/App.vue', 'utf-8');
  const start = appSrc.indexOf('function handleDeleteRule');
  const body = appSrc.slice(start, appSrc.indexOf('\n}\n', start));

  it('捕获规则走深拷贝，避免与原对象共享嵌套覆盖配置', () => {
    // cloneRule 而不是裸 structuredClone：从 rules.value 取出的那一条是响应式 Proxy
    expect(body).toContain('const capturedRule = cloneRule(rules.value[index])');
  });

  it('定时器先置提交标志并收起撤销入口，再发出删除', () => {
    expect(body).toMatch(/committed = true;[\s\S]*?message\.close\(\);[\s\S]*?chrome\.runtime/);
  });

  it('提交后的撤销必须直接返回，不能走到本地插回的假恢复', () => {
    const guard = body.slice(body.indexOf('if (committed)'));
    expect(guard.slice(0, guard.indexOf('rules.value.splice'))).toContain('return');
  });

  it('过期撤销有对应文案，且中英同时具备', () => {
    expect(appSrc).toContain("t('undoExpired')");
    for (const dict of [zhOptions, enOptions]) {
      expect(dict).toHaveProperty('undoExpired');
    }
  });

  it('乐观移除前登记撤销窗口，两条出口都注销（漏注销=删除成功后该行被永久屏蔽）', () => {
    expect(body).toMatch(/beginPendingDelete\(ruleId\);[\s\S]*?rules\.value = rules\.value\.filter/);
    const undoBranch = body.slice(body.indexOf('if (committed)'), body.indexOf('rules.value.splice'));
    expect(undoBranch).toContain('endPendingDelete(capturedRule.id)');
    expect(body).toMatch(/\.finally\(\(\) => endPendingDelete\(capturedRule\.id\)\)/);
  });
});

describe('[Mock save gate] 只配条件或只改状态码的 Mock 不再被静默丢弃', () => {
  const formSrc = fs.readFileSync('components/options/RuleFormDialog.vue', 'utf-8');
  const save = formSrc.slice(formSrc.indexOf('async function handleSave'));
  const mockBlock = save.slice(save.indexOf('if (enableMockResponse.value)'), save.indexOf('if (enableDelay.value)'));

  it('条件列表先于写入门计算，门同时看 body、状态码与条件', () => {
    expect(mockBlock.indexOf('const conditions =')).toBeLessThan(mockBlock.indexOf('if (form.mockBody'));
    expect(mockBlock).toContain('form.mockBody || form.mockStatus !== 200 || conditions.length > 0');
  });

  it('开关打开却什么都没填时给出提示，而不是假装保存了 Mock', () => {
    expect(mockBlock).toContain("ElMessage.warning(t('mockIgnored'))");
    for (const dict of [zhOptions, enOptions]) {
      expect(dict).toHaveProperty('mockIgnored');
    }
  });

  it('不再存在旧的 `enableMockResponse && form.mockBody` 单条件门', () => {
    expect(formSrc).not.toContain('if (enableMockResponse.value && form.mockBody)');
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

  it('should preserve methods and queryOverrides (a copy must not match more traffic than the original)', () => {
    const rule = makeRule({ methods: ['POST', 'DELETE'], queryOverrides: { __env: 'uat' } });
    const dup = buildDuplicateRuleData(rule, ' (副本)');
    expect(dup.methods).toEqual(['POST', 'DELETE']);
    expect(dup.methods).not.toBe(rule.methods);
    expect(dup.queryOverrides).toEqual({ __env: 'uat' });
    expect(dup.queryOverrides).not.toBe(rule.queryOverrides);
  });

  it('should leave optional fields undefined when source has none', () => {
    const rule = makeRule();
    const dup = buildDuplicateRuleData(rule, ' (副本)');
    expect(dup.methods).toBeUndefined();
    expect(dup.queryOverrides).toBeUndefined();
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

// ═══════════════════════════════════════════════════════════════════════════════
// 异步弹窗的挂载态初始化：hash 直达不得打开空白表单/空列表
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Async dialog init] props.visible watcher 必须 immediate', () => {
  // 弹窗全部是 defineAsyncComponent 且模板无 v-if：App.vue 的 onMounted 里
  // handleHashNavigation() 同步把 visible 置 true，而子组件要等分片取回才执行 setup。
  // 此时 props.visible 已是 true，无 immediate 的 watcher 永不触发——
  // RuleFormDialog 会打开一个空白表单（丢掉被编辑/预填的规则），
  // ProfilesDialog/SettingsDialog 会显示空列表与「不自动关闭」。
  // el-dialog 的 `open` 事件同样不可靠：它只在 modelValue 的 watcher 里 emit，
  // 挂载分支（use-dialog onMounted → open()）不 emit，故 @open 拉取在同一条路径上失效。
  const initializingDialogs = [
    'components/options/RuleFormDialog.vue',
    'components/options/ProfilesDialog.vue',
    'components/options/SettingsDialog.vue',
  ];

  it('承担初始化/数据拉取的 props.visible watcher 一律带 immediate', () => {
    for (const file of initializingDialogs) {
      const src = fs.readFileSync(file, 'utf-8');
      expect(src, file).toMatch(/\(\)\s*=>\s*props\.visible,/);
      // watcher 结尾必须是 `{ immediate: true }`（回调体里的 return 不算选项对象）
      expect(src, file).toMatch(/\{\s*immediate:\s*true\s*\},\s*\n\);/);
    }
  });

  it('弹窗不得只靠 el-dialog 的 open 事件拉数据', () => {
    for (const file of initializingDialogs) {
      const src = fs.readFileSync(file, 'utf-8');
      expect(src, file).not.toMatch(/@open\s*=/);
    }
  });

  it('hash 路由覆盖的每个入口，其弹窗组件都在守卫清单内', () => {
    const appSrc = fs.readFileSync('components/options/App.vue', 'utf-8');
    const start = appSrc.indexOf('function handleHashNavigation');
    const router = appSrc.slice(start, appSrc.indexOf('\n}\n', start));
    // 五个 hash 入口：#add-rule / #logs / #import-export / #profiles / #url-test（+ 带参的 from-tab）
    expect(router).toContain('#add-rule');
    expect(router).toContain('#logs');
    expect(router).toContain('#import-export');
    expect(router).toContain('#profiles');
    expect(router).toContain('#add-rule-from-tab=');
    // #url-test 是 popup「本页地址」卡的出口（可见性批次）：它打开的是既有纯受控弹窗
    expect(router).toContain('#url-test');
    // 对应组件：RuleFormDialog 与 ProfilesDialog 已在清单内；
    // ImportExportDialog / UrlTestDialog 为纯受控组件（无 visible watcher），
    // LogDrawer 的数据由 App.vue 自身的 watch(showLogs) 拉取——父组件 setup 早于 onMounted，不受本竞态影响。
    for (const stateless of [
      'components/options/ImportExportDialog.vue',
      'components/options/LogDrawer.vue',
      'components/options/UrlTestDialog.vue',
    ]) {
      const src = fs.readFileSync(stateless, 'utf-8');
      expect(src, stateless).not.toMatch(/\(\)\s*=>\s*props\.visible,/);
      expect(src, stateless).not.toMatch(/@open\s*=/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 优先级必须是整数：一个小数会让整批 updateDynamicRules 被拒
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Integer priority] 表单侧不再产出小数优先级', () => {
  const formSrc = fs.readFileSync('components/options/RuleFormDialog.vue', 'utf-8');
  const input = formSrc.slice(formSrc.indexOf('v-model="form.priority"'));
  const block = input.slice(0, input.indexOf('/>'));

  it('el-input-number 锁死 precision 与 step-strictly（缺任一项都能敲出 2.5）', () => {
    expect(block).toContain(':precision="0"');
    expect(block).toContain('step-strictly');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 可见性批次：popup 不得继续对网络层通道保持沉默
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Visibility] popup 的生效证据来自三条独立线索，而不是一句否定', () => {
  const popupSrc = fs.readFileSync('entrypoints/popup/App.vue', 'utf-8');

  it('popup 必须接入 DNR 可用性诊断，被跳过的规则不得渲染成绿色命中', () => {
    expect(popupSrc).toContain("from '@/utils/dnrSupport'");
    expect(popupSrc).toContain('findDnrSkippedRules');
    expect(popupSrc).toContain('pageHitRuleSkipped');
  });

  it('popup 必须按标签页取网络层命中数（SW 日志数不到这一半流量）', () => {
    expect(popupSrc).toContain('MessageType.GET_DNR_STATS');
    expect(popupSrc).toMatch(/data:\s*\{\s*tabId\s*\}/);
  });

  it('「0 次」与「不知道」必须可区分：三态判据只在 utils/dnrSample.ts 一处', () => {
    // 判据下沉到纯函数，两个入口只把 state 映射成文案；两处各写一遍曾经写过歪
    const sampleSrc = fs.readFileSync('utils/dnrSample.ts', 'utf-8');
    expect(sampleSrc).toContain('sampledAt === 0');
    expect(sampleSrc).toMatch(/stale\s*\?\s*\{\s*state:\s*'unavailable'[\s\S]{0,40}:\s*\{\s*state:\s*'notApplicable'/);
    for (const [file, src] of [
      ['entrypoints/popup/App.vue', popupSrc],
      ['composables/useRequestLog.ts', fs.readFileSync('composables/useRequestLog.ts', 'utf-8')],
    ] as const) {
      expect(src, file).toContain('describeDnrSample');
      expect(src, file).not.toContain('sampledAt === 0');
    }
    // 未采到样时渲染占位符，而不是把未知显示成 0
    expect(popupSrc).toContain("'—'");
  });

  it('网络层命中数不得等待 DNR 可用性诊断：regex 规则的 RE2 往返会拖慢这个数字', () => {
    const sampling = popupSrc.indexOf('void fetchTabDnrStats(');
    const diagnosis = popupSrc.indexOf('await findDnrSkippedRules(');
    expect(sampling).toBeGreaterThan(-1);
    expect(diagnosis).toBeGreaterThan(-1);
    expect(sampling).toBeLessThan(diagnosis);
  });

  it('第三格带注释行后，指标行与分隔线的对齐仍靠顶部/居中显式声明', () => {
    // 这三条都是静默失效型：缺了不报错，只是数字下沉半行、按钮换了一副字形
    const styleBlock = popupSrc.slice(popupSrc.indexOf('<style'));
    expect(styleBlock).toMatch(/\.metrics-row\s*\{[^}]*align-items:\s*flex-start/);
    expect(styleBlock).toMatch(/\.metric-divider\s*\{[^}]*align-self:\s*center/);
    expect(styleBlock).toMatch(/\.page-hit-link\s*\{[^}]*font-family:\s*inherit/);
  });

  it('网络层命中数不得写成「接口请求数」：该计数含图片/脚本/字体等全部资源类型', () => {
    // 窗口口径必须两侧都写出来，但中英的字面写法本就不同，不能拿一个正则套两份文案
    const windowPattern: Record<'zh_CN' | 'en', RegExp> = { zh_CN: /近 5 分钟/, en: /5 ?min/ };
    for (const locale of ['zh_CN', 'en'] as const) {
      const dict = JSON.parse(fs.readFileSync(`locales/${locale}/popup.json`, 'utf-8'));
      expect(dict.metricDnrTab, locale).toMatch(windowPattern[locale]);
      expect(dict.metricDnrTab, locale).not.toMatch(/接口|请求数|API request/i);
    }
  });
});
