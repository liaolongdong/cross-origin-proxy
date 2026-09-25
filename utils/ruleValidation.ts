import type { ProxyRule } from '@/utils/types';

/**
 * `matchType` 的合法取值：导入侧与恢复点侧共用这一份
 *
 * 下面这几份是**并列**的清单，运行时互不引用：`utils/types.ts` 的联合类型、表单那组 radio
 * （`RuleFormDialog.vue`）、表格的 tag 类型与案名两套映射（`RuleTable.vue`）、筛选下拉的三个选项
 * （`SearchFilterBar.vue`），再加中英两套案名键。加一种匹配方式得一次改齐，这七处对不上由
 * `tests/ruleValidation.test.ts` 判红。两处不在契约射程里：表单那组 `matchPattern` placeholder（少一项
 * 只是没有示例文本）与 MAIN world 那份内联类型（它自包含、与 `utils/types.ts` 没有编译期连接，
 * 认不出的取值在 `matchUrl` 落到 `default: return false`——页面侧永不匹配，但也不会报错）。
 */
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
 * 请求头清洗与 id 重生成各有归属，不在这里顺手做。另外「字段在」不等于「字段有内容」——
 * 空串算在，表单侧的必填是另一道闸（只拦得住界面里保存的那一次），这里放开是因为拦空串会
 * 改变导入与回退留下的条数。
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
