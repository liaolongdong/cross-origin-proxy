/**
 * `utils/recentTargets.ts` —— 候选列表的三份纯判据
 *
 * 这一层不碰 `chrome`：读写与落盘顺序由 `tests/storageLockCache.test.ts` 末尾那一组按外部可观察面测，
 * 这里只管「什么算一个环境」「读回来的坏数据收成什么样」。三件事承重：
 * - **只记真正换过环境的**：自映射（合法的纯头注入）、空目标（Mock）、含 `{{变量}}` 的都不算。
 *   少了这一格，候选会被最常见的「注一条 Authorization」那种规则淹没，下拉就失去意义。
 * - **判据只有一份**：`distinctTargetOrigins` 是 `mergeRecentTargets` 唯一的取数入口，而界面列候选
 *   也用它——两处各写一份就会出现「保存时记了、下拉里没有」。
 * - **读回来的坏数据收成「没有候选」**：`storage.local` 里那个键可能被手改过，而候选不是事实来源。
 */
import { describe, it, expect } from 'vitest';
import { distinctTargetOrigins, mergeRecentTargets, sanitizeRecentTargets } from '@/utils/recentTargets';
import { MAX_RECENT_TARGETS } from '@/utils/constants';
import type { ProxyRule } from '@/utils/types';

function makeRule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r',
    name: 'rule',
    enabled: true,
    matchPattern: 'https://fat.example/*',
    targetUrl: 'https://uat.example',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('distinctTargetOrigins — 什么算一个「去过的环境」', () => {
  it('换过环境的规则给出它的目标 origin', () => {
    expect(distinctTargetOrigins([makeRule()])).toEqual(['https://uat.example']);
  });

  it.each([
    ['自映射（只注头/参数，本就不改地址）', { targetUrl: 'https://fat.example' }],
    ['空目标（Mock 规则）', { targetUrl: '' }],
    ['目标是变量引用', { targetUrl: '{{GATEWAY}}' }],
    ['目标读不出 URL', { targetUrl: 'uat.example' }],
    ['非 http(s) 协议', { targetUrl: 'ftp://uat.example' }],
  ])('%s 不记', (_label, overrides) => {
    expect(distinctTargetOrigins([makeRule(overrides)])).toEqual([]);
  });

  it('按给出顺序去重，端口参与比较', () => {
    const rules = [
      makeRule({ targetUrl: 'https://b.example' }),
      makeRule({ targetUrl: 'https://a.example' }),
      makeRule({ targetUrl: 'https://b.example/x' }),
      // 同一个域名换个端口就是另一个环境：这一条必须记，且不能与前一条合并
      makeRule({ targetUrl: 'https://a.example:8443' }),
    ];
    expect(distinctTargetOrigins(rules)).toEqual(['https://b.example', 'https://a.example', 'https://a.example:8443']);
  });

  it('空数组与整批都不合格时给出空列表', () => {
    expect(distinctTargetOrigins([])).toEqual([]);
  });
});

describe('mergeRecentTargets — 并进旧候选并按上限收口', () => {
  it('新记的排在旧候选之前', () => {
    expect(mergeRecentTargets(['https://old.example'], [makeRule()])).toEqual([
      'https://uat.example',
      'https://old.example',
    ]);
  });

  it('旧候选里已经有同一个目标时不重复占位，也不把它挪到最前', () => {
    expect(mergeRecentTargets(['https://uat.example', 'https://old.example'], [makeRule()])).toEqual([
      'https://uat.example',
      'https://old.example',
    ]);
  });

  it('总量按 MAX_RECENT_TARGETS 截，截的是末尾（最旧的那些）', () => {
    const incoming = Array.from({ length: MAX_RECENT_TARGETS }, (_unused, index) => `https://old${index}.test`);
    const merged = mergeRecentTargets(incoming, [makeRule()]);
    expect(merged).toHaveLength(MAX_RECENT_TARGETS);
    expect(merged[0]).toBe('https://uat.example');
    expect(merged).not.toContain(`https://old${MAX_RECENT_TARGETS - 1}.test`);
  });

  it('没有任何合格目标时原样交出旧候选（不该顺手清空）', () => {
    expect(mergeRecentTargets(['https://old.example'], [makeRule({ targetUrl: '' })])).toEqual(['https://old.example']);
  });
});

describe('sanitizeRecentTargets — 手改过的 storage 原文收成「没有候选」', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['一个对象', { 0: 'https://a.test', length: 1 }],
    ['一个字符串', 'https://a.test'],
    ['数字', 7],
  ])('%s 一律回空数组', (_label, raw) => {
    expect(sanitizeRecentTargets(raw)).toEqual([]);
  });

  it('剔掉非字符串与空串、去重、按上限截', () => {
    const raw = ['https://a.test', 7, '', null, 'https://a.test', 'https://b.test'];
    expect(sanitizeRecentTargets(raw)).toEqual(['https://a.test', 'https://b.test']);

    const long = Array.from({ length: MAX_RECENT_TARGETS + 3 }, (_unused, index) => `https://e${index}.test`);
    expect(sanitizeRecentTargets(long)).toEqual(long.slice(0, MAX_RECENT_TARGETS));
  });

  it('保留原顺序（它就是「最近优先」这件事的载体）', () => {
    expect(sanitizeRecentTargets(['https://newer.test', 'https://older.test'])).toEqual([
      'https://newer.test',
      'https://older.test',
    ]);
  });
});
