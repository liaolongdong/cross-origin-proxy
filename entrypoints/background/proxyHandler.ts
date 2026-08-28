import { findMatchingRule, rewriteUrl } from '@/utils/urlMatcher';
import { getProxyConfig, addRequestLog, getRequestLogs } from '@/utils/storage';
import { generateId } from '@/utils/generateId';
import { logger } from '@/utils/logger';
import type { ProxyStatus, RequestLogEntry, ResponseOverrides } from '@/utils/types';

const MAX_BODY_SIZE = 10 * 1024 * 1024;

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;

function sanitizeHeaders(
  headers: Record<string, string>,
): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(key)) return null;
    if (/[\r\n]/.test(value)) return null;
    result[key] = value;
  }
  return result;
}

/**
 * 按点分隔路径对 JSON 对象做深层字段替换
 * 如 path="data.token", value="xxx" → obj.data.token = "xxx"
 */
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

/**
 * 应用响应覆盖：修改状态码、响应头、响应体
 */
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
    result.status = overrides.status;
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

/**
 * Handle a proxy request from content script
 */
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

  // 未启用或未命中规则：返回 status 0 旁路响应，
  // MAIN world 拦截器收到后会回退到原生 fetch/XHR（status 0 无法构造 Response）
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

  const rule = findMatchingRule(data.url, config.rules);
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

  // ─── Mock 响应 ────────────────────────────────────────────────────────────
  if (rule.mockResponse) {
    const mockStatus = rule.mockResponse.status ?? 200;
    const mockContentType = rule.mockResponse.contentType ?? 'application/json';
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
      duration: rule.delayMs,
      proxyType: 'sw',
      responseHeaders: mockHeaders,
      responseBody: rule.mockResponse.body,
    };
    await addRequestLog(logEntry);

    return {
      requestId: data.requestId,
      status: mockStatus,
      statusText: 'Mock',
      headers: mockHeaders,
      body: rule.mockResponse.body,
      isBase64: false,
    };
  }

  const targetUrl = rewriteUrl(data.url, rule);
  logger.info(`Proxying: ${data.url} → ${targetUrl}`);

  try {
    // Sanitize incoming headers to prevent HTTP header injection
    const sanitizedIncoming = sanitizeHeaders(data.headers);
    if (!sanitizedIncoming) {
      return {
        requestId: data.requestId,
        status: 0,
        statusText: 'Invalid Headers',
        headers: {},
        body: 'Request contains invalid header name or value',
        isBase64: false,
      };
    }

    const sanitizedOverrides = rule.headerOverrides
      ? sanitizeHeaders(rule.headerOverrides)
      : {};
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

    // Build fetch options
    const fetchOptions: RequestInit = {
      method: data.method,
      headers: {
        ...sanitizedIncoming,
        ...(sanitizedOverrides || {}),
      },
    };

    // Add body for non-GET requests (explicit null/empty check to allow empty-string bodies)
    if (data.body != null && data.body !== '' && data.method !== 'GET' && data.method !== 'HEAD') {
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

    // 请求体覆盖：规则指定了 requestBodyOverride 时替换原始请求体
    if (rule.requestBodyOverride !== undefined) {
      fetchOptions.body = rule.requestBodyOverride;
    }

    // 请求延迟注入（模拟慢网络）
    if (rule.delayMs) {
      await new Promise(resolve => setTimeout(resolve, rule.delayMs));
    }

    // Execute the proxy request
    const response = await fetch(targetUrl, fetchOptions);

    // Read response
    const contentType = response.headers.get('content-type') || '';
    let responseBody: string;
    let isBase64 = false;

    if (contentType.includes('application/json') || contentType.includes('text/')) {
      responseBody = await response.text();
    } else {
      // Binary content - encode as base64（分块转换，避免大文件展开参数过多导致栈溢出）
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

    // Collect response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let finalStatus = response.status;
    let finalStatusText = response.statusText;
    let finalHeaders = responseHeaders;
    let finalBody = responseBody;
    let finalIsBase64 = isBase64;

    // 响应覆盖：修改状态码、响应头、响应体字段
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

    // Log the request (含请求/响应详情，用于 HAR 导出)
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Proxy request failed:', errorMessage);

    // Log the error
    const logEntry: RequestLogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      ruleId: rule.id,
      ruleName: rule.name,
      originalUrl: data.url,
      proxiedUrl: targetUrl,
      method: data.method,
      duration: Date.now() - startTime,
      error: errorMessage,
      proxyType: 'sw',
    };
    await addRequestLog(logEntry);

    return {
      requestId: data.requestId,
      status: 0,
      statusText: 'Proxy Error',
      headers: {},
      body: errorMessage,
      isBase64: false,
    };
  }
}

/**
 * Get proxy status for popup
 */
export async function getProxyStatus(): Promise<ProxyStatus> {
  const config = await getProxyConfig();
  const logs = await getRequestLogs();

  const todayTimestamp = new Date();
  todayTimestamp.setHours(0, 0, 0, 0);
  const todayTs = todayTimestamp.getTime();

  let todayRequestCount = 0;
  for (const l of logs) {
    if (l.timestamp < todayTs) break;
    todayRequestCount++;
  }

  return {
    enabled: config.enabled,
    activeRuleCount: config.rules.filter(r => r.enabled).length,
    todayRequestCount,
    recentLogs: logs.slice(0, 10),
    rules: config.rules.map(r => ({ id: r.id, name: r.name, enabled: r.enabled })),
  };
}
