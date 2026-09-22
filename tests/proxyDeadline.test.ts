import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProxyRule } from '@/utils/types';

// ═══════════════════════════════════════════════════════════════════════════════
// P1②：30s 截止时间必须覆盖到「body 读满」，而不是拿到响应头就撤掉
//
// `clearTimeout` 原本紧跟在 `await fetch()` 之后，而 `content-type` 含 `text/` 或
// `application/json` 的响应接下来走的是 `await response.text()`。此后后台侧这笔请求
// 再没有任何截止：`text/event-stream` 这类不结束的流会把上游连接一直握到 SW 被回收，
// 而日志是在 body 读满之后才落的，所以这条请求在日志里根本不存在；页面只能等它自己的
// 兜底超时（延迟 + 30s×(重试+1) + 间隔×重试 + 5s），配了延迟或重试时是几分钟。
// 更糟的是「慢但最终成功」：body 在页面兜底之后才落地时，SW 交回的是 200，页面已经
// 失败 —— 日志一条 200、界面一次报错，两边各说各话。
// ═══════════════════════════════════════════════════════════════════════════════

const SSE_RULE: ProxyRule = {
  id: 'sse',
  name: '流式接口（复杂规则 → SW 通道）',
  enabled: true,
  matchPattern: 'https://api.example.com/stream*',
  targetUrl: '',
  matchType: 'wildcard',
  priority: 10,
  // headerOverrides 让它必然走后台通道，不会被分流到 DNR
  headerOverrides: { 'x-proxied': '1' },
  createdAt: 0,
  updatedAt: 0,
};

/** `handleProxyRequest` 的返回形状（只取本测试关心的三字段，多出的字段结构上天然兼容） */
interface ProxiedResponse {
  status: number;
  statusText: string;
  body: string;
}

describe('handleProxyRequest — 截止时间覆盖 body 读取', () => {
  const store: Record<string, unknown> = {};
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    fetchMock.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
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

  /**
   * 取回模块后再启动请求，返回**未落定**的 promise。
   *
   * 包一层对象是必需的：`async` 函数直接 return promise 会被展平，调用方就拿不到
   * 「先启动、再推进 fake time」这个时机了。而 `import()` 走的是真实 I/O，把它混进
   * 推进循环里会让请求在 fake time 到终点时还没开始。
   */
  async function startRequest() {
    const { handleProxyRequest } = await import('@/entrypoints/background/proxyHandler');
    return {
      pending: handleProxyRequest({
        requestId: 'req-1',
        url: 'https://api.example.com/stream',
        method: 'GET',
        headers: {},
      }),
    };
  }

  /**
   * 把 fake time 按 5s 步进推进，途中 `pending` 一旦落定就返回；到终点仍未落定则返回 undefined。
   *
   * 不用单次 `advanceTimersByTimeAsync(40_000)`：正好落在步进终点的 timer 不保证被触发。
   * 而挂起本身就是 P1② 的症状，所以这里把它折成 undefined，让断言说人话，
   * 而不是让整支测试以「Test timed out in 5000ms」收场。
   */
  async function advanceUntilSettled(pending: Promise<ProxiedResponse>, targetMs: number) {
    let done: { value: ProxiedResponse } | undefined;
    void pending.then(value => {
      done = { value };
    });
    const step = 5_000;
    for (let elapsed = 0; elapsed < targetMs && !done; elapsed += step) {
      await vi.advanceTimersByTimeAsync(Math.min(step, targetMs - elapsed));
    }
    return done?.value;
  }

  /** 响应头先到、body 拖到 fake time 40s 才落地的「慢流」；abort 让 body 读取 reject —— 真实 fetch 就是这个语义 */
  function stubSlowStream(onBodyLanded: () => void) {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return {
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        text: () =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              onBodyLanded();
              resolve('data: late\n\n');
            }, 40_000);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
            });
          }),
        arrayBuffer: () => Promise.reject(new Error('text/ 分支不该读二进制')),
      };
    });
  }

  it('body 在 30s 内读不完时按超时失败，而不是把后台那笔请求挂到 SW 回收', async () => {
    store['proxy_config'] = { enabled: true, rules: [SSE_RULE] };
    let bodyLanded = false;
    stubSlowStream(() => {
      bodyLanded = true;
    });

    const { pending } = await startRequest();
    const resp = await advanceUntilSettled(pending, 60_000);

    // 'never-settled' 让「挂起」和「等迟到的 body」两种失败都读得出原因
    expect(resp?.statusText ?? 'never-settled').toBe('Proxy Error');
    expect(resp?.body ?? '').toContain('timeout');
    // 必须是在 30s 被截止掐断的，而不是等那笔迟到的 body 落地之后才失败
    expect(bodyLanded).toBe(false);
  });

  it('body 在截止时间前读满时照原样返回，快响应不受影响', async () => {
    store['proxy_config'] = { enabled: true, rules: [SSE_RULE] };
    fetchMock.mockImplementation(async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve('hello'),
    }));

    const { pending } = await startRequest();

    expect(await pending).toMatchObject({ status: 200, body: 'hello' });
  });
});
