import type { RequestLogEntry, HarEntry, ProxyRule } from '@/utils/types';
import { generateId } from '@/utils/generateId';

/**
 * 将请求日志转换为 HAR 格式（HTTP Archive）
 *
 * 仅包含 SW 通道记录的日志（DNR 通道无请求/响应详情）。
 */
export function logsToHar(logs: RequestLogEntry[]): object {
  const entries = logs.filter(l => l.proxyType === 'sw' && l.responseBody !== undefined).map(l => logToHarEntry(l));

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'Cross-Origin Proxy',
        version: '1.0.0',
      },
      entries,
    },
  };
}

function findContentType(headers: Record<string, string> | undefined): string {
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === 'content-type') return value;
    }
  }
  return 'application/json';
}

function logToHarEntry(log: RequestLogEntry): HarEntry {
  const requestHeaders = log.requestHeaders
    ? Object.entries(log.requestHeaders).map(([name, value]) => ({ name, value }))
    : [];

  const responseHeaders = log.responseHeaders
    ? Object.entries(log.responseHeaders).map(([name, value]) => ({ name, value }))
    : [];

  return {
    request: {
      method: log.method,
      url: log.originalUrl,
      headers: requestHeaders,
      postData: log.requestBody ? { text: log.requestBody, mimeType: findContentType(log.requestHeaders) } : undefined,
    },
    response: {
      status: log.status ?? 0,
      statusText: '',
      headers: responseHeaders,
      content: log.responseBody
        ? { text: log.responseBody, mimeType: findContentType(log.responseHeaders) }
        : undefined,
    },
  };
}

/**
 * 从 HAR 条目生成代理规则
 *
 * 提取请求 URL 的 origin 作为 matchPattern（wildcard），
 * 提取响应的 content-type 和关键请求头作为 headerOverrides 参考。
 */
export function harEntriesToRules(entries: HarEntry[]): ProxyRule[] {
  const now = Date.now();
  const seenOrigins = new Set<string>();
  const rules: ProxyRule[] = [];

  for (const entry of entries) {
    try {
      const url = new URL(entry.request.url);
      const origin = url.origin;

      if (seenOrigins.has(origin)) continue;
      seenOrigins.add(origin);

      const headerOverrides: Record<string, string> = {};
      if (entry.request.headers) {
        for (const h of entry.request.headers) {
          const name = h.name.toLowerCase();
          if (name === 'authorization' || name === 'x-api-key' || name === 'cookie') {
            headerOverrides[h.name] = h.value;
          }
        }
      }

      const rule: ProxyRule = {
        id: generateId(),
        name: `Imported: ${url.hostname}`,
        enabled: false,
        matchPattern: `${origin}/*`,
        targetUrl: origin,
        matchType: 'wildcard',
        priority: 100,
        createdAt: now,
        updatedAt: now,
      };

      if (Object.keys(headerOverrides).length > 0) {
        rule.headerOverrides = headerOverrides;
      }

      rules.push(rule);
    } catch {
      // Skip invalid URLs
    }
  }

  return rules;
}
