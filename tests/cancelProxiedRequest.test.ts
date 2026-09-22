import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageType } from '@/utils/types';
import type { ProxyRule } from '@/utils/types';

// ═══════════════════════════════════════════════════════════════════════════════
// P1③：页面取消一笔已交给后台的代发请求时，后台必须真的停止上游请求
//
// 页面把 `AbortController` 交给 fetch/XHR 之后，后台却照旧把整笔请求跑完：
// 上游连接继续占用、凭据继续外发、重试继续追加，页面只是把迟到的响应丢掉。
// 现在 `proxyRequestKey(tabId, requestId)` 是这笔在途请求的登记键，
// `cancelProxiedRequest(key)` 掐断它 —— 键里必须带 tabId，因为 requestId 是
// 每个页面各自从 1 开始数的计数器。
//
// 下面第二组用例走的是**真路由**：登记与取消两侧的键必须由同一个 `sender.tab.id`
// 拼出，否则这条通道在单测里成立、在浏览器里永远取消不掉任何东西。
// ═══════════════════════════════════════════════════════════════════════════════

/** 内容脚本的 `sender.url` 就是页面 URL，因此 `CANCEL_REQUEST` 必须留在 gate 外 */
const PAGE_URL = 'https://app.example.com/index.html';

type RouterListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

const BASE_RULE: ProxyRule = {
  id: 'r1',
  name: '复杂规则（SW 通道）',
  enabled: true,
  matchPattern: 'https://api.example.com/x*',
  targetUrl: '',
  matchType: 'wildcard',
  priority: 10,
  headerOverrides: { 'x-proxied': '1' },
  createdAt: 0,
  updatedAt: 0,
};

/** 开重试：用来证明「取消」不会被当成一次可重试的失败 */
const RETRY_RULE: ProxyRule = { ...BASE_RULE, id: 'r-retry', retryCount: 2, retryDelay: 100 };
/** 先延迟再发：用来证明取消发生在等待期间时，上游请求根本不会发出 */
const DELAYED_RULE: ProxyRule = { ...BASE_RULE, id: 'r-delay', delayMs: 5000 };

describe('后台代发的取消通道', () => {
  const store: Record<string, unknown> = {};
  const fetchMock = vi.fn();
  let routerListener: RouterListener | undefined;

  beforeEach(() => {
    routerListener = undefined;
    for (const key of Object.keys(store)) delete store[key];
    fetchMock.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getURL: (path?: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path ?? ''}`,
        onMessage: {
          addListener: vi.fn((fn: unknown) => {
            routerListener = fn as RouterListener;
          }),
        },
      },
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function load() {
    return import('@/entrypoints/background/proxyHandler');
  }

  /** 挂起直到 abort 的上游：真实网络就是这个语义——没人取消就永不落定 */
  function stubHangUntilAbort(onAbort: (callIndex: number) => void) {
    let callIndex = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const mine = callIndex++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          onAbort(mine);
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        });
      });
    });
  }

  /** 取 `sendResponse` 最后一次收到的载荷 */
  function lastResponse(dispatched: { sendResponse: ReturnType<typeof vi.fn> }) {
    return dispatched.sendResponse.mock.calls.at(-1)?.[0] as
      { success?: boolean; error?: string; cancelled?: boolean; statusText?: string } | undefined;
  }

  it('cancelProxiedRequest 掐断在途请求、按取消收口，且不被当成一次可重试的失败', async () => {
    store['proxy_config'] = { enabled: true, rules: [RETRY_RULE] };
    const aborted: number[] = [];
    stubHangUntilAbort(index => aborted.push(index));

    const { handleProxyRequest, cancelProxiedRequest, proxyRequestKey } = await load();
    const pending = handleProxyRequest(
      { requestId: 'req-1', url: 'https://api.example.com/x', method: 'GET', headers: {} },
      proxyRequestKey(7, 0, 'req-1'),
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(cancelProxiedRequest(proxyRequestKey(7, 0, 'req-1'))).toBe(true);
    const resp = await pending;

    expect(aborted).toEqual([0]);
    expect(resp.statusText).toBe('Proxy Error');
    expect(resp.body).toContain('ancel');
    // 取消不是 5xx、也不是网络抖动：不能借 retryCount 再发两次
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('登记表在请求落定后清掉：同一把 key 第二次取消返回 false', async () => {
    store['proxy_config'] = { enabled: true, rules: [BASE_RULE] };
    fetchMock.mockImplementation(async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve('hello'),
    }));

    const { handleProxyRequest, cancelProxiedRequest, proxyRequestKey } = await load();
    const key = proxyRequestKey(3, 0, 'req-ok');
    await handleProxyRequest(
      { requestId: 'req-ok', url: 'https://api.example.com/x', method: 'GET', headers: {} },
      key,
    );

    expect(cancelProxiedRequest(key)).toBe(false);
  });

  it('requestId 是页面自己的计数器，登记键必须按标签页隔离', async () => {
    store['proxy_config'] = { enabled: true, rules: [BASE_RULE] };
    const aborted: number[] = [];
    stubHangUntilAbort(index => aborted.push(index));

    const { handleProxyRequest, cancelProxiedRequest, proxyRequestKey } = await load();
    // 两个标签页各自从 req-1 开始数：requestId 完全相同
    const tabA = handleProxyRequest(
      { requestId: 'req-1', url: 'https://api.example.com/x', method: 'GET', headers: {} },
      proxyRequestKey(11, 0, 'req-1'),
    );
    const tabB = handleProxyRequest(
      { requestId: 'req-1', url: 'https://api.example.com/x', method: 'GET', headers: {} },
      proxyRequestKey(12, 0, 'req-1'),
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(cancelProxiedRequest(proxyRequestKey(11, 0, 'req-1'))).toBe(true);
    const respA = await tabA;

    expect(respA.statusText).toBe('Proxy Error');
    // 只掐该当那一笔：另一个标签页同名请求不能被动到
    expect(aborted).toEqual([0]);
    expect(cancelProxiedRequest(proxyRequestKey(12, 0, 'req-1'))).toBe(true);
    expect(aborted).toEqual([0, 1]);
    expect((await tabB).statusText).toBe('Proxy Error');
  });

  it('取消发生在配置延迟期间时，上游请求根本不再发出', async () => {
    store['proxy_config'] = { enabled: true, rules: [DELAYED_RULE] };
    const aborted: number[] = [];
    stubHangUntilAbort(index => aborted.push(index));

    const { handleProxyRequest, cancelProxiedRequest, proxyRequestKey } = await load();
    const pending = handleProxyRequest(
      { requestId: 'req-d', url: 'https://api.example.com/x', method: 'GET', headers: {} },
      proxyRequestKey(5, 0, 'req-d'),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(cancelProxiedRequest(proxyRequestKey(5, 0, 'req-d'))).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    const resp = await pending;

    expect(resp.statusText).toBe('Proxy Error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不带登记键的调用方（旧路径）行为不变：照常返回响应，也不登记', async () => {
    store['proxy_config'] = { enabled: true, rules: [BASE_RULE] };
    fetchMock.mockImplementation(async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve('hello'),
    }));

    const { handleProxyRequest, cancelProxiedRequest, proxyRequestKey } = await load();
    const resp = await handleProxyRequest({
      requestId: 'req-legacy',
      url: 'https://api.example.com/x',
      method: 'GET',
      headers: {},
    });

    expect(resp.status).toBe(200);
    expect(cancelProxiedRequest(proxyRequestKey(1, 0, 'req-legacy'))).toBe(false);
  });

  describe('经真路由的取消 — 登记与取消两侧的键必须由同一个 tabId 与 frameId 拼出', () => {
    /** 把一条消息打进 router 注册的真实监听器，返回同步的通道标记与 sendResponse 桩 */
    async function dispatch(type: MessageType, data: unknown, tabId: number, frameId = 0) {
      const router = await import('@/entrypoints/background/messageRouter');
      if (!routerListener) router.setupMessageRouter();
      const sendResponse = vi.fn();
      const keepChannelOpen = routerListener!(
        { type, data },
        { url: PAGE_URL, tab: { id: tabId }, frameId },
        sendResponse,
      );
      return { sendResponse, keepChannelOpen };
    }

    /** 起一笔会被路由登记的代发（总开关开着、规则命中、上游挂起） */
    async function startProxiedRequest(tabId: number, requestId: string, frameId = 0) {
      store['proxy_config'] = { enabled: true, rules: [BASE_RULE] };
      const aborted: number[] = [];
      stubHangUntilAbort(index => aborted.push(index));
      // 前一笔还挂在途上时 fetch 的总调用数已经在涨了，只能盯「这一次多了一次」
      const callsBefore = fetchMock.mock.calls.length;
      const proxy = await dispatch(
        MessageType.PROXY_REQUEST,
        { requestId, url: 'https://api.example.com/x', method: 'GET', headers: {} },
        tabId,
        frameId,
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
      return { ...proxy, aborted };
    }

    it('同一标签页的取消真的掐断那笔上游请求，并让在途的 PROXY_REQUEST 落定', async () => {
      const { aborted, ...request } = await startProxiedRequest(7, 'req-1');

      const cancel = await dispatch(MessageType.CANCEL_REQUEST, { requestId: 'req-1' }, 7);
      expect(cancel.keepChannelOpen).toBe(false);
      expect(lastResponse(cancel)).toEqual({ success: true, cancelled: true });
      // 取消是同步生效的，被掐断的那笔代发则要等它自己的 reject 链走完才回响应
      await vi.advanceTimersByTimeAsync(1);

      expect(aborted).toEqual([0]);
      expect(request.sendResponse).toHaveBeenCalledTimes(1);
      expect(lastResponse(request)).toMatchObject({ statusText: 'Proxy Error' });
      expect(JSON.stringify(lastResponse(request))).toContain('ancel');
    });

    it('另一个标签页同名的 requestId 取消不了它：登记表按标签页隔离', async () => {
      const { aborted, ...request } = await startProxiedRequest(7, 'req-1');

      const cancel = await dispatch(MessageType.CANCEL_REQUEST, { requestId: 'req-1' }, 8);
      expect(lastResponse(cancel)).toEqual({ success: true, cancelled: false });

      expect(aborted).toEqual([]);
      expect(request.sendResponse).not.toHaveBeenCalled();
    });

    it('同一标签页里两个 frame 各自从 req-1 数起：只能取消自己那一笔', async () => {
      // 注入到所有 frame 之后，每个 frame 有自己的拦截器与自己的 requestId 计数器，
      // 只按 tabId + requestId 登记会让两笔共用一个键——后登记的那笔把前一笔挤出登记表
      const top = await startProxiedRequest(7, 'req-1', 0);
      const sub = await startProxiedRequest(7, 'req-1', 1);

      const cancel = await dispatch(MessageType.CANCEL_REQUEST, { requestId: 'req-1' }, 7, 0);
      expect(lastResponse(cancel)).toEqual({ success: true, cancelled: true });
      await vi.advanceTimersByTimeAsync(1);

      // 顶层那一笔落定，子 frame 的在飞请求没人替它掐
      expect(lastResponse(top)).toMatchObject({ statusText: 'Proxy Error' });
      expect(sub.sendResponse).not.toHaveBeenCalled();
      expect(top.aborted).toEqual([0]);
      expect(sub.aborted).toEqual([]);
    });

    it('非法 requestId 被拒且不误伤在飞请求', async () => {
      const { aborted, ...request } = await startProxiedRequest(7, 'req-9');

      for (const payload of [{ requestId: 42 }, { requestId: '' }, null, undefined]) {
        const cancel = await dispatch(MessageType.CANCEL_REQUEST, payload, 7);
        expect(cancel.keepChannelOpen).toBe(false);
        expect(lastResponse(cancel)).toEqual({ success: false, error: 'Invalid requestId' });
      }

      expect(aborted).toEqual([]);
      expect(request.sendResponse).not.toHaveBeenCalled();
    });

    it('页面来源的取消不被 gate 拒（内容脚本的 sender.url 就是页面 URL）', async () => {
      const cancel = await dispatch(MessageType.CANCEL_REQUEST, { requestId: 'never-sent' }, 3);
      expect(lastResponse(cancel)?.error).not.toBe('Unauthorized sender');
    });
  });
});
