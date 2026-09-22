import type { ProxyRule } from '@/utils/types';

/** `matchType` 的合法取值：表单、导入与恢复点共用这一份白名单 */
const MATCH_TYPES: readonly string[] = ['wildcard', 'prefix', 'regex'];

/**
 * 结构判据：一条未知数据能不能被安全地当成规则写进 `proxy_config`
 *
 * 两个调用方，同一份判据，必须同源：
 * - 导入文件（`normalizeImportedRules`）——文件是不可信输入，缺字段的规则落库后会让 DNR 同步
 *   与拦截器拿到 `undefined` 的 pattern；
 * - 配置恢复点（`sanitizeConfigHistory`）——`storage.local` 里的历史快照同样是可被手改的数据，
 *   回退这一步等于把它重新变成生效配置。
 *
 * 判据只到「字段在不在、类型对不对、枚举合不合法」这一层：优先级/时间戳的 NaN 归一化、
 * 请求头清洗与 id 重生成各有归属，不在这里顺手做。
 */
export function isValidRuleShape(rule: unknown): rule is ProxyRule {
  if (!rule || typeof rule !== 'object') return false;
  const r = rule as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.matchPattern === 'string' &&
    typeof r.targetUrl === 'string' &&
    MATCH_TYPES.includes(r.matchType as string)
  );
}
