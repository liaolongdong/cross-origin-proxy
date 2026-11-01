import type { ProxyRule } from './types';

/**
 * 规则关键字判据：主搜索与命令面板共用这一份
 *
 * 字段与大小写口径必须与主搜索完全一致（name / matchPattern / targetUrl，不做 trim），
 * 否则两处会对同一个关键字给出不同答案。
 */
export function ruleMatchesKeyword(
  rule: Pick<ProxyRule, 'name' | 'matchPattern' | 'targetUrl'>,
  keyword: string,
): boolean {
  const lower = keyword.toLowerCase();
  if (!lower) return true;
  return (
    rule.name.toLowerCase().includes(lower) ||
    rule.matchPattern.toLowerCase().includes(lower) ||
    rule.targetUrl.toLowerCase().includes(lower)
  );
}

/** 计数行「筛出 N 条」与命令面板「清除筛选」共用：四轴任一非空即算有筛选（空格也算） */
export function hasActiveRuleFilters(filters: {
  searchText: string;
  statusFilter: string;
  matchTypeFilter: string;
  tagsFilter: string[];
}): boolean {
  return (
    filters.searchText.length > 0 ||
    filters.statusFilter !== '' ||
    filters.matchTypeFilter !== '' ||
    filters.tagsFilter.length > 0
  );
}
