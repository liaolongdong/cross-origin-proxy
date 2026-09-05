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
    const REQUEST_CONFIG = 'REQUEST_CONFIG';

    // ---- Proxy rule types (duplicated from types.ts — must be self-contained) ----

    interface ProxyRule {
      id: string;
      name: string;
      enabled: boolean;
      matchPattern: string;
      targetUrl: string;
      matchType: 'wildcard' | 'prefix' | 'regex';
      methods?: string[];
      queryOverrides?: Record<string, string>;
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
      retryCount?: number;
      retryDelay?: number;
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
        const escaped = rule.matchPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
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

    // 监听器就绪后主动请求配置：ISOLATED world 的初始 SYNC_RULES 可能早于本监听器注册
    // （两 world 注入时序竞态），主动拉取保证拦截器不会空规则运行
    window.postMessage({ channel: CHANNEL, type: REQUEST_CONFIG }, window.location.origin);

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

    /**
     * Rule HTTP method allowlist check (self-contained mirror of utils/urlMatcher).
     * Empty/undefined methods => allow any; unknown method (undefined) => not narrowed.
     */
    function methodAllowed(rule: ProxyRule, method?: string): boolean {
      if (!rule.methods || rule.methods.length === 0) return true;
      if (!method) return true;
      const upper = method.toUpperCase();
      return rule.methods.some(m => m.toUpperCase() === upper);
    }

    function findMatchingRule(url: string, method?: string): ProxyRule | null {
      if (!proxyEnabled) return null;
      for (const rule of cachedSortedRules) {
        if (!methodAllowed(rule, method)) continue;
        if (matchUrl(url, rule)) return rule;
      }
      return null;
    }

    /**
     * WebSocket rule lookup: a rule pattern may be written with http(s):// or ws(s)://.
     * The connection is matched against BOTH the normalized http URL and the raw ws URL
     * so that `wss://` patterns (previously never matched) work as expected.
     * The WebSocket handshake is treated as GET for method filtering.
     */
    function findWsRule(wsUrl: string, httpUrl: string): ProxyRule | null {
      if (!proxyEnabled) return null;
      for (const rule of cachedSortedRules) {
        if (!methodAllowed(rule, 'GET')) continue;
        if (matchUrl(httpUrl, rule) || matchUrl(wsUrl, rule)) return rule;
      }
      return null;
    }

    // ---- Proxy fetch via content script bridge ----

    /**
     * 计算代理超时上限：请求延迟 + 每次尝试 30s 超时 ×（重试次数+1）+ 重试间隔 × 重试次数 + 桥接余量。
     * 固定 30s 会误杀配置了延迟或重试的慢请求
     */
    function computeProxyTimeout(rule: ProxyRule): number {
      const retries = rule.retryCount ?? 0;
      return (rule.delayMs || 0) + 30000 * (retries + 1) + (rule.retryDelay ?? 1000) * retries + 5000;
    }

    function proxyFetch(url: string, rule: ProxyRule, options: RequestInit = {}): Promise<Response> {
      return new Promise((resolve, reject) => {
        const requestId = `req-${++requestCounter}-${Date.now()}`;

        // 超时上限按规则配置动态计算（延迟/重试会拉长 SW 侧总耗时）
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error('Proxy request timeout'));
        }, computeProxyTimeout(rule));

        pendingRequests.set(requestId, {
          resolve: (data: any) => {
            clearTimeout(timeout);
            // status 0 无法构造 Response（合法范围 200-599）：
            // 含旁路（Proxy Bypass）、代理失败（Proxy Error）、桥接层错误，
            // 统一 reject；其中"规则阻断"必须真正拦截（打标记），
            // 不能回退原生 fetch，否则被阻断的请求会实际发出
            if (data.status === 0 || data.status < 200 || data.status > 599) {
              const err = new Error(data.body || data.statusText || 'Proxy bypassed') as Error & {
                __proxyBlocked?: boolean;
              };
              err.__proxyBlocked = data.statusText === 'Blocked';
              reject(err);
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
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      // 相对路径（如 '/api/x'）基于页面 URL 解析为绝对地址再匹配；绝对 URL 解析后不变
      let url = rawUrl;
      try {
        url = new URL(rawUrl, window.location.href).href;
      } catch {
        // 无法解析时按原值匹配
      }

      // 合并 Request 对象与 init：init 优先，缺失时回退到 Request 自身的 method/headers/body
      // 需先算出 method 再匹配，以便按规则的方法白名单收窄拦截范围
      const method = init?.method || request?.method || 'GET';

      const rule = findMatchingRule(url, method);
      if (!rule) {
        return originalFetch.call(window, input, init);
      }

      try {
        const headers = init?.headers ?? request?.headers;
        let body: unknown = init?.body;
        if (body === undefined && request && method !== 'GET' && method !== 'HEAD') {
          body = await request.clone().text();
        }
        if (body instanceof URLSearchParams) {
          body = body.toString();
        }
        // 非字符串 body（FormData / Blob / ArrayBuffer 等）无法跨 postMessage 序列化，
        // 回退到原生 fetch，避免静默丢失请求体；但阻断规则不得回退，否则请求会实际发出
        if (body !== undefined && body !== null && typeof body !== 'string') {
          if (rule.blocked) {
            throw new TypeError('Failed to fetch', { cause: new Error('Request blocked by proxy rule') });
          }
          return originalFetch.call(window, input, init);
        }

        return await proxyFetch(url, rule, { method, headers, body: (body ?? null) as BodyInit | null });
      } catch (error) {
        // 规则阻断：不得回退原生 fetch（否则被阻断的请求会实际发出），
        // 抛出模拟网络错误的 TypeError，与原生 fetch 被阻断时的行为一致
        if ((error as { __proxyBlocked?: boolean })?.__proxyBlocked) {
          throw new TypeError('Failed to fetch', { cause: error });
        }
        console.warn('[CrossOriginProxy] Proxy failed, falling back to original fetch:', error);
        return originalFetch.call(window, input, init);
      }
    };

    // ---- Intercept XMLHttpRequest ----

    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalXHRAbort = XMLHttpRequest.prototype.abort;

    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
      (this as any).__proxyMethod = method;
      (this as any).__proxyUrl = typeof url === 'string' ? url : url.href;
      (this as any).__proxyHeaders = {};
      (this as any).__proxyCancel = false;
      (this as any).__proxySettled = false;
      return originalXHROpen.apply(this, [method, url, ...rest] as any);
    };

    XMLHttpRequest.prototype.abort = function (...args: any[]) {
      // 标记取消：迟到的代理响应不再写回该实例（否则会在 abort 后错误派发 load 事件）
      (this as any).__proxyCancel = true;
      return originalXHRAbort.apply(this, args as any);
    };

    // Collect request headers so the proxied fetch carries them
    XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
      const headers: Record<string, string> = ((this as any).__proxyHeaders ??= {});
      headers[name] = value;
      return originalXHRSetRequestHeader.apply(this, [name, value]);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const rawUrl: string = (this as any).__proxyUrl;
      const method: string = (this as any).__proxyMethod;

      // 与 fetch 一致：相对路径解析为绝对地址后再匹配
      let url = rawUrl;
      try {
        url = new URL(rawUrl, window.location.href).href;
      } catch {
        // 无法解析时按原值匹配
      }

      const rule = url ? findMatchingRule(url, method) : null;

      if (rule) {
        // Non-string bodies (FormData / Blob / ArrayBuffer / Document) cannot be
        // serialized across postMessage; fall back to the original XHR instead
        // of silently dropping the body. 但阻断规则不得回退，否则请求会实际发出
        if (body !== undefined && body !== null && typeof body !== 'string') {
          if (rule.blocked) {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const xhr = this;
            setTimeout(() => {
              Object.defineProperty(xhr, 'readyState', { value: 4, writable: true });
              Object.defineProperty(xhr, 'status', { value: 0, writable: true });
              Object.defineProperty(xhr, 'statusText', { value: '', writable: true });
              xhr.dispatchEvent(new Event('readystatechange'));
              xhr.dispatchEvent(new Event('error'));
              xhr.dispatchEvent(new Event('loadend'));
            }, 0);
            return;
          }
          originalXHRSend.call(this, body);
          return;
        }

        const headers: Record<string, string> = (this as any).__proxyHeaders || {};
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const xhr = this;

        // 尊重页面设置的 xhr.timeout：到期派发 timeout 事件，此后迟到的响应一律丢弃
        if (xhr.timeout > 0) {
          setTimeout(() => {
            if ((xhr as any).__proxyCancel || (xhr as any).__proxySettled) return;
            (xhr as any).__proxyCancel = true;
            Object.defineProperty(xhr, 'readyState', { value: 4, writable: true });
            Object.defineProperty(xhr, 'status', { value: 0, writable: true });
            Object.defineProperty(xhr, 'statusText', { value: '', writable: true });
            xhr.dispatchEvent(new Event('readystatechange'));
            xhr.dispatchEvent(new Event('timeout'));
            xhr.dispatchEvent(new Event('loadend'));
          }, xhr.timeout);
        }

        proxyFetch(url, rule, {
          method: method || 'GET',
          headers,
          body: body ?? null,
        })
          .then(async response => {
            // 已被 abort/timeout 的实例：迟到的响应一律丢弃
            if ((xhr as any).__proxyCancel) return;
            (xhr as any).__proxySettled = true;
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

            // await 期间实例可能被 abort/timeout，二次检查
            if ((xhr as any).__proxyCancel) return;

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
            if ((xhr as any).__proxyCancel) return;
            (xhr as any).__proxySettled = true;
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

    /** 对 ws(s):// URL 追加/覆盖查询参数；异常时原样返回（防御不可信目标地址） */
    function applyWsQuery(url: string, overrides?: Record<string, string>): string {
      if (!overrides || Object.keys(overrides).length === 0) return url;
      try {
        const parsed = new URL(url);
        for (const [key, value] of Object.entries(overrides)) {
          parsed.searchParams.set(key, value);
        }
        return parsed.toString();
      } catch {
        return url;
      }
    }

    /**
     * WebSocket URL 重写（复用与 fetch 相同的匹配/重写语义）。
     * 根据规则实际命中的形态选择基准地址：http(s) 写法匹配归一化地址，
     * ws(s) 写法匹配原始地址（优先 http 形态，保证多形态一致行为）。
     */
    function rewriteWsUrl(url: string, rule: ProxyRule): string {
      if (!rule.targetUrl) return url;
      const httpUrl = normalizeWsUrl(url);
      // toWsUrl 负责协议映射（https→wss、http→ws）；wss://、ws:// 目标原样保留。
      // 注意不能先把 https 降级为 http，否则 wss 目标会被错误降级为不安全的 ws
      const wsTarget = rule.targetUrl;
      const base = matchUrl(httpUrl, rule) ? httpUrl : url;

      switch (rule.matchType) {
        case 'wildcard': {
          if (!rule.matchPattern.endsWith('*')) return url;
          const patternBase = rule.matchPattern.slice(0, -1);
          // 多 * 模式（如 "*://*.example.com/*"）无法用 startsWith 判断，
          // 需正则捕获末尾 * 匹配的内容，与 SW 通道重写语义保持一致
          const escaped = patternBase.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
          let matched: RegExpExecArray | null;
          try {
            matched = new RegExp(`^${escaped}(.*)$`).exec(base);
          } catch {
            return url;
          }
          if (!matched) return url;
          const rest = matched[1];
          const target = wsTarget.replace(/\/$/, '');
          const separator = patternBase.endsWith('/') && rest ? '/' : '';
          return applyWsQuery(toWsUrl(target + separator + rest), rule.queryOverrides);
        }
        case 'prefix': {
          if (base.startsWith(rule.matchPattern)) {
            const rest = base.slice(rule.matchPattern.length);
            const target = wsTarget.replace(/\/$/, '');
            return applyWsQuery(toWsUrl(target + rest), rule.queryOverrides);
          }
          return url;
        }
        case 'regex': {
          const regex = getCompiledRegex(rule);
          if (!regex) return url;
          const result = base.replace(regex, wsTarget);
          return applyWsQuery(toWsUrl(result), rule.queryOverrides);
        }
        default:
          return url;
      }
    }

    function ProxyWebSocket(this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const wsUrl = typeof url === 'string' ? url : url.href;
      const httpUrl = normalizeWsUrl(wsUrl);
      const rule = findWsRule(wsUrl, httpUrl);

      if (rule) {
        // 阻断规则：连向必然拒绝的本地端口，让页面收到标准 error 事件，
        // 而不是继续建立真实连接（否则阻断对 WebSocket 静默失效）
        if (rule.blocked) {
          console.warn('[CrossOriginProxy] WS blocked by rule:', rule.name, wsUrl);
          return new OriginalWebSocket('ws://127.0.0.1:1');
        }
        const targetUrl = rewriteWsUrl(wsUrl, rule);
        console.warn('[CrossOriginProxy] WS intercepted:', wsUrl, '→', targetUrl);
        return protocols ? new OriginalWebSocket(targetUrl, protocols) : new OriginalWebSocket(targetUrl);
      }

      return protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
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
