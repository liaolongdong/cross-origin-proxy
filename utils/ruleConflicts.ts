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

/**
 * 合并导入时判定「同一条规则」的键
 *
 * 刻意不是 id：导入文件里的 id 在规范化阶段一律重生成，跨环境也不可比。判据只能是业务字段，
 * 因此「同一条规则改了目标地址」在合并语义下是**新增**而不是更新——导入预览必须演给用户看这件事。
 * 预览与真实写入共用这一个函数：两处各写一份键计算，迟早分叉成「预览说 3 条、实际进 2 条」。
 */
export function ruleMergeKey(rule: Pick<ProxyRule, 'name' | 'matchPattern'>): string {
  return `${rule.name}::${rule.matchPattern}`;
}

/**
 * 过滤掉与现有规则重复的导入条目（按 {@link ruleMergeKey} 判定），保持文件内原有顺序。
 *
 * 住在规则集分析模块而非消息路由层，是因为存储层的合并必须在持有互斥锁时调用它：
 * 去重依据的是「写入那一刻」的现有规则，锁外算好的差集可能已被并发写入作废。
 * 文件内部自重复不在这里剔除——那是既有语义，改它会静默少导规则，只能由导入预览如实报数。
 */
export function deduplicateRules(existing: ProxyRule[], incoming: ProxyRule[]): ProxyRule[] {
  const existingKeys = new Set(existing.map(ruleMergeKey));
  return incoming.filter(r => !existingKeys.has(ruleMergeKey(r)));
}
