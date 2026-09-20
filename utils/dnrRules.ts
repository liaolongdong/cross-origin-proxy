/**
 * DNR 规则转换（纯函数模块，便于单元测试）
 *
 * 将「简单规则」（无 headerOverrides）转换为 declarativeNetRequest 动态重定向规则。
 * 统一使用 regexFilter + regexSubstitution：
 * - 旧实现用 urlFilter 搭配 regexSubstitution 的 \1 引用，DNR 规范要求
 *   regexSubstitution 必须配合 regexFilter 的捕获组，因此重定向从未生效（已修复）
 * - 三种 matchType 分别转换，语义与 utils/urlMatcher.ts 的 rewriteUrl 保持一致
 *
 * 注意：此模块不调用 chrome API（枚举值用字面量断言），可在 Node 环境直接测试。
 */

import type { ProxyRule } from '@/utils/types';
import { isSimpleRule, normalizePriority } from '@/utils/urlMatcher';
import { DNR_RULE_ID_PREFIX, DNR_MAX_PRIORITY } from '@/utils/constants';

/** DNR 命中的资源类型（页面主/子文档、XHR、静态资源等） */
const DNR_RESOURCE_TYPES = [
  'xmlhttprequest',
  'main_frame',
  'sub_frame',
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'other',
] as chrome.declarativeNetRequest.ResourceType[];

/** 转义 RE2 正则特殊字符（* 除外，由调用方单独处理） */
function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构建 regexFilter
 * - wildcard：转义后每个 * 变为捕获组 (.*)，整串锚定 ^...$
 * - prefix：锚定前缀 + 捕获剩余部分
 * - regex：用户正则原样使用（需 RE2 兼容，由 dnrManager 侧校验）
 */
export function buildRegexFilter(rule: ProxyRule): string {
  switch (rule.matchType) {
    case 'wildcard':
      return `^${escapeRegex(rule.matchPattern).replace(/\*/g, '(.*)')}$`;
    case 'prefix':
      // 前缀模式中的 * 不是通配符：SW 侧 matchRule 用 startsWith 按字面量比对。
      // escapeRegex 刻意保留 *，此处必须补转义，否则 RE2 会把它当量词
      // （"https://fat.com/a*b" 命中 "https://fat.com/aaab"），两通道命中集合不一致。
      return `^${escapeRegex(rule.matchPattern).replace(/\*/g, '\\*')}(.*)`;
    case 'regex':
      return rule.matchPattern;
  }
}

/**
 * 构建 regexSubstitution（与 rewriteUrl 的重写语义一致）
 * - wildcard：目标 URL + 末尾 * 捕获的部分（引用最后一个捕获组）；
 *   模式以 /* 结尾时补回分隔斜杠
 * - prefix：目标 URL + 剩余部分（\1）
 * - regex：目标 URL 中的 $n 引用转为 DNR 的 \n 语法
 */
export function buildRegexSubstitution(rule: ProxyRule): string {
  const target = rule.targetUrl.replace(/\/$/, '');
  switch (rule.matchType) {
    case 'wildcard': {
      const starCount = (rule.matchPattern.match(/\*/g) || []).length;
      if (starCount === 0) return target;
      const patternBase = rule.matchPattern.replace(/\*$/, '');
      const separator = rule.matchPattern.endsWith('*') && patternBase.endsWith('/') ? '/' : '';
      return `${target}${separator}\\${starCount}`;
    }
    case 'prefix': {
      // 与 rewriteUrl 的 prefix 分支同源：模式以 / 结尾时斜杠已被 regexFilter 消耗，
      // 替换串需补回分隔符，否则拼出 "https://uat.com/v2users"
      const separator = rule.matchPattern.endsWith('/') ? '/' : '';
      return `${target}${separator}\\1`;
    }
    case 'regex':
      return rule.targetUrl.replace(/\$(\d)/g, '\\$1');
  }
}

/**
 * 统计 regexFilter 中的捕获组数量（转义感知）
 * - `(` 后不跟 `?` → 捕获组
 * - `(?<name>` → 命名捕获组（计入）
 * - `(?:` `(?=` `(?!` `(?<=` `(?<!` 及 `(?` 其他构造 → 非捕获（不计入）
 * - `\(` 为转义的字面量括号，不产生捕获组
 */
export function countCaptureGroups(regexFilter: string): number {
  let count = 0;
  for (let i = 0; i < regexFilter.length; i++) {
    const ch = regexFilter[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch !== '(') continue;
    if (regexFilter[i + 1] !== '?') {
      count++;
      continue;
    }
    if (regexFilter[i + 2] === '<' && /[A-Za-z]/.test(regexFilter[i + 3] || '')) {
      count++;
    }
  }
  return count;
}

/**
 * 提取 regexSubstitution 中最大的捕获组引用编号（`\0`-`\9`）
 * `\\` 为转义的字面量反斜杠，其后的数字不构成引用；无引用返回 -1
 */
export function maxSubstitutionRef(substitution: string): number {
  let max = -1;
  for (let i = 0; i < substitution.length; i++) {
    if (substitution[i] !== '\\') continue;
    const next = substitution[i + 1];
    if (next === undefined) break;
    i++;
    if (next >= '0' && next <= '9') {
      max = Math.max(max, Number(next));
    }
  }
  return max;
}

/**
 * 校验替换串的捕获引用是否越界（引用编号不得超过捕获组数量）
 * DNR 对越界引用会拒绝整批规则，需在同步前过滤
 */
export function isSubstitutionValid(regexFilter: string, substitution: string): boolean {
  const maxRef = maxSubstitutionRef(substitution);
  if (maxRef < 0) return true;
  return maxRef <= countCaptureGroups(regexFilter);
}

/**
 * 业务优先级 → DNR 优先级
 * 业务语义为数值越小越先匹配，DNR 为数值越大越优先，需反转。
 * 入参先归一化：`NaN` 会被 Chrome 判定为非法 priority，代价是**整批**
 * `updateDynamicRules` 被拒（所有简单规则同时失效），而非只丢一条。
 * 最后取整：DNR 的 `priority` 只接受整数，一个小数（输入框敲出来的 2.5、
 * 导入文件里的 1.5）同样是整批拒绝，而不是丢一条规则。
 * 两端钳制到 `[1, DNR_MAX_PRIORITY]`：区间外同样是整批拒绝，而负数优先级
 * （只有导入文件与手改的 storage 数据能给）恰好会翻过上限。
 */
export function toDnrPriority(priority: number): number {
  return Math.min(DNR_MAX_PRIORITY, Math.max(1, Math.round(1000 - normalizePriority(priority))));
}

/**
 * 将当前应生效的简单规则批量转换为 DNR 动态规则
 *
 * `proxyEnabled` 是总开关：DNR 规则装在浏览器网络层、不经扩展 JS，因此后台通道的
 * 开关判断（`proxyHandler` 里的 `config.enabled`）拦不住它们。总开关关闭时必须
 * 编译出空规则集，否则「关掉代理」后简单规则仍在重定向流量。
 * @returns rules 为 DNR 规则数组；idMap 为「DNR 规则 id → 代理规则」映射（命中统计用）
 */
export function buildDnrRules(
  rules: ProxyRule[],
  proxyEnabled: boolean,
): {
  rules: chrome.declarativeNetRequest.Rule[];
  idMap: Map<number, { ruleId: string; ruleName: string }>;
} {
  const simpleRules = proxyEnabled ? rules.filter(r => r.enabled && isSimpleRule(r)) : [];
  const idMap = new Map<number, { ruleId: string; ruleName: string }>();

  const dnrRules = simpleRules.map((rule, index) => {
    const dnrId = DNR_RULE_ID_PREFIX + index;
    idMap.set(dnrId, { ruleId: rule.id, ruleName: rule.name });

    const dnrRule: chrome.declarativeNetRequest.Rule = {
      id: dnrId,
      priority: toDnrPriority(rule.priority),
      action: {
        type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
        redirect: {
          regexSubstitution: buildRegexSubstitution(rule),
        },
      },
      condition: {
        regexFilter: buildRegexFilter(rule),
        resourceTypes: DNR_RESOURCE_TYPES,
      },
    };
    return dnrRule;
  });

  return { rules: dnrRules, idMap };
}
