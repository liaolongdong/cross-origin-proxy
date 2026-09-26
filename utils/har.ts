import type { RequestLogEntry, HarEntry, ProxyRule } from '@/utils/types';
import { sanitizeImportedHeaderMap } from '@/utils/headerValidation';
import { isProxyableProtocol } from '@/utils/ruleValidation';
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
 * 提取请求 URL 的 origin 作为 matchPattern（wildcard），提取请求头里的凭据作为 `headerOverrides` 参考。
 *
 * 两道闸门，都排在「这条条目算不算占住了这个 origin」之前：
 * - 协议：只收本扩展能代理的协议（{@link isProxyableProtocol}，口径与 `utils/curlParser.ts` 同源）。
 * - 条目形状：`headers` 不是数组、头项缺 `name`/`value` 都只跳过那一条头，不让它连带作废整条规则。
 * 去重登记因此必须挨着 `rules.push`——早一步登记就会让一条坏条目吃掉同 origin 后面那条好规则。
 */
export function harEntriesToRules(entries: HarEntry[]): ProxyRule[] {
  const now = Date.now();
  const seenOrigins = new Set<string>();
  const rules: ProxyRule[] = [];

  for (const entry of entries) {
    try {
      const url = new URL(entry.request.url);
      // 协议闸门：`data:` / `blob:` / `file:` 条目的 `url.origin` 是字符串 "null"，此前会原样
      // 生成一条 `matchPattern: "null/*"`、`targetUrl: "null"` 的垃圾规则——进列表、占 200 个
      // 名额之一，却永远命中不了任何真实请求。`ws` / `wss` 有像样的 origin，留在可用范围内
      // （HAR 里那条握手是改造成跨环境长连接规则的合理起点）。
      // 第二道 `origin` 检查是兜底：闸门认的是字段形状，认不出「字段齐全但没有内容」的意思。
      if (!isProxyableProtocol(url.protocol)) continue;
      const origin = url.origin;
      if (!origin || origin === 'null') continue;

      // 去重登记必须挨着 `rules.push`：此前它排在头清洗之前，一条头形状坏掉的条目
      // 自己没成为规则，却已经把这个 origin 占住，同 origin 后面那条完好的跟着一起丢。
      if (seenOrigins.has(origin)) continue;

      const headerOverrides: Record<string, string> = {};
      if (Array.isArray(entry.request.headers)) {
        for (const h of entry.request.headers) {
          if (!h || typeof h.name !== 'string' || typeof h.value !== 'string') continue;
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

      // HAR 文件是不可信输入，且这条路径不经 normalizeImportedRules：
      // 取值含换行的头会让规则在运行时被 validateRuleHeaders 整条拒绝，故在此清洗
      const sanitizedHeaders = sanitizeImportedHeaderMap(headerOverrides);
      if (sanitizedHeaders) {
        rule.headerOverrides = sanitizedHeaders;
      }

      seenOrigins.add(origin);
      rules.push(rule);
    } catch {
      // Skip invalid URLs
    }
  }

  return rules;
}
