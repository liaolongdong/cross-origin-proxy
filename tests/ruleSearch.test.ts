import { describe, expect, it } from 'vitest';
import { hasActiveRuleFilters, ruleMatchesKeyword } from '@/utils/ruleSearch';

function rule(overrides: Partial<{ name: string; matchPattern: string; targetUrl: string }> = {}) {
  return {
    name: 'FAT → UAT',
    matchPattern: 'https://fat-api.example.com/*',
    targetUrl: 'https://uat-api.example.com',
    ...overrides,
  };
}

describe('ruleMatchesKeyword', () => {
  it('空关键字匹配一切', () => {
    expect(ruleMatchesKeyword(rule(), '')).toBe(true);
  });

  it('大小写不敏感地匹配名称 / 匹配模式 / 目标地址', () => {
    expect(ruleMatchesKeyword(rule(), 'fat')).toBe(true);
    expect(ruleMatchesKeyword(rule(), 'UAT')).toBe(true);
    expect(ruleMatchesKeyword(rule(), 'FAT-API')).toBe(true);
    expect(ruleMatchesKeyword(rule(), 'uat-api.example.com')).toBe(true);
  });

  it('三处都不含时返回 false', () => {
    expect(ruleMatchesKeyword(rule(), 'prod')).toBe(false);
  });

  it('单个空格仍是一个筛选词：与主搜索原口径一致，不做 trim', () => {
    expect(ruleMatchesKeyword(rule({ name: 'A B' }), ' ')).toBe(true);
    expect(ruleMatchesKeyword(rule({ name: 'AB' }), ' ')).toBe(false);
  });
});

describe('hasActiveRuleFilters', () => {
  const none = { searchText: '', statusFilter: '', matchTypeFilter: '', tagsFilter: [] };

  it('四轴全空为假', () => {
    expect(hasActiveRuleFilters(none)).toBe(false);
  });

  it('任一轴非空为真（搜索词里的空格也算）', () => {
    expect(hasActiveRuleFilters({ ...none, searchText: ' ' })).toBe(true);
    expect(hasActiveRuleFilters({ ...none, statusFilter: 'enabled' })).toBe(true);
    expect(hasActiveRuleFilters({ ...none, matchTypeFilter: 'regex' })).toBe(true);
    expect(hasActiveRuleFilters({ ...none, tagsFilter: ['结算'] })).toBe(true);
  });
});
