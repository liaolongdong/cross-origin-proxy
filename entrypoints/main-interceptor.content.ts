import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  // 与 content.ts 成对声明（两处必须一起改）：拦截器只进顶层时，iframe 的 `postMessage` 无人发送，
  // 子 frame 里的复杂规则等于没生效。`allFrames` 因此同时决定「这一页有几个拦截器在数自己的账」。
  allFrames: true,
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
    const CANCEL_REQUEST = 'CANCEL_REQUEST';
    const SYNC_RULES = 'SYNC_RULES';
    const REQUEST_CONFIG = 'REQUEST_CONFIG';
    const INTERCEPTOR_STATS = 'INTERCEPTOR_STATS';

    /**
     * 自报节流：首次立即报，之后「累计每满 10 笔」或「距上次 ≥1s」各触发一次，
     * 尾差由一次性定时器补报——否则最后一批请求会永远停在上一帧计数上，
     * popup 于是把「拦到 12 笔」显示成「拦到 1 笔」。
     */
    const STATS_REPORT_MIN_INTERVAL_MS = 1000;
    const STATS_REPORT_EVERY = 10;

    // 与 utils/constants.ts 的 DEFAULT_RULE_PRIORITY、utils/urlMatcher.ts 的
    // normalizePriority 同源（MAIN world 自包含，无法 import）。
    // 页面侧排序必须与后台 findMatchingRule 一致，否则同一 URL 两条通道选中不同规则。
    const DEFAULT_RULE_PRIORITY = 10;

    /** 缺失/非有限的 priority 回落为默认值，避免 NaN 让排序结果不确定 */
    function normalizePriority(priority: number): number {
      return Number.isFinite(priority) ? priority : DEFAULT_RULE_PRIORITY;
    }

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

    /**
     * 本页活动计数（在当前文档内累计，导航即归零；口径见 utils/types.ts 的 `InterceptorStats` 注释）。
     *
     * 为什么要有它：回退原生是刻意的兜底，但对用户来说「请求成功」和「代理生效」长得一模一样。
     * 这四个数是唯一能回答「这一页到底有没有被拦」的信号，其余通道（日志、DNR 命中）都看不见
     * 拦截器自己的成败。
     *
     * 上报走既有 channel 到 ISOLATED world 再转 SW；数字**页面可伪造**，所以收端只做展示、
     * 并与 SW 侧自己数到的代发数交叉校验，本 world 不做任何可信性声明。
     *
     * `timedOut` 的口径是**扩展侧代发等待回包到期**（`sendProxyRequest` 的那一个定时器），
     * 页面自己设的 `xhr.timeout` 到期不算在内——那一支只是把已经交给后台的响应丢掉，
     * 请求本身没失败，记成超时会把「代理慢了」说成「代理断了」。
     *
     * 四个数**不是互斥分类**：fetch 路径上代发超时既进 `timedOut` 又进 `fellBack`
     * （回包没等到，请求确实回退成了原生），所以界面不能把它们相加或当作互补。
     */
    const stats = { intercepted: 0, proxied: 0, fellBack: 0, timedOut: 0 };
    let statsLastReportAt = 0;
    let statsReportedTotal = 0;
    let statsTimer: ReturnType<typeof setTimeout> | null = null;

    function reportStats(): void {
      if (statsTimer !== null) {
        clearTimeout(statsTimer);
        statsTimer = null;
      }
      statsLastReportAt = Date.now();
      statsReportedTotal = stats.intercepted + stats.proxied + stats.fellBack + stats.timedOut;
      window.postMessage({ channel: CHANNEL, type: INTERCEPTOR_STATS, data: { ...stats } }, window.location.origin);
    }

    /**
     * 记一笔并按需上报。刻意不加 try/catch、也不参与任何判断分支：
     * 计数是旁路观测，绝不能反过来影响用户的请求路径（这是本文件既有的 fallback 铁律）。
     */
    function bump(kind: keyof typeof stats): void {
      stats[kind]++;
      const total = stats.intercepted + stats.proxied + stats.fellBack + stats.timedOut;
      const sinceLast = Date.now() - statsLastReportAt;
      if (
        statsLastReportAt === 0 ||
        total - statsReportedTotal >= STATS_REPORT_EVERY ||
        sinceLast >= STATS_REPORT_MIN_INTERVAL_MS
      ) {
        reportStats();
        return;
      }
      if (statsTimer === null) {
        statsTimer = setTimeout(reportStats, STATS_REPORT_MIN_INTERVAL_MS - sinceLast);
      }
    }

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
      cachedSortedRules = [...rules]
        .filter(r => r.enabled)
        .sort((a, b) => normalizePriority(a.priority) - normalizePriority(b.priority));
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
        // 入站形状判据：这条消息跨 world 进来，而发送方不只有桥接层——同页脚本拿着
        // `CHANNEL` 字面量就能自己 postMessage 一条 SYNC_RULES（`event.source === window` 挡不住它）。
        // 少了这一道，`rebuildRuleCache` 抛在 `[...rules]` 上，规则缓存停在上一份好配置（首包就非法
        // 时一直是空的），而这一页看起来仍在被代理。桥接层侧成对的一处由
        // `tests/channel-consistency.test.ts` 钉住。
        rebuildRuleCache(Array.isArray(config.rules) ? config.rules : []);
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

    /**
     * 逐条剔掉无法作为 ByteString 交给 `new Headers()` 的响应头。
     *
     * 与 `utils/proxyResponse.ts` 的 `toStringRecord` 同源且必须保持一致（本 world
     * 自包含，无法 import）：规则里手写的中文响应头只过头名字符集与 CR/LF，
     * 值的码点没人管，而 `new Headers()` 抛出点在 resolve 回调里 = 页面永久 pending。
     */
    function toByteStringHeaders(raw: unknown): Record<string, string> {
      const safe: Record<string, string> = {};
      if (!raw || typeof raw !== 'object') return safe;
      for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
        let printable = true;
        for (const char of `${name}${value}`) {
          if ((char.codePointAt(0) ?? 0) > 0xff) {
            printable = false;
            break;
          }
        }
        if (printable) safe[name] = value;
      }
      return safe;
    }

    /**
     * 代发一笔请求并等桥接层写回结果。
     *
     * @param onRequestId - 把本笔的 requestId 交给调用方：XHR 的 `abort()` 与 `xhr.timeout`
     *   到期都发生在 promise 之外，拿不到这个 id 就不知道该取消哪一笔。
     */
    function proxyFetch(
      url: string,
      rule: ProxyRule,
      options: RequestInit = {},
      onRequestId?: (requestId: string) => void,
    ): Promise<Response> {
      return new Promise((resolve, reject) => {
        const requestId = `req-${++requestCounter}-${Date.now()}`;
        onRequestId?.(requestId);
        const pageSignal = options.signal ?? null;

        // 超时上限按规则配置动态计算（延迟/重试会拉长 SW 侧总耗时）
        const timeout = setTimeout(() => {
          bump('timedOut');
          pendingRequests.delete(requestId);
          reject(new Error('Proxy request timeout'));
        }, computeProxyTimeout(rule));

        // 一进来看见已取消：请求根本不该发出，也就不必再发一条取消
        if (pageSignal?.aborted) {
          clearTimeout(timeout);
          reject(pageSignal.reason);
          return;
        }

        pendingRequests.set(requestId, {
          resolve: (data: any) => {
            clearTimeout(timeout);
            // status 越界或缺失一律无法构造 Response（合法范围 200-599，
            // 其中 204/205/304 只能配 null 正文）：
            // 含旁路（Proxy Bypass）、代理失败（Proxy Error）、桥接层错误、
            // 以及后台失败信封（无 status 字段，若漏判会静默变成 200）。
            // 第一层整形在 content.ts（normalizeProxyResponse，会补回 requestId）；
            // 本 world 自包含无法 import，故此处保留同语义守卫兜底。
            // 统一 reject；其中"规则阻断"必须真正拦截（打标记），
            // 不能回退原生 fetch，否则被阻断的请求会实际发出
            const status = typeof data?.status === 'number' ? data.status : 0;
            if (status < 200 || status > 599) {
              const err = new Error(data?.body || data?.statusText || 'Proxy bypassed') as Error & {
                __proxyBlocked?: boolean;
              };
              err.__proxyBlocked = data?.statusText === 'Blocked';
              reject(err);
              return;
            }

            // Build Response object
            // 桥接层（utils/proxyResponse.ts）已做过整形；MAIN world 自包含无法 import，
            // 故此处镜像同一兜底：204/205/304 只能配 null 正文，statusText 与 headers
            // 只能是 ByteString 且不含 CR/LF。
            // 否则 new Response() 在 resolve 回调里抛 TypeError —— 超时已被 clearTimeout 摘掉、
            // 又不会走 reject，页面的 fetch/XHR 从此永久 pending（下面的 try/catch 是最后一道）。
            const nullBodyStatus = status === 204 || status === 205 || status === 304;
            let statusText = '';
            for (const char of String(data.statusText ?? '')) {
              const code = char.codePointAt(0) ?? 0;
              if (code <= 0xff && code !== 0x0a && code !== 0x0d) statusText += char;
            }
            const responseInit: ResponseInit = {
              status,
              statusText,
              headers: toByteStringHeaders(data.headers),
            };

            try {
              let body: BodyInit | null = null;
              if (!nullBodyStatus && typeof data.body === 'string') {
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
              }

              resolve(new Response(body, responseInit));
            } catch (error) {
              // 形状已在桥接层与本 world 各守一遍，仍抛错说明载荷超出预期。这里必须
              // reject：超时在上面已被 clearTimeout 摘掉，抛出 promise 不 settle 的话
              // 页面既等不到结果、也走不到下面的原生请求回退，等于永久 pending。
              reject(error instanceof Error ? error : new Error('Proxy response error'));
            }
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
        // ruleId 带上本 world 已选中的规则：SW 若用全量规则重匹配，一条更宽、优先级更高的
        // 简单规则会抢走请求，窄规则的头注入/Mock 静默失效，窄规则为 blocked 时请求还会真的发出
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
              ruleId: rule.id,
            },
          },
          window.location.origin,
        );
        bump('proxied');

        // 页面取消（`controller.abort()`）：本地按 `signal.reason` 落定，同时让后台掐掉那笔上游。
        // 不掐的后果是——连接继续握、凭据继续外发、retryCount 继续追加，而结果已经没人读了。
        pageSignal?.addEventListener(
          'abort',
          () => {
            // 已落定（正常回包或代发超时）时登记项已摘除，这时不该补发一条无主的取消
            if (!pendingRequests.has(requestId)) return;
            pendingRequests.delete(requestId);
            clearTimeout(timeout);
            window.postMessage({ channel: CHANNEL, type: CANCEL_REQUEST, data: { requestId } }, window.location.origin);
            reject(pageSignal.reason);
          },
          { once: true },
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
      // 页面的取消信号同样 init 优先、再回退 Request 自带的
      const signal = init?.signal ?? request?.signal ?? null;

      const rule = findMatchingRule(url, method);
      if (!rule) {
        return originalFetch.call(window, input, init);
      }
      bump('intercepted');

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
          bump('fellBack');
          return originalFetch.call(window, input, init);
        }

        return await proxyFetch(url, rule, { method, headers, body: (body ?? null) as BodyInit | null, signal });
      } catch (error) {
        // 页面已取消：原样抛出（原生 fetch 在 signal 触发时 reject 的就是 `signal.reason`，
        // 页面普遍按 `err.name === 'AbortError'` 分支），更**不得**回退原生——
        // 那等于把页面刚刚放弃的请求再发一遍，还会把「取消」说成「代理失败」。
        if (signal?.aborted) throw error;
        // 阻断规则一律不得回退（否则被阻断的请求会实际发出）：除了 SW 明确回传的
        // Blocked 标记，还要看本地 rule.blocked —— 读配置抛错、桥接超时或收到
        // 无 status 的失败信封时，SW 根本来不及给出阻断判定。
        // 抛出模拟网络错误的 TypeError，与原生 fetch 被阻断时的行为一致
        if (rule?.blocked || (error as { __proxyBlocked?: boolean })?.__proxyBlocked) {
          throw new TypeError('Failed to fetch', { cause: error });
        }
        bump('fellBack');
        console.warn('[CrossOriginProxy] Proxy failed, falling back to original fetch:', error);
        return originalFetch.call(window, input, init);
      }
    };

    // ---- Intercept XMLHttpRequest ----

    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalXHRAbort = XMLHttpRequest.prototype.abort;

    // 同步 XHR 回退只提示一次：这类请求常出现在循环里，逐条 warn 会淹掉控制台
    let warnedSyncXhr = false;

    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
      (this as any).__proxyMethod = method;
      (this as any).__proxyUrl = typeof url === 'string' ? url : url.href;
      (this as any).__proxyHeaders = {};
      (this as any).__proxyCancel = false;
      (this as any).__proxySettled = false;
      // 实例会被复用（open → send → open → send）：不清掉上一笔的 id，
      // 下一次 send 之前的 abort() 就会去取消一个根本不存在的请求
      (this as any).__proxyRequestId = '';
      // open(method, url, false) 是同步 XHR。代理要经 postMessage 往返，响应只能在
      // 调用栈返回之后到达，因此异步写回等于让调用方读到空响应——记下来，send() 回退原生
      (this as any).__proxySync = rest.length > 0 && rest[0] === false;
      return originalXHROpen.apply(this, [method, url, ...rest] as any);
    };

    /**
     * 页面不再读这笔代理结果时（`abort()` 或 `xhr.timeout` 到期），让后台掐掉那笔上游
     *
     * XHR 的取消不像 fetch 那样有 `signal` 可挂，只能由这两处显式发；
     * requestId 是 `proxyFetch` 回填到实例上的，没走过代理路径（回退原生）时它是空的。
     */
    function cancelProxiedXhr(xhr: XMLHttpRequest): void {
      const requestId: string = (xhr as any).__proxyRequestId;
      if (!requestId) return;
      window.postMessage({ channel: CHANNEL, type: CANCEL_REQUEST, data: { requestId } }, window.location.origin);
    }

    XMLHttpRequest.prototype.abort = function (...args: any[]) {
      // 标记取消：迟到的代理响应不再写回该实例（否则会在 abort 后错误派发 load 事件）
      (this as any).__proxyCancel = true;
      cancelProxiedXhr(this);
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
        bump('intercepted');
        // 同步 XHR 不能代理：调用方在 send() 返回后立刻读 status/response，而代理响应只会
        // 异步到达，页面拿到的是空响应而不是被改写后的结果。与「非字符串 body」同一类，
        // 回退原生请求（等价于未装本扩展）。阻断规则例外——回退等于把请求真的发出去。
        if ((this as any).__proxySync && !rule.blocked) {
          if (!warnedSyncXhr) {
            warnedSyncXhr = true;
            console.warn('[CrossOriginProxy] Synchronous XHR cannot be proxied, sending it natively:', url);
          }
          bump('fellBack');
          originalXHRSend.call(this, body);
          return;
        }

        // Non-string bodies (FormData / Blob / ArrayBuffer / Document) cannot be
        // serialized across postMessage; fall back to the original XHR instead
        // of silently dropping the body. 但阻断规则不得回退，否则请求会实际发出
        if (body !== undefined && body !== null && typeof body !== 'string') {
          if (rule.blocked) {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const xhr = this;
            setTimeout(() => {
              Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
              Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
              Object.defineProperty(xhr, 'statusText', { value: '', writable: true, configurable: true });
              xhr.dispatchEvent(new Event('readystatechange'));
              xhr.dispatchEvent(new Event('error'));
              xhr.dispatchEvent(new Event('loadend'));
            }, 0);
            return;
          }
          bump('fellBack');
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
            cancelProxiedXhr(xhr);
            Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
            Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
            Object.defineProperty(xhr, 'statusText', { value: '', writable: true, configurable: true });
            xhr.dispatchEvent(new Event('readystatechange'));
            xhr.dispatchEvent(new Event('timeout'));
            xhr.dispatchEvent(new Event('loadend'));
          }, xhr.timeout);
        }

        proxyFetch(url, rule, { method: method || 'GET', headers, body: body ?? null }, requestId => {
          // 记下这笔的 requestId：页面 abort() 或 timeout 到期时要知道取消哪一条代发
          (xhr as any).__proxyRequestId = requestId;
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

            // Set readonly XHR properties（configurable 不可省：实例复用时要第二遍回填）
            Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
            Object.defineProperty(xhr, 'status', {
              value: response.status,
              writable: true,
              configurable: true,
            });
            Object.defineProperty(xhr, 'statusText', {
              value: response.statusText,
              writable: true,
              configurable: true,
            });
            Object.defineProperty(xhr, 'response', {
              value: responseValue,
              writable: true,
              configurable: true,
            });
            Object.defineProperty(xhr, 'responseURL', { value: url, writable: true, configurable: true });
            if (responseTextValue !== undefined) {
              Object.defineProperty(xhr, 'responseText', {
                value: responseTextValue,
                writable: true,
                configurable: true,
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
            Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
            Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
            Object.defineProperty(xhr, 'statusText', { value: 'Proxy Error', writable: true, configurable: true });
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

    /**
     * 对 ws(s):// URL 追加/覆盖查询参数；非法 URL 原样返回（防御不可信目标地址）。
     *
     * 与 utils/urlMatcher.ts 的 applyQueryOverrides 同源且必须保持一致（MAIN world
     * 自包含，无法 import）：只用 `URL` 判合法，改写在原始 query 串上定点增删，
     * 否则 `searchParams.set` 会重编码**所有**参数，打断按原文比对的签名与回调地址。
     */
    function applyWsQuery(url: string, overrides?: Record<string, string>): string {
      if (!overrides) return url;
      const entries = Object.entries(overrides);
      if (entries.length === 0) return url;
      try {
        new URL(url);
      } catch {
        return url;
      }

      const hashAt = url.indexOf('#');
      const hash = hashAt >= 0 ? url.slice(hashAt) : '';
      const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
      const queryAt = beforeHash.indexOf('?');
      const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
      let pairs =
        queryAt >= 0
          ? beforeHash
              .slice(queryAt + 1)
              .split('&')
              .filter(p => p !== '')
          : [];

      for (const [key, value] of entries) {
        const injected = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        let written = false;
        pairs = pairs.reduce<string[]>((acc, pair) => {
          const eq = pair.indexOf('=');
          const name = eq === -1 ? pair : pair.slice(0, eq);
          if (name === key || safeDecodeQuery(name) === key) {
            if (!written) {
              acc.push(injected);
              written = true;
            }
            return acc;
          }
          acc.push(pair);
          return acc;
        }, []);
        if (!written) pairs.push(injected);
      }

      return pairs.length > 0 ? `${base}?${pairs.join('&')}${hash}` : `${base}${hash}`;
    }

    /** 解码失败（原文含裸 `%`）时退回原值，保证不抛错 */
    function safeDecodeQuery(text: string): string {
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
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
            // 模式以 / 结尾时该斜杠已被消耗，需补回分隔符，
            // 否则拼出 "wss://uat.com/v2users"（与 rewriteUrl / buildRegexSubstitution 同步）
            const target = wsTarget.replace(/\/$/, '');
            const separator = rule.matchPattern.endsWith('/') ? '/' : '';
            return applyWsQuery(toWsUrl(target + separator + rest), rule.queryOverrides);
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
