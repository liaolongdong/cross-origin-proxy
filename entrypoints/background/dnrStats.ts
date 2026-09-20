import type { DnrHitStat } from '@/utils/types';

/**
 * DNR 命中详情的「映射 + 折叠」
 *
 * 采样、缓存与配额收在 `dnrSampler`（它是唯一允许调用 `getMatchedRules` 的地方）；
 * 本模块只负责两件与 chrome API 无关的事：
 * - 持有「DNR 规则 id → 代理规则」映射（`dnrManager` 每次同步后写入）
 * - 把逐条命中明细折叠成规则级计数
 *
 * 两者拆开后，映射语义可脱离 API 单测（见 `tests/dnrStatsAggregate.test.ts`）。
 */

/** DNR 规则 id → 代理规则 的映射，由 dnrManager 每次同步后更新 */
let dnrRuleIdMap = new Map<number, { ruleId: string; ruleName: string }>();

/** 更新 id 映射（dnrManager.syncDnrRules 调用） */
export function setDnrRuleIdMap(idMap: Map<number, { ruleId: string; ruleName: string }>): void {
  dnrRuleIdMap = idMap;
}

/**
 * 把 `getMatchedRules` 的逐条命中明细折叠为「规则级命中计数」（按次数降序）
 *
 * 未落在映射里的 DNR ruleId 回落成 `#${ruleId}` 而不是丢弃：那种明细只在「配置刚变更、
 * 映射还没重建」的窗口里出现，规则确实在工作，说不出名字也比看不见更接近事实。
 */
export function aggregateMatchedInfo(infos: chrome.declarativeNetRequest.MatchedRuleInfo[]): DnrHitStat[] {
  const counts = new Map<number, number>();
  for (const info of infos) {
    const dnrId = info.rule.ruleId;
    counts.set(dnrId, (counts.get(dnrId) ?? 0) + 1);
  }

  const stats: DnrHitStat[] = [];
  for (const [dnrId, hitCount] of counts) {
    const mapped = dnrRuleIdMap.get(dnrId);
    stats.push({
      ruleId: mapped?.ruleId ?? String(dnrId),
      ruleName: mapped?.ruleName ?? `#${dnrId}`,
      hitCount,
    });
  }
  stats.sort((a, b) => b.hitCount - a.hitCount);
  return stats;
}
