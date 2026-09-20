import type { ExportData, ProxyRule, RequestLogEntry } from '@/utils/types';

/**
 * 导出脱敏（「分享模式」这一个勾选同时管着两条导出）
 *
 * 两份导出常被贴进群里或工单让同事复现环境，而凭据的落脚点不同，剔的东西也就不同：
 * - `sanitizeExportData`（配置）：规则里的请求头覆盖、响应头覆盖与查询参数覆盖。
 * - `sanitizeExportedLogs`（HAR）：逐条日志的**真实**请求/响应头。
 * 两者共用同一份敏感名判据（`isSensitiveHeaderName` / `isSensitiveQueryName`），
 * 差异只在 HAR 不碰查询参数与正文——URL 与 body 是抓包能被读懂的全部意义。
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

/**
 * 摘掉导出配置里所有可能承载凭据的请求头 / 响应头 / 查询参数
 *
 * 整条摘掉而不塞占位值：导入方拿到的规则少了这一项，行为退化成「不覆盖该头」，
 * 比一个假 token 被服务端 401 更难踩坑。有意不碰请求体 / Mock 响应体 / `bodyRaw`——
 * 它们本身就是规则要交付的内容，抹掉等于把规则改废。
 * 纯函数，不修改入参（同份配置可能还要继续用于界面展示）。
 */
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

/** 日志脱敏结果：新数组 + 被摘掉的头条目数 */
export interface SanitizeLogsResult {
  logs: RequestLogEntry[];
  removedCount: number;
}

/**
 * 摘掉导出日志里的凭据头（HAR 导出共用「分享模式」这一开关）
 *
 * HAR 落盘的是**真实站点的请求与响应头**：日志里的 `Cookie` / `Authorization` 就是用户当时
 * 那个会话的凭据，一次「把 HAR 贴进工单」就等于把会话交出去。判据与配置导出同源
 * （{@link isSensitiveHeaderName}），两条导出路径不会出现一边脱敏一边漏。
 *
 * 与配置导出同样的边界：不碰正文（`requestBody` / `responseBody` 是 HAR 的排障主体，
 * 正文里的 token 需要用户自行留空），也不碰 URL（截断 URL 会打断「这条请求打到哪了」的追溯）。
 * 纯函数：返回新数组与新对象，不改入参（同一份日志还要继续喂界面与存储）。
 */
export function sanitizeExportedLogs(logs: RequestLogEntry[]): SanitizeLogsResult {
  let removedCount = 0;
  const sanitized = logs.map(log => {
    const requestHeaders = sanitizeMap(log.requestHeaders, SENSITIVE_HEADER_NAMES);
    const responseHeaders = sanitizeMap(log.responseHeaders, SENSITIVE_HEADER_NAMES);
    removedCount += requestHeaders.removed + responseHeaders.removed;
    if (requestHeaders.removed + responseHeaders.removed === 0) return log;

    const next: RequestLogEntry = { ...log };
    if (next.requestHeaders) {
      if (requestHeaders.value) next.requestHeaders = requestHeaders.value;
      else delete next.requestHeaders;
    }
    if (next.responseHeaders) {
      if (responseHeaders.value) next.responseHeaders = responseHeaders.value;
      else delete next.responseHeaders;
    }
    return next;
  });
  return { logs: sanitized, removedCount };
}
