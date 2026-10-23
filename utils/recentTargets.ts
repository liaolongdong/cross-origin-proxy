import { MAX_RECENT_TARGETS } from '@/utils/constants';
import { sameOriginNoRewrite } from '@/utils/urlMatcher';
import { apiOriginOf } from '@/utils/pageApiOrigins';
import type { ProxyRule } from '@/utils/types';

/**
 * 「最近用过的目标环境」——配置页 `目标URL` 那一格的候选列表
 *
 * 为什么需要它：这个扩展的核心动作是把请求从 A 环境改写到 B 环境，而派生出来的草稿
 * （HAR / cURL / 日志 / 本页接口）填的却是 A 自己，用户每次都要重新想起 B 的地址。
 * 候选来自用户**已经存下来**的那些目标，所以它不需要第二个事实来源，也不引入新权限。
 *
 * 这份列表是非承重的：不参与任何生效判定、不进任何导出（一份分享的配置不该连带交出
 * 用户配过的内网域名清单）、读不到就当没有。判据与 `sameOriginNoRewrite` 共用一份，
 * 免得「保存侧记什么」与「界面列什么」漂成两套口径。
 */

/**
 * 从一批规则里挑出「值得记为目标环境」的 origin（最近优先、已去重）
 *
 * 只挑真正换过环境的那些：目标解析不出（含 `{{变量}}`）、为空（Mock 规则只注入响应）、
 * 或与自己的匹配来源同 origin（合法的纯头注入）都不算「用户想去的环境」。
 */
export function distinctTargetOrigins(rules: ProxyRule[]): string[] {
  const origins: string[] = [];
  for (const rule of rules) {
    const target = apiOriginOf(rule.targetUrl);
    if (!target || sameOriginNoRewrite(rule)) continue;
    if (!origins.includes(target)) origins.push(target);
  }
  return origins;
}

/**
 * 把刚落盘的规则并进现有候选
 * @param incoming 上一份候选（最近优先）
 * @param saved 这一次保存的规则
 */
export function mergeRecentTargets(incoming: string[], saved: ProxyRule[]): string[] {
  return [...distinctTargetOrigins(saved), ...incoming]
    .filter((origin, index, all) => !!origin && all.indexOf(origin) === index)
    .slice(0, MAX_RECENT_TARGETS);
}

/**
 * 读回来的候选收口：非数组当空、只留非空字符串、去重（先到先得）、按上限截
 *
 * 与 `configRules()` 同一族口径：`chrome.storage.local` 里的那个键可能是手改过的原文，
 * 而候选坏了的正确表现是「没有候选」，不是让表单报错。去重放在这里是因为下拉的 key 用它，
 * 一个重复项就是一次 `Duplicate attribute` 级别的渲染事故。
 */
export function sanitizeRecentTargets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .filter((origin, index, all) => all.indexOf(origin) === index)
    .slice(0, MAX_RECENT_TARGETS);
}
