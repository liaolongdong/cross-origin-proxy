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
 * 单条规则在两条通道上的命中读数。
 *
 * 两个数的时间窗完全不同，**不能相加**：`net` 是网络层（DNR）近 5 分钟的滚动窗口，
 * `ext` 是扩展通道（SW）自上次配置变更 / SW 回收以来的累计。求和得到的既不是任何一个
 * 时间段内的命中量，还会让用户以为刷新一下就"掉了"。
 */
export interface RuleHitStats {
  net: number;
  ext: number;
}

/**
 * 按 ruleId 归并两条通道的规则级命中数（分通道保留）
 *
 * 只在一侧出现过的规则另一侧记 0；渲染侧再决定「0」要不要显示——
 * 网络层读不到时（商店安装态、配额退避）0 是「不知道」而不是「没命中」，
 * 那层判断属于视图，需要 `DnrSampleState`，故不放这里。
 */
export function groupHitStatsByRule(
  dnrStats: Pick<DnrHitStat, 'ruleId' | 'hitCount'>[],
  swStats: Pick<DnrHitStat, 'ruleId' | 'hitCount'>[],
): Map<string, RuleHitStats> {
  const map = new Map<string, RuleHitStats>();
  const touch = (ruleId: string): RuleHitStats => {
    const existing = map.get(ruleId);
    if (existing) return existing;
    const created: RuleHitStats = { net: 0, ext: 0 };
    map.set(ruleId, created);
    return created;
  };

  for (const stat of dnrStats) touch(stat.ruleId).net += stat.hitCount;
  for (const stat of swStats) touch(stat.ruleId).ext += stat.hitCount;
  return map;
}
