import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    // ============================================================
    // MAIN World Request Interceptor
    // Runs in the page's JavaScript context.
    // CANNOT use chrome.* APIs. Self-contained.
    // Intercepts fetch() and XMLHttpRequest, forwards matching
    // requests to the ISOLATED world content script via postMessage.
    // NOTE: All postMessage calls use window.location.origin as targetOrigin
    // (not '*') to restrict message delivery to the same origin.
    // ============================================================

    const CHANNEL = 'cross-origin-proxy';
    const PROXY_REQUEST = 'PROXY_REQUEST';
    const PROXY_RESPONSE = 'PROXY_RESPONSE';
    const SYNC_RULES = 'SYNC_RULES';

    // ---- Proxy rule types (duplicated from types.ts — must be self-contained) ----

    interface ProxyRule {
      id: string;
      name: string;
      enabled: boolean;
      matchPattern: string;
      targetUrl: string;
      matchType: 'wildcard' | 'prefix' | 'regex';
      headerOverrides?: Record<string, string>;
      requestBodyOverride?: string;
      responseOverrides?: {
        status?: number;
        statusText?: string;
        headers?: Record<string, string>;
        bodyRaw?: string;
        bodyReplacements?: Record<string, unknown>;
      };
      mockResponse?: {
        body: string;
        contentType?: string;
        status?: number;
      };
      delayMs?: number;
      blocked?: boolean;
      priority: number;
      createdAt: number;
      updatedAt: number;
    }

    interface ProxyConfig {
      enabled: boolean;
      rules: ProxyRule[];
    }

    // ---- State ----

    let proxyEnabled = false;
    let requestCounter = 0;

    // Pending requests waiting for response from content script
    const pendingRequests = new Map<
      string,
      {
        resolve: (value: any) => void;
        reject: (reason: any) => void;
      }
    >();

    // ---- Rule cache (rebuilt only on SYNC_RULES) ----

    let cachedSortedRules: ProxyRule[] = [];
    let compiledRegexCache: Map<string, RegExp> = new Map();

    /**
     * Detect nested quantifiers that can cause catastrophic backtracking (ReDoS).
     */
    function isRegexSafe(pattern: string): boolean {
      const dangerousPatterns = [
        /\([^)]*[+*][^)]*\)[+*]/, // (a+)+ or (a*)+  etc.
        /\([^)]*[+*][^)]*\)\{/, // (a+){n} etc.
        /(\+|\*)\1/, // ++ or **
      ];
      return !dangerousPatterns.some(p => p.test(pattern));
    }

    /**
     * Compile a rule's match pattern into a RegExp, using cache.
     * Returns null if the pattern is unsafe or invalid.
     */
    function getCompiledRegex(rule: ProxyRule): RegExp | null {
      const cacheKey = `${rule.matchType}:${rule.matchPattern}`;
      const cached = compiledRegexCache.get(cacheKey);
      if (cached) return cached;

      let regex: RegExp | null = null;
      if (rule.matchType === 'wildcard') {
        const escaped = rule.matchPattern
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*');
        try {
          regex = new RegExp(`^${escaped}$`);
        } catch {
          return null;
        }
      } else if (rule.matchType === 'regex') {
        if (!isRegexSafe(rule.matchPattern)) {
          console.warn('[CrossOriginProxy] Skipping unsafe regex pattern (ReDoS risk):', rule.matchPattern);
          return null;
        }
        try {
          regex = new RegExp(rule.matchPattern);
        } catch {
          return null;
        }
      }

      if (regex) {
        compiledRegexCache.set(cacheKey, regex);
      }
      return regex;
    }

    /**
     * Rebuild the sorted rule cache and pre-compile all regex patterns.
     * Called only when SYNC_RULES is received.
     */
    function rebuildRuleCache(rules: ProxyRule[]): void {
      cachedSortedRules = [...rules].filter(r => r.enabled).sort((a, b) => a.priority - b.priority);
      compiledRegexCache = new Map();
      // Pre-compile all wildcard and regex patterns
      for (const rule of cachedSortedRules) {
        if (rule.matchType === 'wildcard' || rule.matchType === 'regex') {
          getCompiledRegex(rule);
        }
      }
    }

    // ---- Listen for messages from ISOLATED world content script ----

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.channel !== CHANNEL) return;

      if (event.data.type === PROXY_RESPONSE) {
        const { requestId } = event.data.data;
        const pending = pendingRequests.get(requestId);
        if (pending) {
          pendingRequests.delete(requestId);
          pending.resolve(event.data.data);
        }
      }

      if (event.data.type === SYNC_RULES) {
        const config: ProxyConfig = event.data.data || { enabled: false, rules: [] };
        proxyEnabled = config.enabled || false;
        rebuildRuleCache(config.rules || []);
      }
    });

    // ---- URL matching (uses cached rules and pre-compiled RegExp) ----

    function matchUrl(url: string, rule: ProxyRule): boolean {
      if (!rule.enabled) return false;
      switch (rule.matchType) {
        case 'wildcard':
        case 'regex': {
          const regex = getCompiledRegex(rule);
          return regex ? regex.test(url) : false;
        }
        case 'prefix':
          return url.startsWith(rule.matchPattern);
        default:
          return false;
      }
    }

    function findMatchingRule(url: string): ProxyRule | null {
      if (!proxyEnabled) return null;
      for (const rule of cachedSortedRules) {
        if (matchUrl(url, rule)) return rule;
      }
      return null;
    }

    // ---- Proxy fetch via content script bridge ----

    function proxyFetch(url: string, options: RequestInit = {}): Promise<Response> {
      return new Promise((resolve, reject) => {
        const requestId = `req-${++requestCounter}-${Date.now()}`;

        // 30 second timeout
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error('Proxy request timeout'));
        }, 30000);

        pendingRequests.set(requestId, {
          resolve: (data: any) => {
            clearTimeout(timeout);
            // status 0 无法构造 Response（合法范围 200-599）：
            // 含旁路（Proxy Bypass）、代理失败（Proxy Error）、桥接层错误，
            // 统一 reject 交由外层回退到原生 fetch/XHR
            if (data.status === 0 || data.status < 200 || data.status > 599) {
              reject(new Error(data.body || data.statusText || 'Proxy bypassed'));
              return;
            }

            // Build Response object
            const responseInit: ResponseInit = {
              status: data.status,
              statusText: data.statusText,
              headers: new Headers(data.headers),
            };

            let body: BodyInit;
            if (data.isBase64) {
              const binary = atob(data.body);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              body = bytes.buffer;
            } else {
              body = data.body;
            }

            resolve(new Response(body, responseInit));
          },
          reject: (err: any) => {
            clearTimeout(timeout);
            reject(err);
          },
        });

        // Extract headers from options
        const headers: Record<string, string> = {};
        if (options.headers) {
          if (options.headers instanceof Headers) {
            options.headers.forEach((value, key) => {
              headers[key] = value;
            });
          } else if (Array.isArray(options.headers)) {
            options.headers.forEach(([key, value]) => {
              headers[key] = value;
            });
          } else {
            Object.assign(headers, options.headers);
          }
        }

        // Send request to content script via postMessage
        window.postMessage(
          {
            channel: CHANNEL,
            type: PROXY_REQUEST,
            data: {
              requestId,
              url,
              method: options.method || 'GET',
              headers,
              body: options.body ? (typeof options.body === 'string' ? options.body : null) : null,
            },
          },
          window.location.origin,
        );
      });
    }

    // ---- Intercept window.fetch ----

    const originalFetch = window.fetch;

    window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : null;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      const rule = findMatchingRule(url);
      if (!rule) {
        return originalFetch.call(window, input, init);
      }

      try {
        // 合并 Request 对象与 init：init 优先，缺失时回退到 Request 自身的 method/headers/body
        const method = init?.method || request?.method || 'GET';
        const headers = init?.headers ?? request?.headers;
        let body: unknown = init?.body;
        if (body === undefined && request && method !== 'GET' && method !== 'HEAD') {
          body = await request.clone().text();
        }
        if (body instanceof URLSearchParams) {
          body = body.toString();
        }
        // 非字符串 body（FormData / Blob / ArrayBuffer 等）无法跨 postMessage 序列化，
        // 回退到原生 fetch，避免静默丢失请求体
        if (body !== undefined && body !== null && typeof body !== 'string') {
          return originalFetch.call(window, input, init);
        }

        return await proxyFetch(url, { method, headers, body: (body ?? null) as BodyInit | null });
      } catch (error) {
        console.warn('[CrossOriginProxy] Proxy failed, falling back to original fetch:', error);
        return originalFetch.call(window, input, init);
      }
    };

    // ---- Intercept XMLHttpRequest ----

    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
      (this as any).__proxyMethod = method;
      (this as any).__proxyUrl = typeof url === 'string' ? url : url.href;
      (this as any).__proxyHeaders = {};
      return originalXHROpen.apply(this, [method, url, ...rest] as any);
    };

    // Collect request headers so the proxied fetch carries them
    XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
      const headers: Record<string, string> = ((this as any).__proxyHeaders ??= {});
      headers[name] = value;
      return originalXHRSetRequestHeader.apply(this, [name, value]);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const url: string = (this as any).__proxyUrl;
      const method: string = (this as any).__proxyMethod;

      if (url && findMatchingRule(url)) {
        // Non-string bodies (FormData / Blob / ArrayBuffer / Document) cannot be
        // serialized across postMessage; fall back to the original XHR instead
        // of silently dropping the body.
        if (body !== undefined && body !== null && typeof body !== 'string') {
          originalXHRSend.call(this, body);
          return;
        }

        const headers: Record<string, string> = (this as any).__proxyHeaders || {};
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const xhr = this;

        proxyFetch(url, {
          method: method || 'GET',
          headers,
          body: body ?? null,
        })
          .then(async response => {
            // Honor responseType: '', text, json, blob, arraybuffer
            let responseValue: any;
            let responseTextValue: string | undefined;
            switch (xhr.responseType) {
              case 'json': {
                const text = await response.text();
                try {
                  responseValue = JSON.parse(text);
                } catch {
                  responseValue = null;
                }
                break;
              }
              case 'blob':
                responseValue = await response.blob();
                break;
              case 'arraybuffer':
                responseValue = await response.arrayBuffer();
                break;
              default:
                responseTextValue = await response.text();
                responseValue = responseTextValue;
            }

            // Build raw headers string for getAllResponseHeaders()
            const headerLines: string[] = [];
            response.headers.forEach((value, key) => {
              headerLines.push(`${key}: ${value}`);
            });
            const rawHeaders = headerLines.join('\r\n');

            // Set readonly XHR properties
            Object.defineProperty(xhr, 'readyState', { value: 4, writable: true });
            Object.defineProperty(xhr, 'status', {
              value: response.status,
              writable: true,
            });
            Object.defineProperty(xhr, 'statusText', {
              value: response.statusText,
              writable: true,
            });
            Object.defineProperty(xhr, 'response', {
              value: responseValue,
              writable: true,
            });
            Object.defineProperty(xhr, 'responseURL', { value: url, writable: true });
            if (responseTextValue !== undefined) {
              Object.defineProperty(xhr, 'responseText', {
                value: responseTextValue,
                writable: true,
              });
            }
            xhr.getAllResponseHeaders = () => rawHeaders;
            xhr.getResponseHeader = (name: string) => response.headers.get(name);

            // dispatchEvent 会同时触发 addEventListener 与 on* 属性监听器，
            // 无需再手动调用 onload/onreadystatechange（否则会重复回调）
            xhr.dispatchEvent(new Event('readystatechange'));
            xhr.dispatchEvent(new Event('load'));
            xhr.dispatchEvent(new Event('loadend'));
          })
          .catch(error => {
            console.warn('[CrossOriginProxy] XHR proxy failed, dispatching error:', error);
            Object.defineProperty(xhr, 'readyState', { value: 4, writable: true });
            Object.defineProperty(xhr, 'status', { value: 0, writable: true });
            Object.defineProperty(xhr, 'statusText', { value: 'Proxy Error', writable: true });
            xhr.dispatchEvent(new Event('readystatechange'));
            xhr.dispatchEvent(new Event('error'));
            xhr.dispatchEvent(new Event('loadend'));
          });
        return; // Don't call original send
      }

      originalXHRSend.call(this, body);
    };

    // ---- Intercept WebSocket constructor ----

    const OriginalWebSocket = window.WebSocket;

    /** ws(s):// → http(s):// 归一化，使现有规则可直接匹配 WebSocket URL */
    function normalizeWsUrl(url: string): string {
      return url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    }

    /** 将 http(s):// 目标 URL 转回 ws(s):// */
    function toWsUrl(url: string): string {
      return url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    }

    /** WebSocket URL 重写（复用与 fetch 相同的匹配/重写逻辑） */
    function rewriteWsUrl(url: string, rule: ProxyRule): string {
      const httpUrl = normalizeWsUrl(url);
      const httpTarget = rule.targetUrl.replace(/^https:\/\//, 'http://').replace(/^http(s?):/, 'http$1:');

      switch (rule.matchType) {
        case 'wildcard': {
          const patternBase = rule.matchPattern.replace(/\*$/, '');
          if (httpUrl.startsWith(patternBase)) {
            const rest = httpUrl.slice(patternBase.length);
            const target = httpTarget.replace(/\/$/, '');
            const separator = patternBase.endsWith('/') && rest ? '/' : '';
            return toWsUrl(target + separator + rest);
          }
          return url;
        }
        case 'prefix': {
          if (httpUrl.startsWith(rule.matchPattern)) {
            const rest = httpUrl.slice(rule.matchPattern.length);
            const target = httpTarget.replace(/\/$/, '');
            return toWsUrl(target + rest);
          }
          return url;
        }
        case 'regex': {
          const regex = getCompiledRegex(rule);
          if (!regex) return url;
          const httpResult = httpUrl.replace(regex, httpTarget);
          return toWsUrl(httpResult);
        }
        default:
          return url;
      }
    }

    function ProxyWebSocket(this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const wsUrl = typeof url === 'string' ? url : url.href;
      const httpUrl = normalizeWsUrl(wsUrl);
      const rule = findMatchingRule(httpUrl);

      if (rule) {
        const targetUrl = rewriteWsUrl(wsUrl, rule);
        console.warn('[CrossOriginProxy] WS intercepted:', wsUrl, '→', targetUrl);
        return protocols
          ? new OriginalWebSocket(targetUrl, protocols)
          : new OriginalWebSocket(targetUrl);
      }

      return protocols
        ? new OriginalWebSocket(url, protocols)
        : new OriginalWebSocket(url);
    }

    // 保留 WebSocket 静态属性和原型
    ProxyWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    ProxyWebSocket.OPEN = OriginalWebSocket.OPEN;
    ProxyWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    ProxyWebSocket.CLOSED = OriginalWebSocket.CLOSED;
    ProxyWebSocket.prototype = OriginalWebSocket.prototype;

    window.WebSocket = ProxyWebSocket as unknown as typeof WebSocket;
  },
});
