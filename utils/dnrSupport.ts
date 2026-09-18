/**
 * DNR 通道可应用性诊断
 *
 * `dnrManager` 同步前会跳过「DNR 无法应用」的规则（RE2 不兼容的正则、越界的捕获引用），
 * 以免一条非法规则让 `updateDynamicRules` 整批被拒。被跳过的规则如果本应走 DNR 通道
 * （即 `isSimpleRule` 为真），就同时不会被 SW 通道接管——拦截器只收 `!isSimpleRule` 的规则，
 * 于是它在用户界面上是「已启用」，实际对流量零作用。
 *
 * 本模块把同一个判定搬到前端可读的地方，用于在规则列表、URL 测试弹窗里显式告警。
 * **只诊断、不改分流**：规则该走哪条通道仍然只由 `isSimpleRule` 决定。
 */

import type { ProxyRule } from '@/utils/types';
import { isSimpleRule } from '@/utils/urlMatcher';
import { buildRegexFilter, buildRegexSubstitution, isSubstitutionValid } from '@/utils/dnrRules';

/** 规则被 DNR 同步跳过的原因 */
export type DnrSkipReason = 'regexUnsupported' | 'substitutionInvalid';

/**
 * 该规则是否由 DNR 通道承载（因此才会被同步阶段的过滤跳过）
 *
 * 刻意忽略代理总开关：关闭代理时规则同样会被编译出来再整体清空，
 * 告警要一直可见，否则用户「打开代理」才发现规则是死的。
 */
export function usesDnrChannel(rule: ProxyRule): boolean {
  return rule.enabled && isSimpleRule(rule);
}

/**
 * 正则能否被 DNR 的 RE2 引擎接受
 *
 * 与 `dnrManager` 侧同语义：API 抛错也按「不支持」处理——那种情况下后台同样会跳过该规则，
 * 诊断结果必须与引擎的实际行为一致，否则会漏报一条已经失效的规则。
 */
async function isRe2Supported(regex: string): Promise<boolean> {
  try {
    const { isSupported } = await chrome.declarativeNetRequest.isRegexSupported({ regex });
    return isSupported;
  } catch {
    return false;
  }
}

/**
 * 判定单条规则是否会被 DNR 同步跳过
 * @returns `null` 表示可正常应用；否则给出原因
 */
export async function checkDnrRule(rule: ProxyRule): Promise<DnrSkipReason | null> {
  if (!usesDnrChannel(rule)) return null;
  if (rule.matchType === 'regex' && !(await isRe2Supported(rule.matchPattern))) return 'regexUnsupported';
  if (!isSubstitutionValid(buildRegexFilter(rule), buildRegexSubstitution(rule))) return 'substitutionInvalid';
  return null;
}

/**
 * 批量诊断：返回「规则 id → 被 DNR 跳过的原因」
 *
 * 只处理走 DNR 通道的候选规则，其余（复杂规则、停用规则）不参与，避免误报。
 */
export async function findDnrSkippedRules(rules: ProxyRule[]): Promise<Map<string, DnrSkipReason>> {
  const entries = await Promise.all(rules.map(async rule => [rule.id, await checkDnrRule(rule)] as const));
  return new Map(entries.filter((entry): entry is [string, DnrSkipReason] => entry[1] !== null));
}
