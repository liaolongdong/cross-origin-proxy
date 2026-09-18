import type { ExportData, ProxyRule } from '@/utils/types';

/**
 * 配置导出脱敏（分享模式的实现）
 *
 * 配置文件常被贴进群里或工单让同事复现环境，而规则里的请求头覆盖、响应头覆盖和查询参数
 * 覆盖正是凭据最常见的落脚点（`Authorization: Bearer …`、`Cookie: session=…`）。
 * 导出前把这些条目的**值**整条摘掉，分享就不再等于泄露 token；导入方拿到的规则少了这一项，
 * 行为退化成「不覆盖该头」，比塞一个占位值被服务端 401 更难踩坑。
 *
 * 有意不处理请求体 / Mock 响应体 / `bodyRaw`：它们本身就是规则要交付的内容，
 * 抹掉等于把规则改废，需要脱敏时请在表单里自行留空。
 *
 * 纯函数，不修改入参（同份配置可能还要继续用于界面展示）。
 */

/**
 * 可能承载凭据的头名。整名精确匹配（不做子串判断）：
 * `x-token-refresh-interval` 这类计数头不该被误删，而攻击者能用的头名也就是这些标准写法。
 */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-access-token',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'token',
  'access-token',
  'auth',
  'bearer',
  'secret',
]);

/** 可能承载凭据的查询参数名（同上面一样按整名比较） */
const SENSITIVE_QUERY_NAMES = new Set([
  'token',
  'access_token',
  'accesstoken',
  'api_key',
  'apikey',
  'key',
  'auth',
  'authorization',
  'secret',
  'code',
  'password',
]);

function isSensitiveName(name: string, names: Set<string>): boolean {
  return names.has(name.trim().toLowerCase());
}

/** 该头名是否会带出凭据 */
export function isSensitiveHeaderName(name: string): boolean {
  return isSensitiveName(name, SENSITIVE_HEADER_NAMES);
}

/** 该查询参数名是否会带出凭据 */
export function isSensitiveQueryName(name: string): boolean {
  return isSensitiveName(name, SENSITIVE_QUERY_NAMES);
}

interface MapSanitize {
  /** 清洗后的映射；已无条目时返回 `undefined`，让字段回到「未配置」而不是空对象 */
  value?: Record<string, string>;
  removed: number;
}

function sanitizeMap(source: Record<string, string> | undefined, names: Set<string>): MapSanitize {
  if (!source) return { removed: 0 };
  const kept: Record<string, string> = {};
  let removed = 0;
  for (const [key, value] of Object.entries(source)) {
    if (isSensitiveName(key, names)) removed++;
    else kept[key] = value;
  }
  return { value: Object.keys(kept).length > 0 ? kept : undefined, removed };
}

function sanitizeRule(rule: ProxyRule): { rule: ProxyRule; removed: number } {
  const headers = sanitizeMap(rule.headerOverrides, SENSITIVE_HEADER_NAMES);
  const queries = sanitizeMap(rule.queryOverrides, SENSITIVE_QUERY_NAMES);
  const responseHeaders = sanitizeMap(rule.responseOverrides?.headers, SENSITIVE_HEADER_NAMES);
  const removed = headers.removed + queries.removed + responseHeaders.removed;
  if (removed === 0) return { rule, removed };

  const next: ProxyRule = { ...rule };
  if (next.headerOverrides) {
    if (headers.value) next.headerOverrides = headers.value;
    else delete next.headerOverrides;
  }
  if (next.queryOverrides) {
    if (queries.value) next.queryOverrides = queries.value;
    else delete next.queryOverrides;
  }
  if (rule.responseOverrides?.headers) {
    const rest = { ...rule.responseOverrides };
    if (responseHeaders.value) rest.headers = responseHeaders.value;
    else delete rest.headers;
    next.responseOverrides = rest;
  }
  return { rule: next, removed };
}

/** 导出的脱敏结果：新配置 + 被摘掉的敏感条目数 */
export interface SanitizeResult {
  data: ExportData;
  removedCount: number;
}

/** 摘掉导出配置里所有可能承载凭据的请求头 / 响应头 / 查询参数 */
export function sanitizeExportData(data: ExportData): SanitizeResult {
  let removedCount = 0;
  const rules = data.config.rules.map(rule => {
    const result = sanitizeRule(rule);
    removedCount += result.removed;
    return result.rule;
  });
  return {
    data: { ...data, config: { ...data.config, rules } },
    removedCount,
  };
}
