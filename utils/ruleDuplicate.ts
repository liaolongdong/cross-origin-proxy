import type { ProxyRule } from '@/utils/types';

export type DuplicateRuleInput = Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 基于已有规则创建副本数据（用于「复制规则」操作）。
 * 副本默认停用，名称追加 suffix，所有可选字段（headerOverrides、requestBodyOverride、
 * responseOverrides、mockResponse、delayMs、blocked、retryCount、retryDelay）完整保留，
 * 嵌套对象使用 structuredClone 深拷贝以避免与原规则共享引用。
 */
export function buildDuplicateRuleData(rule: ProxyRule, copySuffix: string): DuplicateRuleInput {
  return {
    name: `${rule.name}${copySuffix}`,
    matchType: rule.matchType,
    matchPattern: rule.matchPattern,
    targetUrl: rule.targetUrl,
    priority: rule.priority,
    enabled: false,
    headerOverrides: rule.headerOverrides ? structuredClone(rule.headerOverrides) : undefined,
    requestBodyOverride: rule.requestBodyOverride,
    responseOverrides: rule.responseOverrides ? structuredClone(rule.responseOverrides) : undefined,
    mockResponse: rule.mockResponse ? structuredClone(rule.mockResponse) : undefined,
    delayMs: rule.delayMs,
    blocked: rule.blocked,
    retryCount: rule.retryCount,
    retryDelay: rule.retryDelay,
  };
}
