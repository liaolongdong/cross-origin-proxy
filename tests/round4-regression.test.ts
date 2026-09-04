import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageType } from '@/utils/types';
import type { ProxyRule, RequestLogEntry } from '@/utils/types';

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: 'https://api.example.com/*',
    targetUrl: 'https://target.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// 模拟 fetch 规范：GET/HEAD 携带 body 时 Promise 拒绝 TypeError
function fetchThatRejectsBodylessMethods() {
  return vi.fn((_url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if ((method === 'GET' || method === 'HEAD') && init?.body != null) {
      return Promise.reject(new TypeError('Request with GET/HEAD method cannot have body.'));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

describe('handleProxyRequest — requestBodyOverride 与 GET/HEAD（回归）', () => {
  const store: Record<string, unknown> = {};
  let fetchMock: ReturnType<typeof fetchThatRejectsBodylessMethods>;

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    fetchMock = fetchThatRejectsBodylessMethods();
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

  async function importHandler() {
    const { handleProxyRequest } = await import('@/entrypoints/background/proxyHandler');
    return handleProxyRequest;
  }

  it('GET 请求命中带 requestBodyOverride 的规则时不携带 body，代理正常返回', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ requestBodyOverride: '{"override":true}' })],
    };
    const handleProxyRequest = await importHandler();
    const resp = await handleProxyRequest({
      requestId: 'req-get',
      url: 'https://api.example.com/api',
      method: 'GET',
      headers: {},
    });
    expect(resp.status).toBe(200);
    expect(JSON.parse(resp.body)).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });

  it('页面传小写 get 方法时同样不携带 body', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ requestBodyOverride: '{"override":true}' })],
    };
    const handleProxyRequest = await importHandler();
    const resp = await handleProxyRequest({
      requestId: 'req-get-lower',
      url: 'https://api.example.com/api',
      method: 'get',
      headers: {},
    });
    expect(resp.status).toBe(200);
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });

  it('HEAD 请求同样不携带 body', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ requestBodyOverride: '{"override":true}' })],
    };
    const handleProxyRequest = await importHandler();
    const resp = await handleProxyRequest({
      requestId: 'req-head',
      url: 'https://api.example.com/api',
      method: 'HEAD',
      headers: {},
    });
    expect(resp.status).toBe(200);
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });

  it('POST 请求仍按规则覆盖请求体', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({ requestBodyOverride: '{"override":true}' })],
    };
    const handleProxyRequest = await importHandler();
    await handleProxyRequest({
      requestId: 'req-post',
      url: 'https://api.example.com/api',
      method: 'POST',
      headers: {},
      body: '{"original":true}',
    });
    expect(fetchMock.mock.calls[0][1]?.body).toBe('{"override":true}');
  });

  it('GET 请求携带的原始 body 也被跳过（行为与修复前一致）', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [makeRule({})],
    };
    const handleProxyRequest = await importHandler();
    const resp = await handleProxyRequest({
      requestId: 'req-get-body',
      url: 'https://api.example.com/api',
      method: 'GET',
      headers: {},
      body: '{"original":true}',
    });
    expect(resp.status).toBe(200);
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// clearRequestLogs — 与进行中 flush 的竞态（回归）
// ═══════════════════════════════════════════════════════════════════════════════

describe('clearRequestLogs — 与进行中 flush 的竞态', () => {
  const store: Record<string, unknown> = {};

  function logEntry(id: string): RequestLogEntry {
    return {
      id,
      timestamp: Date.now(),
      ruleId: 'r1',
      ruleName: 'rule',
      originalUrl: 'https://a.com/x',
      proxiedUrl: 'https://b.com/x',
      method: 'GET',
      proxyType: 'sw',
    };
  }

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('清空落在 flush 读取之后、写入之前时，旧日志不复活', async () => {
    store['request_logs'] = [logEntry('old')];

    // 第一次 set（flush 的写入）挂起，模拟 flush 在 read 与 write 之间被调度打断
    let releaseWrite!: () => void;
    let onWriteCalled!: () => void;
    const writeCalled = new Promise<void>(r => {
      onWriteCalled = r;
    });
    const writeGate = new Promise<void>(r => {
      releaseWrite = r;
    });
    let setCallCount = 0;
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            setCallCount++;
            if (setCallCount === 1) {
              onWriteCalled();
              await writeGate;
            }
            Object.assign(store, obj);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
    });

    const { addRequestLog, flushLogs, clearRequestLogs, getRequestLogs } = await import('@/utils/storage');

    await addRequestLog(logEntry('new'));
    const flushDone = flushLogs();
    await writeCalled; // flush 已持旧数据并尝试写入（挂起中）

    const clearDone = clearRequestLogs();
    releaseWrite();
    await Promise.all([flushDone, clearDone]);

    expect(await getRequestLogs()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// messageRouter — message.data 缺失/非法时安全降级（回归）
// ═══════════════════════════════════════════════════════════════════════════════

describe('messageRouter — 缺失或非法 data 时回传错误而非抛异常', () => {
  type RouterListener = (
    message: unknown,
    sender: unknown,
    sendResponse: (response?: unknown) => void,
  ) => boolean | undefined;

  let listener: RouterListener | undefined;

  beforeEach(() => {
    listener = undefined;
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: () => 'chrome-extension://test/',
        onMessage: {
          addListener: vi.fn((fn: RouterListener) => {
            listener = fn;
          }),
        },
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
        onChanged: { addListener: vi.fn() },
      },
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const trustedSender = { url: 'chrome-extension://test/options/index.html' };

  const cases: Array<[string, MessageType, unknown]> = [
    ['TOGGLE_PROXY data 缺失', MessageType.TOGGLE_PROXY, undefined],
    ['TOGGLE_RULE data 缺失', MessageType.TOGGLE_RULE, undefined],
    ['ADD_RULE data 缺失', MessageType.ADD_RULE, undefined],
    ['UPDATE_RULE rule 缺失', MessageType.UPDATE_RULE, {}],
    ['DELETE_RULE data 缺失', MessageType.DELETE_RULE, undefined],
    ['BATCH_TOGGLE_RULES enabled 缺失', MessageType.BATCH_TOGGLE_RULES, { ruleIds: ['a'] }],
    ['REORDER_RULES data 缺失', MessageType.REORDER_RULES, undefined],
    ['LOAD_PROFILE data 缺失', MessageType.LOAD_PROFILE, undefined],
    ['DELETE_PROFILE data 缺失', MessageType.DELETE_PROFILE, undefined],
  ];

  for (const [name, type, data] of cases) {
    it(`${name} 时同步回传 { success: false }`, async () => {
      const { setupMessageRouter } = await import('@/entrypoints/background/messageRouter');
      setupMessageRouter();
      expect(listener).toBeTypeOf('function');

      const sendResponse = vi.fn();
      const result = listener!({ type, data }, trustedSender, sendResponse);

      expect(sendResponse).toHaveBeenCalledWith({ success: false, error: expect.any(String) });
      expect(result).toBe(false);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// updateRule — 整体替换语义（修复：编辑规则后关闭的 mock/拦截等开关无法清除旧值）
// ═══════════════════════════════════════════════════════════════════════════════

describe('updateRule — 整体替换语义（H1）', () => {
  const store: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
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
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updates 未包含 mockResponse/blocked 时旧值被清除，id/createdAt 保留', async () => {
    const createdAt = 1700000000000;
    store['proxy_config'] = {
      enabled: true,
      rules: [
        makeRule({
          mockResponse: { body: 'mocked', status: 200, contentType: 'application/json' },
          blocked: true,
          createdAt,
          updatedAt: createdAt,
        }),
      ],
    };
    const { updateRule, getProxyConfig } = await import('@/utils/storage');
    await updateRule('r1', {
      name: 'test',
      enabled: true,
      matchType: 'wildcard',
      matchPattern: 'https://api.example.com/*',
      targetUrl: 'https://target.example.com',
      priority: 10,
    });
    const config = await getProxyConfig();
    const rule = config.rules[0];
    expect(rule.mockResponse).toBeUndefined();
    expect(rule.blocked).toBeUndefined();
    expect(rule.id).toBe('r1');
    expect(rule.createdAt).toBe(createdAt);
  });

  it('updates 携带的字段完整保留', async () => {
    store['proxy_config'] = { enabled: true, rules: [makeRule({})] };
    const { updateRule, getProxyConfig } = await import('@/utils/storage');
    await updateRule('r1', {
      name: 'test',
      enabled: true,
      matchType: 'wildcard',
      matchPattern: 'https://api.example.com/*',
      targetUrl: 'https://target.example.com',
      priority: 10,
      mockResponse: { body: 'new-mock', status: 404, contentType: 'text/plain' },
    });
    const config = await getProxyConfig();
    expect(config.rules[0].mockResponse?.body).toBe('new-mock');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// useRuleManagement.updateRule — 发送整体替换规则，不携带旧值（H1 前端半）
// ═══════════════════════════════════════════════════════════════════════════════

describe('useRuleManagement.updateRule — 发送消息不携带被清除字段（H1）', () => {
  it('UPDATE_RULE 消息体不包含旧规则的 mockResponse', async () => {
    const sent: Array<{ type: string; data?: { rule?: Record<string, unknown> } }> = [];
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (msg: { type: string; data?: { rule?: Record<string, unknown> } }) => {
          sent.push(msg);
          if (msg.type === MessageType.GET_PROXY_CONFIG) {
            return {
              enabled: true,
              rules: [
                makeRule({
                  mockResponse: { body: 'old-mock', status: 200, contentType: 'application/json' },
                }),
              ],
            };
          }
          return { success: true };
        }),
      },
      storage: { onChanged: { addListener: vi.fn() } },
    });
    vi.resetModules();

    const { useRuleManagement } = await import('@/composables/useRuleManagement');
    const { fetchConfig, updateRule } = useRuleManagement();
    await fetchConfig();
    await updateRule('r1', {
      name: 'test',
      enabled: true,
      matchType: 'wildcard',
      matchPattern: 'https://api.example.com/*',
      targetUrl: 'https://target.example.com',
      priority: 10,
    });

    const updateMsg = sent.find(m => m.type === MessageType.UPDATE_RULE);
    expect(updateMsg).toBeDefined();
    expect(updateMsg?.data?.rule?.mockResponse).toBeUndefined();
    expect(updateMsg?.data?.rule?.name).toBe('test');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M1：筛选态拖拽重排 — 隐藏规则必须原地保留（旧实现会把隐藏规则挤到列表末尾）
// ═══════════════════════════════════════════════════════════════════════════════
describe('mergeReorderedVisible — 筛选态拖拽重排（M1）', () => {
  it('全量可见时按拖拽后顺序整体重排', async () => {
    const { mergeReorderedVisible } = await import('@/utils/ruleOrder');
    const full = [makeRule({ id: 'a' }), makeRule({ id: 'b' }), makeRule({ id: 'c' })];
    const reordered = [full[2], full[0], full[1]];
    expect(mergeReorderedVisible(full, reordered).map(r => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('筛选态下隐藏规则原地保留，可见规则占据原可见位置', async () => {
    const { mergeReorderedVisible } = await import('@/utils/ruleOrder');
    // 完整列表 [hidden, a, b]，筛选后只可见 [a, b]；拖拽为 [b, a]
    const hidden = makeRule({ id: 'hidden' });
    const a = makeRule({ id: 'a' });
    const b = makeRule({ id: 'b' });
    const full = [hidden, a, b];
    const result = mergeReorderedVisible(full, [b, a]);
    // b/a 占据原可见位置 1/2，hidden 停在 0
    expect(result.map(r => r.id)).toEqual(['hidden', 'b', 'a']);
  });

  it('筛选态下隐藏规则位于可见规则之后时同样原地保留', async () => {
    const { mergeReorderedVisible } = await import('@/utils/ruleOrder');
    const a = makeRule({ id: 'a' });
    const hidden1 = makeRule({ id: 'hidden1' });
    const b = makeRule({ id: 'b' });
    const hidden2 = makeRule({ id: 'hidden2' });
    const result = mergeReorderedVisible([a, hidden1, b, hidden2], [b, a]);
    expect(result.map(r => r.id)).toEqual(['b', 'hidden1', 'a', 'hidden2']);
  });
});
