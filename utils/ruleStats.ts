import type { RequestLogEntry, DnrHitStat } from '@/utils/types';

/**
 * 日志统计：按 status 区间计数 success/error 并返回总数
 *
 * 区间划分：200-399 视为 success（包含 3xx 重定向成功），其余（含 undefined、0）算 error。
 * 阻断请求 native 表现为 status=0，纳入 error 统计。
 */
export function computeLogStats(logs: RequestLogEntry[]): { total: number; success: number; error: number } {
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

/**
 * 合并 DNR 与 SW 通道的规则级命中数（按 ruleId 求和）
 *
 * 双通道同规则会累加；只在一侧出现的规则只取该侧值。用于 UI 单一展示。
 */
export function combineHitStats(
  dnrStats: Pick<DnrHitStat, 'ruleId' | 'hitCount'>[],
  swStats: Pick<DnrHitStat, 'ruleId' | 'hitCount'>[],
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
