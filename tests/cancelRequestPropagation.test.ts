import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * P1③（页面侧）：页面的 `AbortSignal` 必须一路走到后台那笔上游请求
 *
 * 页面把 `AbortController` 交给 fetch/XHR 之后，拦截器只是把**迟到**的代理响应丢掉：
 * 上游连接继续握着、凭据继续外发、`retryCount` 继续追加尝试，SW 那边完全不知道页面已经不要了。
 * 现在取消要跨三个世界走完：MAIN world 监听 signal → `CANCEL_REQUEST` → 桥接层转发 →
 * SW 按 `tabId + requestId` 掐断 `AbortController`（路由与后台侧的行为由
 * `tests/cancelProxiedRequest.test.ts` 用真实现守住）。
 *
 * 拦截器跑在 MAIN world、桥接层跑在内容脚本上下文，两者都无法在 node 环境实例化，
 * 因此这里只能用源码契约（同 `syncXhrFallback` / `interceptorStats` 的做法）。
 * 契约刻意分成「取消要发」和「取消不得回退原生」两组——后者漏掉的话，
 * 页面刚刚放弃的请求会被拦截器再原样发一遍，那比不取消更糟。
 */

const interceptor = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');
const bridge = readFileSync('entrypoints/content.ts', 'utf-8');

/** 只取 `proxyFetch` 那一段：fetch / XHR 分支里另有同名 postMessage，全文比对会串台 */
function proxyFetchSrc(): string {
  const start = interceptor.indexOf('function proxyFetch(');
  const end = interceptor.indexOf('// ---- Intercept window.fetch ----', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return interceptor.slice(start, end);
}

describe('[MAIN world] 取消消息要先于响应写回发出去', () => {
  it('自带 CANCEL_REQUEST 通道常量（与 MessageType 的值同字面量）', () => {
    expect(interceptor).toContain("const CANCEL_REQUEST = 'CANCEL_REQUEST';");
  });

  it('页面已取消时不再发出请求，也不再补发取消', () => {
    const src = proxyFetchSrc();
    expect(src).toContain('const pageSignal = options.signal ?? null;');
    expect(src).toContain('if (pageSignal?.aborted) {');
  });

  it('signal 触发 abort：摘掉待回复登记、撤掉代发超时、发取消、并按 signal.reason 落定', () => {
    const src = proxyFetchSrc();
    expect(src).toContain('pageSignal?.addEventListener(');
    expect(src).toContain('if (!pendingRequests.has(requestId)) return;');
    expect(src).toContain('clearTimeout(timeout);');
    expect(src).toContain(
      'window.postMessage({ channel: CHANNEL, type: CANCEL_REQUEST, data: { requestId } }, window.location.origin);',
    );
    expect(src).toContain('reject(pageSignal.reason);');
    expect(src).toContain('{ once: true }');
  });
});

describe('[fetch 路径] 取消必须原样抛给页面，绝不回退原生请求', () => {
  it('把页面的 signal 透传进 proxyFetch（init 优先，缺失时回退 Request 自带的）', () => {
    expect(interceptor).toContain('const signal = init?.signal ?? request?.signal ?? null;');
    expect(interceptor).toContain(
      'return await proxyFetch(url, rule, { method, headers, body: (body ?? null) as BodyInit | null, signal });',
    );
  });

  it('catch 里先判取消，再判阻断与回退（顺序错了等于把取消的请求再发一遍）', () => {
    const catchAt = interceptor.indexOf('      } catch (error) {\n        // 页面已取消');
    const src = interceptor.slice(catchAt, interceptor.indexOf('    };', catchAt));
    const cancelAt = src.indexOf('if (signal?.aborted) throw error;');
    const blockedAt = src.indexOf('__proxyBlocked');
    const fallbackAt = src.indexOf("bump('fellBack');");
    expect(catchAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeGreaterThan(-1);
    expect(blockedAt).toBeGreaterThan(cancelAt);
    expect(fallbackAt).toBeGreaterThan(cancelAt);
  });
});

describe('[XHR 路径] abort() 与 xhr.timeout 到期都要转成后台的取消', () => {
  it('proxyFetch 把 requestId 交给调用方，实例上才谈得上取消哪一笔', () => {
    expect(interceptor).toContain('function proxyFetch(');
    expect(interceptor).toContain('onRequestId?: (requestId: string) => void');
    expect(interceptor).toContain('onRequestId?.(requestId);');
    const xhrSend = interceptor.slice(
      interceptor.indexOf('const headers: Record<string, string> = (this as any).__proxyHeaders || {};'),
      interceptor.indexOf('// ---- Intercept WebSocket'),
    );
    expect(xhrSend).toContain('(xhr as any).__proxyRequestId = requestId;');
  });

  it('open() 清掉上一笔的 requestId（实例被复用取消时不会误伤新请求）', () => {
    const open = interceptor.slice(
      interceptor.indexOf('XMLHttpRequest.prototype.open = function'),
      interceptor.indexOf('XMLHttpRequest.prototype.abort = function'),
    );
    expect(open).toContain("(this as any).__proxyRequestId = '';");
  });

  it('取消一个已交给后台的 XHR：有 requestId 才发 CANCEL_REQUEST', () => {
    const helperAt = interceptor.indexOf('function cancelProxiedXhr(');
    expect(helperAt).toBeGreaterThan(-1);
    const helper = interceptor.slice(helperAt, interceptor.indexOf('\n    }', helperAt));
    expect(helper).toContain('if (!requestId) return;');
    expect(helper).toContain(
      'window.postMessage({ channel: CHANNEL, type: CANCEL_REQUEST, data: { requestId } }, window.location.origin);',
    );
  });

  it('abort() 与 xhr.timeout 到期各调一次 cancelProxiedXhr', () => {
    const abort = interceptor.slice(
      interceptor.indexOf('XMLHttpRequest.prototype.abort = function'),
      interceptor.indexOf('// Collect request headers'),
    );
    expect(abort).toContain('cancelProxiedXhr(this);');

    const timeoutBlock = interceptor.slice(
      interceptor.indexOf('if (xhr.timeout > 0) {'),
      interceptor.indexOf('}, xhr.timeout);'),
    );
    expect(timeoutBlock).toContain('cancelProxiedXhr(xhr);');
  });
});

describe('[桥接层] 只把 requestId 转给后台，不带 URL/头/正文', () => {
  it('CANCEL_REQUEST 分支排在 PROXY_REQUEST 的提前返回之前', () => {
    const cancelAt = bridge.indexOf('if (event.data?.type === MessageType.CANCEL_REQUEST) {');
    const proxyAt = bridge.indexOf('if (event.data?.type !== MessageType.PROXY_REQUEST) return;');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(proxyAt).toBeGreaterThan(cancelAt);
  });

  it('载荷先收窄成字符串 requestId，转发只带这一个键', () => {
    const start = bridge.indexOf('if (event.data?.type === MessageType.CANCEL_REQUEST) {');
    const block = bridge.slice(start, bridge.indexOf('\n      }', start));
    expect(block).toContain("typeof requestId !== 'string' || !requestId");
    expect(block).toContain('data: { requestId }');
    expect(block).not.toMatch(/\burl:/);
    expect(block).not.toContain('headers');
  });

  it('发完即止：不等 SW 的回执，SW 回收期也不该在控制台留噪音', () => {
    const start = bridge.indexOf('if (event.data?.type === MessageType.CANCEL_REQUEST) {');
    const block = bridge.slice(start, bridge.indexOf('\n      }', start));
    expect(block).toContain('void chrome.runtime');
    expect(block).toContain('.sendMessage({ type: MessageType.CANCEL_REQUEST, data: { requestId } })');
    expect(block).toContain('.catch(() => {})');
  });
});
