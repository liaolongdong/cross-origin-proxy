import { findMatchingRule, rewriteUrl } from '@/utils/urlMatcher';
import { getProxyConfig, addRequestLog, getRequestLogs } from '@/utils/storage';
import { generateId } from '@/utils/generateId';
import { logger } from '@/utils/logger';
import type { ProxyStatus, RequestLogEntry } from '@/utils/types';

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

    // Log the request
    const logEntry: RequestLogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      ruleId: rule.id,
      ruleName: rule.name,
      originalUrl: data.url,
      proxiedUrl: targetUrl,
      method: data.method,
      status: response.status,
      duration: Date.now() - startTime,
      proxyType: 'sw',
    };
    await addRequestLog(logEntry);

    return {
      requestId: data.requestId,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      isBase64,
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
