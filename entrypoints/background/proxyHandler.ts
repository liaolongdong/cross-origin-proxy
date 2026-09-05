import { findMatchingRule, rewriteUrl, applyQueryOverrides } from '@/utils/urlMatcher';
import { getProxyConfig, addRequestLog, getRequestLogs } from '@/utils/storage';
import { generateId } from '@/utils/generateId';
import { AUTO_OFF_ALARM } from '@/utils/constants';
import { logger } from '@/utils/logger';
import type { ProxyStatus, RequestLogEntry, ResponseOverrides, MockCondition, DnrHitStat } from '@/utils/types';

const MAX_BODY_SIZE = 10 * 1024 * 1024;

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;

// ─── SW 通道命中统计 ──────────────────────────────────────────────────────────

const swHitStats = new Map<string, { ruleId: string; ruleName: string; hitCount: number }>();

export function getSwHitStats(): DnrHitStat[] {
  return Array.from(swHitStats.values())
    .map(({ ruleId, ruleName, hitCount }) => ({ ruleId, ruleName, hitCount }))
    .sort((a, b) => b.hitCount - a.hitCount);
}

export function resetSwHitStats(): void {
  swHitStats.clear();
}

function trackRuleHit(ruleId: string, ruleName: string): void {
  const existing = swHitStats.get(ruleId);
  if (existing) {
    existing.hitCount++;
  } else {
    swHitStats.set(ruleId, { ruleId, ruleName, hitCount: 1 });
  }
}

// ─── 重试判定 ─────────────────────────────────────────────────────────────────

/**
 * 判断错误是否可重试：5xx 状态码、超时（AbortError）、网络错误（TypeError）
 */
export function isRetryableError(error: unknown, status?: number): boolean {
  if (status !== undefined && status >= 500) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (error instanceof TypeError) return true;
  return false;
}

// ─── 条件 Mock 匹配 ───────────────────────────────────────────────────────────

/**
 * 判断请求是否满足单个 Mock 条件（AND 逻辑）
 */
export function matchesMockCondition(url: string, method: string, condition: MockCondition): boolean {
  if (condition.matchUrl) {
    try {
      if (!new RegExp(condition.matchUrl).test(url)) return false;
    } catch {
      return false;
    }
  }
  if (condition.matchMethod) {
    if (method.toUpperCase() !== condition.matchMethod.toUpperCase()) return false;
  }
  if (condition.matchQuery) {
    try {
      const parsed = new URL(url);
      for (const [key, value] of Object.entries(condition.matchQuery)) {
        if (parsed.searchParams.get(key) !== value) return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

// ─── Header 校验 ──────────────────────────────────────────────────────────────

function isValidHeaderEntry(key: string, value: string): boolean {
  return HEADER_NAME_RE.test(key) && !/[\r\n]/.test(value);
}

/**
 * 过滤页面传入的请求头：跳过非法条目（非法名称或含换行的值），
 * 避免个别脏头部导致整个代理请求被拒绝
 */
function filterIncomingHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && isValidHeaderEntry(key, value)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 校验规则配置的请求头覆盖：任一非法即整体拒绝（返回 null），
 * 规则由用户直接编辑，应报错促其修正而非静默丢弃
 */
function validateRuleHeaders(headers: Record<string, string>): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || !isValidHeaderEntry(key, value)) return null;
    result[key] = value;
  }
  return result;
}

// ─── 响应覆盖 ─────────────────────────────────────────────────────────────────

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function applyResponseOverrides(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  body: string,
  isBase64: boolean,
  overrides: ResponseOverrides,
): { status: number; statusText: string; headers: Record<string, string>; body: string; isBase64: boolean } {
  const result = { status, statusText, headers: { ...headers }, body, isBase64 };

  if (overrides.status !== undefined) {
    // 状态码必须在可构造 Response 的合法区间（200-599），
    // 否则前端无法构造响应会回退原生请求，覆盖静默失效
    result.status = Math.min(599, Math.max(200, Math.trunc(overrides.status) || 200));
  }
  if (overrides.statusText !== undefined) {
    result.statusText = overrides.statusText;
  }
  if (overrides.headers) {
    for (const [key, value] of Object.entries(overrides.headers)) {
      if (HEADER_NAME_RE.test(key) && !/[\r\n]/.test(value)) {
        result.headers[key] = value;
      }
    }
  }

  if (overrides.bodyRaw !== undefined) {
    result.body = overrides.bodyRaw;
    result.isBase64 = false;
  } else if (overrides.bodyReplacements && !isBase64) {
    try {
      const json = JSON.parse(body);
      for (const [path, value] of Object.entries(overrides.bodyReplacements)) {
        setByPath(json, path, value);
      }
      result.body = JSON.stringify(json);
    } catch {
      logger.warn('Response body is not valid JSON, skipping bodyReplacements');
    }
  }

  return result;
}

// ─── 代理请求主逻辑 ───────────────────────────────────────────────────────────

export async function handleProxyRequest(data: {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | null;
}): Promise<{
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  isBase64: boolean;
}> {
  const startTime = Date.now();
  const config = await getProxyConfig();

  if (!config.enabled) {
    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Proxy Bypass',
      headers: {},
      body: 'Proxy is disabled',
      isBase64: false,
    };
  }

  const rule = findMatchingRule(data.url, config.rules, data.method);
  if (!rule) {
    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Proxy Bypass',
      headers: {},
      body: 'No matching rule',
      isBase64: false,
    };
  }

  // 记录 SW 通道命中
  trackRuleHit(rule.id, rule.name);

  // ─── 请求阻断 ─────────────────────────────────────────────────────────────
  if (rule.blocked) {
    logger.info(`Blocked: ${data.url} (rule: ${rule.name})`);
    const logEntry: RequestLogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      ruleId: rule.id,
      ruleName: rule.name,
      originalUrl: data.url,
      proxiedUrl: data.url,
      method: data.method,
      status: 0,
      error: 'Request blocked by rule',
      proxyType: 'sw',
    };
    await addRequestLog(logEntry);
    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Blocked',
      headers: {},
      body: 'Request blocked by proxy rule',
      isBase64: false,
    };
  }

  // ─── Mock 响应（含条件化 Mock）─────────────────────────────────────────────
  if (rule.mockResponse) {
    let mockBody = rule.mockResponse.body;
    let mockStatus = rule.mockResponse.status ?? 200;
    let mockContentType = rule.mockResponse.contentType ?? 'application/json';

    // 条件化 Mock：首个命中的条件覆盖默认值
    if (rule.mockResponse.conditions?.length) {
      for (const condition of rule.mockResponse.conditions) {
        if (matchesMockCondition(data.url, data.method, condition)) {
          mockBody = condition.body;
          mockStatus = condition.status ?? mockStatus;
          mockContentType = condition.contentType ?? mockContentType;
          break;
        }
      }
    }

    // 状态码必须在可构造 Response 的合法区间（200-599），否则前端会回退原生请求使 Mock 失效
    mockStatus = Math.min(599, Math.max(200, Math.trunc(mockStatus) || 200));

    const mockHeaders: Record<string, string> = { 'content-type': mockContentType };
    logger.info(`Mock: ${data.url} → ${mockStatus} (rule: ${rule.name})`);

    if (rule.delayMs) {
      await new Promise(resolve => setTimeout(resolve, rule.delayMs));
    }

    const logEntry: RequestLogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      ruleId: rule.id,
      ruleName: rule.name,
      originalUrl: data.url,
      proxiedUrl: `mock://${rule.name}`,
      method: data.method,
      status: mockStatus,
      duration: Date.now() - startTime,
      proxyType: 'sw',
      responseHeaders: mockHeaders,
      responseBody: mockBody,
    };
    await addRequestLog(logEntry);

    return {
      requestId: data.requestId,
      status: mockStatus,
      statusText: 'Mock',
      headers: mockHeaders,
      body: mockBody,
      isBase64: false,
    };
  }

  // 先按匹配类型重写 URL，再对最终地址追加/覆盖查询参数（仅真实代理分支）
  const targetUrl = applyQueryOverrides(rewriteUrl(data.url, rule), rule.queryOverrides);
  logger.info(`Proxying: ${data.url} → ${targetUrl}`);

  // ─── 准备请求参数（重试循环外，避免重复计算）────────────────────────────────
  // 传入头宽容过滤（跳过个别非法条目）；规则头严格校验（非法则拒绝并提示修正）
  const sanitizedIncoming = filterIncomingHeaders(data.headers);

  const sanitizedOverrides = rule.headerOverrides ? validateRuleHeaders(rule.headerOverrides) : {};
  if (rule.headerOverrides && !sanitizedOverrides) {
    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Invalid Rule Headers',
      headers: {},
      body: 'Rule contains invalid header override',
      isBase64: false,
    };
  }

  const fetchOptions: RequestInit = {
    method: data.method,
    headers: {
      ...sanitizedIncoming,
      ...(sanitizedOverrides || {}),
    },
  };

  // GET/HEAD 不可携带 body（fetch 会直接抛 TypeError 使代理失败）；
  // method 可能是页面传入的原始小写形式，比较前需归一化
  const method = data.method.toUpperCase();
  const canHaveBody = method !== 'GET' && method !== 'HEAD';

  if (data.body != null && data.body !== '' && canHaveBody) {
    if (data.body.length > MAX_BODY_SIZE) {
      return {
        requestId: data.requestId,
        status: 0,
        statusText: 'Body Too Large',
        headers: {},
        body: `Request body exceeds ${MAX_BODY_SIZE} bytes`,
        isBase64: false,
      };
    }
    fetchOptions.body = data.body;
  }

  if (rule.requestBodyOverride !== undefined && canHaveBody) {
    fetchOptions.body = rule.requestBodyOverride;
  }

  if (rule.delayMs) {
    await new Promise(resolve => setTimeout(resolve, rule.delayMs));
  }

  // ─── 重试循环 ─────────────────────────────────────────────────────────────
  const maxRetries = rule.retryCount ?? 0;
  const retryDelay = rule.retryDelay ?? 1000;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      logger.info(`Retry ${attempt}/${maxRetries}: ${data.url} (rule: ${rule.name})`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(targetUrl, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      // 5xx 且还有重试次数：重试
      if (response.status >= 500 && attempt < maxRetries) {
        lastError = `Server error ${response.status}`;
        continue;
      }

      // Read response
      const contentType = response.headers.get('content-type') || '';
      let responseBody: string;
      let isBase64 = false;

      if (contentType.includes('application/json') || contentType.includes('text/')) {
        responseBody = await response.text();
      } else {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const CHUNK_SIZE = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
        }
        responseBody = btoa(binary);
        isBase64 = true;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let finalStatus = response.status;
      let finalStatusText = response.statusText;
      let finalHeaders = responseHeaders;
      let finalBody = responseBody;
      let finalIsBase64 = isBase64;

      if (rule.responseOverrides) {
        const overridden = applyResponseOverrides(
          finalStatus,
          finalStatusText,
          finalHeaders,
          finalBody,
          finalIsBase64,
          rule.responseOverrides,
        );
        finalStatus = overridden.status;
        finalStatusText = overridden.statusText;
        finalHeaders = overridden.headers;
        finalBody = overridden.body;
        finalIsBase64 = overridden.isBase64;
      }

      const logEntry: RequestLogEntry = {
        id: generateId(),
        timestamp: Date.now(),
        ruleId: rule.id,
        ruleName: rule.name,
        originalUrl: data.url,
        proxiedUrl: targetUrl,
        method: data.method,
        status: finalStatus,
        duration: Date.now() - startTime,
        proxyType: 'sw',
        requestHeaders: sanitizedIncoming,
        requestBody: typeof fetchOptions.body === 'string' ? fetchOptions.body : undefined,
        responseHeaders: finalHeaders,
        responseBody: finalIsBase64 ? undefined : finalBody,
        responseIsBase64: finalIsBase64 || undefined,
      };
      await addRequestLog(logEntry);

      return {
        requestId: data.requestId,
        status: finalStatus,
        statusText: finalStatusText,
        headers: finalHeaders,
        body: finalBody,
        isBase64: finalIsBase64,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      lastError = isTimeout ? 'Request timeout (30s)' : errorMessage;

      if (isRetryableError(error) && attempt < maxRetries) {
        continue;
      }
      break;
    }
  }

  // 所有重试耗尽
  logger.error('Proxy request failed after retries:', lastError);

  const logEntry: RequestLogEntry = {
    id: generateId(),
    timestamp: Date.now(),
    ruleId: rule.id,
    ruleName: rule.name,
    originalUrl: data.url,
    proxiedUrl: targetUrl,
    method: data.method,
    duration: Date.now() - startTime,
    error: lastError,
    proxyType: 'sw',
  };
  await addRequestLog(logEntry);

  return {
    requestId: data.requestId,
    status: 0,
    statusText: 'Proxy Error',
    headers: {},
    body: lastError ?? 'Unknown error',
    isBase64: false,
  };
}

// ─── 代理状态 ─────────────────────────────────────────────────────────────────

export async function getProxyStatus(): Promise<ProxyStatus> {
  const config = await getProxyConfig();
  const logs = await getRequestLogs();

  const todayTimestamp = new Date();
  todayTimestamp.setHours(0, 0, 0, 0);
  const todayTs = todayTimestamp.getTime();

  let todayRequestCount = 0;
  // 日志按批刷写（批间新到旧、批内旧到新），整体并非严格降序，须全量遍历
  for (const l of logs) {
    if (l.timestamp >= todayTs) todayRequestCount++;
  }

  // 代理关闭时倒计时已被清除，无需查询
  let autoOffAt: number | undefined;
  if (config.enabled) {
    const alarm = await chrome.alarms.get(AUTO_OFF_ALARM);
    autoOffAt = alarm?.scheduledTime;
  }

  return {
    enabled: config.enabled,
    activeRuleCount: config.rules.filter(r => r.enabled).length,
    todayRequestCount,
    recentLogs: logs.slice(0, 10),
    rules: config.rules.map(r => ({ id: r.id, name: r.name, enabled: r.enabled })),
    autoOffAt,
  };
}
