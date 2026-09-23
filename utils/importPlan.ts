import type { ImportMode, ImportPlan, ImportPlanConflict, ProxyRule } from '@/utils/types';
import { MAX_RULES } from '@/utils/constants';
import { deduplicateRules, ruleMergeKey } from '@/utils/ruleConflicts';

/**
 * 算出「这次导入会发生什么」，供用户在按下确认之前看见
 *
 * 与真实写入共用同一份判据：合并模式直接调用存储层用的 `deduplicateRules`，键计算共用
 * `ruleMergeKey`。这是本模块存在的唯一理由——预览一旦自己写一份差集，就会出现
 * 「预览说新增 3 条、实际进了 2 条」这种比没有预览更糟的结果。
 *
 * 合并必须原子，所以真实写入仍在存储锁内重算一遍（见 `importProxyConfig`）；锁外这份只是
 * **建议**，调用方的措辞必须是「预计新增」，不能是「将新增」。
 *
 * @param current 现网规则（写入那一刻之前的快照）
 * @param incoming 已过结构校验与规范化的导入条目（与写入侧同一份输入）
 * @param mode 导入模式
 */
export function planImport(current: ProxyRule[], incoming: ProxyRule[], mode: ImportMode): ImportPlan {
  if (mode === 'replace') {
    // 替换模式不做去重：文件整包成为新规则集，现网那批会被换掉（那一份正是恢复点要记的内容）
    return {
      mode,
      added: incoming.length,
      skipped: 0,
      conflicts: [],
      duplicatesWithinFile: 0,
      replaces: current.length,
      exceedsLimit: incoming.length > MAX_RULES,
    };
  }

  const kept = deduplicateRules(current, incoming);
  const keptSet = new Set(kept);
  const conflicts: ImportPlanConflict[] = [];
  // 现网同键规则只取第一条：`deduplicateRules` 的跳过判据也是「键存在即可」，多份同键现网规则
  // 在旧值展示上取哪一份都不影响「会不会被跳过」这个结论。
  const currentByKey = new Map<string, ProxyRule>();
  for (const rule of current) {
    const key = ruleMergeKey(rule);
    if (!currentByKey.has(key)) currentByKey.set(key, rule);
  }

  for (const rule of incoming) {
    if (keptSet.has(rule)) continue;
    const existing = currentByKey.get(ruleMergeKey(rule));
    if (!existing) continue;
    conflicts.push({
      name: rule.name,
      matchPattern: rule.matchPattern,
      currentTargetUrl: existing.targetUrl,
      incomingTargetUrl: rule.targetUrl,
    });
  }

  const seen = new Set<string>();
  let duplicatesWithinFile = 0;
  for (const rule of kept) {
    const key = ruleMergeKey(rule);
    if (seen.has(key)) duplicatesWithinFile++;
    else seen.add(key);
  }

  return {
    mode,
    added: kept.length,
    skipped: incoming.length - kept.length,
    conflicts,
    duplicatesWithinFile,
    replaces: 0,
    exceedsLimit: current.length + kept.length > MAX_RULES,
  };
}
