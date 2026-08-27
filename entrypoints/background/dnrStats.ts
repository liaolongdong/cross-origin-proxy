import { logger } from '@/utils/logger';
import type { DnrHitStat } from '@/utils/types';

/**
 * DNR 命中统计
 *
 * DNR 通道的重定向发生在浏览器网络层，无法像 SW fetch 通道那样产出逐条日志。
 * 借助 declarativeNetRequestFeedback 权限的 getMatchedRules()（近 5 分钟窗口），
 * 聚合为「规则级命中计数」供日志抽屉展示。
 *
 * 注意：getMatchedRules 有配额限制（每 10 分钟约 20 次），由 UI 侧手动刷新触发，
 * 超配额时静默返回上次结果。
 */

/** DNR 规则 id → 代理规则 的映射，由 dnrManager 每次同步后更新 */
let dnrRuleIdMap = new Map<number, { ruleId: string; ruleName: string }>();

/** 上次成功的统计结果（超配额时兜底返回） */
let lastStats: DnrHitStat[] = [];

/** 更新 id 映射（dnrManager.syncDnrRules 调用） */
export function setDnrRuleIdMap(idMap: Map<number, { ruleId: string; ruleName: string }>): void {
  dnrRuleIdMap = idMap;
}

/**
 * 获取 DNR 规则级命中统计（近 5 分钟）
 */
export async function getDnrHitStats(): Promise<DnrHitStat[]> {
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({});

    const counts = new Map<number, number>();
    for (const info of rulesMatchedInfo) {
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

    lastStats = stats;
    return stats;
  } catch (error) {
    // 超配额或权限异常：返回上次结果，避免 UI 报错
    logger.warn('getMatchedRules failed (quota or permission):', error);
    return lastStats;
  }
}
