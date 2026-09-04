import type { ProxyRule } from './types';

/**
 * 将筛选态下的拖拽重排结果合并回完整规则列表：
 * 可见规则按拖拽后的新顺序占据原本可见规则的位置，隐藏（被筛选掉的）规则原地保留。
 */
export function mergeReorderedVisible(
  fullList: readonly ProxyRule[],
  reorderedVisible: readonly ProxyRule[],
): ProxyRule[] {
  const visibleIds = new Set(reorderedVisible.map(r => r.id));
  let visibleIdx = 0;
  return fullList.map(rule => (visibleIds.has(rule.id) ? reorderedVisible[visibleIdx++] : rule));
}
