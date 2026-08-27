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
import { isSimpleRule } from '@/utils/urlMatcher';
import { DNR_RULE_ID_PREFIX } from '@/utils/constants';

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
      return `^${escapeRegex(rule.matchPattern)}(.*)`;
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
    case 'prefix':
      return `${target}\\1`;
    case 'regex':
      return rule.targetUrl.replace(/\$(\d)/g, '\\$1');
  }
}

/**
 * 业务优先级 → DNR 优先级
 * 业务语义为数值越小越先匹配，DNR 为数值越大越优先，需反转（下限 1）
 */
export function toDnrPriority(priority: number): number {
  return Math.max(1, 1000 - priority);
}

/**
 * 将启用中的简单规则批量转换为 DNR 动态规则
 * @returns rules 为 DNR 规则数组；idMap 为「DNR 规则 id → 代理规则」映射（命中统计用）
 */
export function buildDnrRules(rules: ProxyRule[]): {
  rules: chrome.declarativeNetRequest.Rule[];
  idMap: Map<number, { ruleId: string; ruleName: string }>;
} {
  const simpleRules = rules.filter(r => r.enabled && isSimpleRule(r));
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
