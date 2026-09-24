import { cloneRule } from '@/utils/ruleClone';
import type { ProxyRule } from '@/utils/types';

export type DuplicateRuleInput = Omit<ProxyRule, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 基于已有规则创建副本数据（用于「复制规则」操作）。
 * 副本默认停用，名称追加 suffix，所有可选字段（methods、queryOverrides、headerOverrides、
 * requestBodyOverride、responseOverrides、mockResponse、delayMs、blocked、retryCount、
 * retryDelay）完整保留；整条规则先经 `cloneRule` 脱离响应式再深拷贝，不与原规则共享引用。
 */
export function buildDuplicateRuleData(rule: ProxyRule, copySuffix: string): DuplicateRuleInput {
  const src = cloneRule(rule);
  return {
    name: `${src.name}${copySuffix}`,
    matchType: src.matchType,
    matchPattern: src.matchPattern,
    targetUrl: src.targetUrl,
    priority: src.priority,
    enabled: false,
    methods: src.methods,
    queryOverrides: src.queryOverrides,
    headerOverrides: src.headerOverrides,
    requestBodyOverride: src.requestBodyOverride,
    responseOverrides: src.responseOverrides,
    mockResponse: src.mockResponse,
    delayMs: src.delayMs,
    blocked: src.blocked,
    retryCount: src.retryCount,
    retryDelay: src.retryDelay,
  };
}
