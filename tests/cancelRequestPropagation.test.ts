import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * P1③（页面侧）：页面的 `AbortSignal` 必须一路走到后台那笔上游请求
 *
 * 页面把 `AbortController` 交给 fetch/XHR 之后，拦截器只是把**迟到**的代理响应丢掉：
 * 上游连接继续握着、凭据继续外发、`retryCount` 继续追加尝试，SW 那边完全不知道页面已经不要了。
 * 现在取消要跨三个世界走完：MAIN world 监听 signal → `CANCEL_REQUEST` → 桥接层转发 →
 * SW 按 `(tabId, frameId, requestId)` 掐断 `AbortController`（拼法见
 * `entrypoints/background/proxyHandler.ts` 的 `proxyRequestKey`；路由与后台侧的行为由
 * `tests/cancelProxiedRequest.test.ts` 用真实现守住）。
 *
 * 这条通路的**结局**大多已有运行时用例按外部可观察面钉住：fetch 中途 abort「掐掉后台那一笔、
 * 按 `signal.reason` 落定、不回退原生」在 `tests/interceptorFetch.test.ts` 的「取消」一组，
 * XHR 的 `abort()` 与 `xhr.timeout`、requestId 交回调用方与 `open()` 清旧账在
 * `tests/interceptorXhr.test.ts`，桥接层转发只带 `requestId`（URL 与头不跟着进 SW）在
 * `tests/contentBridge.test.ts`。下面与它们重叠的用例是刻意留的：按源码钉的那几处一旦改名或
 * 挪走就红，运行时用例却只会安静地继续绿。
 *
 * 只有这一支守得住的，实测过两处（变异方向各自跑过）：
 * ① 桥接层「发完即止」——`sendMessage` 在 SW 回收期被拒时既不等回执也不在控制台留噪音；
 *    运行时那几组只观察转发的载荷，观察不到这条 promise 怎么落定。
 * ② `catch` 里三条判据的**先后**：把「先判取消」挪到「再判阻断」之后，`tests/interceptorFetch.test.ts`
 *    整份运行时用例全绿（不写条数：这个数会长，写死就成了下次漂移的源头），变的只有一种组合——
 *    被取消那一笔恰好命中阻断规则，页面拿到的就成了模拟网络错误的
 *    `TypeError` 而不是 `AbortError`（页面普遍按 `err.name === 'AbortError'` 分支）。
 *    作为对照，整句摘掉「先判取消」则是 `tests/interceptorFetch.test.ts`「取消」那一组里凡是断言
 *    「这一笔按取消落定」的那几条红（只写判据不写条数，理由同上一段）：取消走到回退分支，
 *    页面刚放弃的请求被原样再发一遍（真实浏览器里是网络行为，桩里表现为一次成功落定）。
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
    expect(src).toContain("addEventListener('abort', onPageAbort");
    expect(src).toContain('{ once: true }');

    // 处理器体单独切出来钉：`clearTimeout(timeout);` 在 `proxyFetch` 里有四处，
    // 整片 `toContain` 等于没钉（实测删掉处理器里那一句照样绿）。
    const handlerAt = src.indexOf('const onPageAbort = () => {');
    expect(handlerAt, '取消处理器不再是具名的 onPageAbort 了——把上面的锚点一起改掉，别删断言').toBeGreaterThan(-1);
    // 终止锚也要单独钉：找不到时 `indexOf` 给 -1，`slice(start, -1)` 会切到「整段末尾减一字符」，
    // 于是下面每一条 `toContain` 都在拿全文比——全都绿，却什么都没钉住。
    const handlerEnd = src.indexOf('\n        };', handlerAt);
    expect(handlerEnd, '取消处理器的收尾形状变了——换掉这里的终止锚，别删断言').toBeGreaterThan(handlerAt);
    const handler = src.slice(handlerAt, handlerEnd);
    expect(handler).toContain('if (!pendingRequests.has(requestId)) return;');
    expect(handler).toContain('clearTimeout(timeout);');
    expect(handler).toContain(
      'window.postMessage({ channel: CHANNEL, type: CANCEL_REQUEST, data: { requestId } }, window.location.origin);',
    );
    expect(handler).toContain('reject(pageSignal?.reason);');

    // 摘钩本身：只在页面给的那个 signal 真支持时才去调（`signal` 属页面传入物，只有
    // `addEventListener` 的 polyfill 并不少见），且抛错也得吞掉——它在落定路径上。
    expect(src).toContain("typeof pageSignal.removeEventListener === 'function'");
    expect(src).toContain("removeEventListener('abort', onPageAbort)");
    const detachAt = src.indexOf('detachAbort = () => {');
    expect(detachAt, '摘钩不再是闭包了——这里的锚点跟着改，别删断言').toBeGreaterThan(-1);
    // 不切「到某个终止锚为止」，改成以那句调用为分界：终止锚找不到时 `slice(a, -1)` 会退化成
    // 「一路切到段尾」，`try {` 于是从后面的响应构造分支里被捞到，这条就成了空断言。
    const removeAt = src.indexOf("pageSignal.removeEventListener('abort', onPageAbort)");
    expect(removeAt, '摘掉 abort 钩子的那句调用不见了').toBeGreaterThan(detachAt);
    expect(src.slice(detachAt, removeAt)).toContain('try {');
    expect(src.slice(removeAt, removeAt + 160)).toContain('catch {');
  });
});

describe('[fetch 路径] 取消必须原样抛给页面，绝不回退原生请求', () => {
  it('把页面的 signal 透传进 proxyFetch（init 优先，缺失时回退 Request 自带的）', () => {
    expect(interceptor).toContain('const signal = init?.signal ?? request?.signal ?? null;');
    expect(interceptor).toContain(
      'return await proxyFetch(url, rule, { method, headers, body: (body ?? null) as BodyInit | null, signal });',
    );
  });

  it('catch 里取消判定排在阻断与回退之前（颠倒的代价只在命中阻断规则那一格）', () => {
    // 顺序与「这一句在不在」是两种症状，各自实测过变异方向，详见文件头第 ② 条
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
