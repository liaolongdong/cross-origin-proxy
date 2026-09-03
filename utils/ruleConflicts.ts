import type { ProxyRule } from '@/utils/types';

/**
 * 在已启用规则集中查找与待写入规则冲突的更高优先级规则
 *
 * 冲突定义：matchPattern + matchType 相同且 priority 数值更小（更优先）。
 * 排除自身（excludeId）以支持编辑模式。
 * 返回按 priority 升序排序后的第一个匹配。
 */
export function findConflictingRule(
  allRules: ProxyRule[],
  ruleData: { matchPattern: string; matchType: ProxyRule['matchType']; priority: number },
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

/**
 * 计算被同模式更高优先级规则遮蔽的规则 ID 集合
 *
 * 同一 matchType::matchPattern 出现多次时，priority 数值更大的（即排序靠后）
 * 会被遮蔽。matchType 不同即使 pattern 相同也不视为冲突。
 * disabled 规则不参与遮蔽计算（不会造成显示上的“永远不被命中”）。
 */
export function computeShadowedRuleIds(allRules: ProxyRule[]): Set<string> {
  const sorted = [...allRules].filter(r => r.enabled).sort((a, b) => a.priority - b.priority);
  const seen = new Map<string, string>();
  const shadowed = new Set<string>();
  for (const rule of sorted) {
    const key = `${rule.matchType}::${rule.matchPattern}`;
    if (seen.has(key)) {
      shadowed.add(rule.id);
    } else {
      seen.set(key, rule.id);
    }
  }
  return shadowed;
}
