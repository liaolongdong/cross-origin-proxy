import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rewriteUrl, matchRule } from '@/utils/urlMatcher';
import { buildRegexFilter, buildRegexSubstitution } from '@/utils/dnrRules';
import type { ProxyRule, RequestLogEntry } from '@/utils/types';

// ═══════════════════════════════════════════════════════════════════════════════
// 回归测试（第二轮）：多 * 通配符重写、日志计数、刷写串行化
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 让桩与真实 `chrome.storage.local.get` 同形：每次给的是反序列化副本，而不是存储里那个对象。
 *
 * 按引用返回时，读到的数组就是存储里的那一份，调用方就地改它等于**没写就改成了**——
 * 「写入是否发生了」这类断言会自己变绿。
 */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: '',
    targetUrl: '',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('rewriteUrl — 多 * 通配符（修复：SW 通道重写失效）', () => {
  it('子域名 + 路径双通配正确重写', () => {
    const rule = makeRule({
      matchPattern: 'https://*.example.com/*',
      targetUrl: 'https://proxy.internal',
    });
    expect(rewriteUrl('https://api.example.com/v1/users?id=1', rule)).toBe('https://proxy.internal/v1/users?id=1');
  });

  it('协议通配 *:// 正确重写', () => {
    const rule = makeRule({
      matchPattern: '*://*.example.com/*',
      targetUrl: 'https://proxy.internal',
    });
    expect(rewriteUrl('http://api.example.com/a/b', rule)).toBe('https://proxy.internal/a/b');
  });

  it('末尾 * 捕获为空时不补斜杠', () => {
    const rule = makeRule({
      matchPattern: 'https://*.example.com/*',
      targetUrl: 'https://proxy.internal',
    });
    expect(rewriteUrl('https://api.example.com/', rule)).toBe('https://proxy.internal');
  });

  it('中间 * 模式（不以 * 结尾）不做重写，返回原 URL', () => {
    const rule = makeRule({
      matchPattern: 'https://a.com/*/suffix',
      targetUrl: 'https://b.com',
    });
    expect(rewriteUrl('https://a.com/x/suffix', rule)).toBe('https://a.com/x/suffix');
  });

  it('空 targetUrl（仅注入请求头场景）不改写地址', () => {
    const rule = makeRule({
      matchPattern: '*://*.example.com/*',
      targetUrl: '',
      headerOverrides: { Authorization: 'Bearer x' },
    });
    expect(rewriteUrl('https://api.example.com/x', rule)).toBe('https://api.example.com/x');
  });

  it('SW 通道与 DNR 通道重写结果一致（多 * 通配）', () => {
    const rule = makeRule({
      matchPattern: '*://*.example.com/*',
      targetUrl: 'https://proxy.internal',
    });
    const url = 'https://api.example.com/v1/users?id=1';

    const swResult = rewriteUrl(url, rule);

    // 模拟 DNR：regexFilter 匹配后用 regexSubstitution 替换 \n 引用
    const filter = buildRegexFilter(rule);
    const substitution = buildRegexSubstitution(rule);
    const m = new RegExp(filter).exec(url);
    expect(m).not.toBeNull();
    const dnrResult = substitution.replace(/\\(\d)/g, (_, n: string) => m![Number(n)] ?? '');

    expect(swResult).toBe(dnrResult);
  });
});

describe('wildcard 匹配与重写的协同', () => {
  it('能匹配的多 * 规则必能重写（不再出现"匹配但不重写"的分裂）', () => {
    const rule = makeRule({
      matchPattern: '*://*.example.com/*',
      targetUrl: 'https://proxy.internal',
    });
    const url = 'https://sub.example.com/path';
    expect(matchRule(url, rule)).toBe(true);
    expect(rewriteUrl(url, rule)).not.toBe(url);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getProxyStatus — 经扩展（SW 通道）请求计数（修复：批间顺序假设导致漏计）
// ═══════════════════════════════════════════════════════════════════════════════

describe('getProxyStatus — swRequestCount（原 todayRequestCount：只覆盖 SW 通道）', () => {
  const store: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: clone(store[key]) })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
      alarms: {
        get: vi.fn(async () => undefined),
      },
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function makeLog(id: string, timestamp: number): RequestLogEntry {
    return {
      id,
      timestamp,
      ruleId: 'r1',
      ruleName: 'rule',
      originalUrl: 'https://a.com/x',
      proxiedUrl: 'https://b.com/x',
      method: 'GET',
      proxyType: 'sw',
    };
  }

  it('批内升序 + 批间新到旧的日志顺序下，今日计数不漏计', async () => {
    const todayAt = new Date();
    todayAt.setHours(9, 0, 0, 0);
    const today9 = todayAt.getTime();
    const today10 = today9 + 3600_000;
    const today11 = today9 + 2 * 3600_000;
    const yesterday = today9 - 24 * 3600_000;

    // 模拟 unshift 刷写后的实际存储顺序：
    // 新批次整体在前（批内时间升序），旧批次在后
    store['request_logs'] = [
      makeLog('b2-1', today10),
      makeLog('b2-2', today11),
      makeLog('b1-1', yesterday),
      makeLog('b1-2', today9), // 旧批次中也有今日日志（跨批场景）
    ];
    store['proxy_config'] = { enabled: true, rules: [] };

    const { getProxyStatus } = await import('@/entrypoints/background/proxyHandler');
    const status = await getProxyStatus();
    expect(status.swRequestCount).toBe(3);
  });

  it('无今日日志时计数为 0', async () => {
    const yesterday = Date.now() - 86_400_000 - 3600_000;
    store['request_logs'] = [makeLog('old-1', yesterday), makeLog('old-2', yesterday + 60_000)];
    store['proxy_config'] = { enabled: true, rules: [] };

    const { getProxyStatus } = await import('@/entrypoints/background/proxyHandler');
    const status = await getProxyStatus();
    expect(status.swRequestCount).toBe(0);
  });

  it('旧字段名不得复活：它的名字在承诺「今日全部请求」，而它只数得到后台通道', async () => {
    store['request_logs'] = [makeLog('any', Date.now())];
    store['proxy_config'] = { enabled: true, rules: [] };

    const { getProxyStatus } = await import('@/entrypoints/background/proxyHandler');
    const status = await getProxyStatus();
    expect(status).not.toHaveProperty('todayRequestCount');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// flushLogs — 串行化（修复：并发刷写互相覆盖丢日志）与刷写节奏（M-9：阈值、在途合并）
// ═══════════════════════════════════════════════════════════════════════════════

describe('flushLogs — 并发刷写不丢日志', () => {
  const store: Record<string, unknown> = {};

  function logEntry(id: string, timestamp: number): RequestLogEntry {
    return {
      id,
      timestamp,
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
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: clone(store[key]) })),
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
    vi.useRealTimers();
  });

  // 实测过的一件事：这一条**钉不住**「刷写串行队列被摘掉」那个变异点（把队列改成直接并发执行后，
  // 本条在按引用与按副本两份桩下都仍然绿——桩的 `get`/`set` 立即落定，`await addRequestLog` 的每个
  // 微任务间隙足够第一批刷完，真正的重叠没有被制造出来）。那个变异点由下面「连续三次刷写」那条，
  // 以及 `tests/round4-regression.test.ts` 里「清空落在 flush 读取之后、写入之前」那条咬住（后者复用同一条队列）。
  it('两批缓冲并发刷写后全部保留', async () => {
    store['request_logs'] = [];
    const { addRequestLog, flushLogs, getRequestLogs } = await import('@/utils/storage');

    const now = Date.now();
    // 第一批 3 条
    for (let i = 0; i < 3; i++) {
      await addRequestLog(logEntry(`a${i}`, now + i));
    }
    // 第一次刷写刚进入队列（尚未完成）时，第二批入缓冲并再次触发刷写 —— 模拟阈值与定时器交叠
    const p1 = flushLogs();
    for (let i = 0; i < 2; i++) {
      await addRequestLog(logEntry(`b${i}`, now + 10 + i));
    }
    const p2 = flushLogs();
    await Promise.all([p1, p2]);

    const logs = await getRequestLogs();
    const ids = logs.map(l => l.id);
    expect(logs).toHaveLength(5);
    expect(ids).toContain('a0');
    expect(ids).toContain('b1');
  });

  it('连续三次刷写不重不漏', async () => {
    store['request_logs'] = [];
    const { addRequestLog, flushLogs, getRequestLogs } = await import('@/utils/storage');

    const now = Date.now();
    await addRequestLog(logEntry('x1', now));
    const p1 = flushLogs();
    await addRequestLog(logEntry('x2', now + 1));
    const p2 = flushLogs();
    await addRequestLog(logEntry('x3', now + 2));
    const p3 = flushLogs();
    await Promise.all([p1, p2, p3]);

    const logs = await getRequestLogs();
    expect(logs.map(l => l.id).sort()).toEqual(['x1', 'x2', 'x3']);
  });

  /**
   * 阈值从 10 抬到 20（M-9）
   *
   * 一笔刷写的代价是整份表的序列化，条数只决定「刷几次」——突发流量的成本是「写放大 × 整包」，
   * 阈值翻倍就把它砍掉一半。日志可见延迟本来就由那条 1s 防抖定调（不是由条数定调）。
   * 这一条钉的是「19 条绝不落盘、第 20 条立刻落一次」两格：只改回 10 会让第一格红，
   * 把阈值判断整个摘掉（只靠防抖）会让第二格红。
   */
  it('攒够 20 条才立即刷写；19 条只交给 1s 防抖', async () => {
    store['request_logs'] = [];
    const { addRequestLog, getRequestLogs } = await import('@/utils/storage');
    const setMock = vi.mocked(chrome.storage.local.set);
    const now = Date.now();

    for (let i = 0; i < 19; i++) {
      await addRequestLog(logEntry(`t${i}`, now + i));
    }
    // 假定时器不走时间：防抖那一次还没到，整程一次写盘都不该发生
    expect(setMock).not.toHaveBeenCalled();

    await addRequestLog(logEntry('t19', now + 19));
    await vi.advanceTimersByTimeAsync(0); // 只排空微任务，不越过 1s 的防抖

    expect(setMock).toHaveBeenCalledTimes(1);
    const ids = (await getRequestLogs()).map(l => l.id);
    expect(ids).toHaveLength(20);
    // 头部是最新：倒着接进去的那一批，最后一条才是刚发生的请求
    expect(ids[0]).toBe('t19');
  });

  /**
   * 刷写在途时入缓冲的那一条，由同一轮的收尾捞走（M-9 的合并）
   *
   * 一次刷写的 `await` 期间页面照样在发请求，那些日志不进已取走的快照。改动前它们靠「下一次
   * `flushLogs()` 再排一轮」落盘——突发 100 条就是 10 轮整包写排队。现在队列里只允许有一轮，
   * 于是这一条同时钉两件事：合并后**没有漏**（在途那条照样落盘），也**没有多**（只写两轮，不是三轮）。
   * `set` 被挂住是为了把「第一轮正在写」这个瞬间钉住，不靠微任务计数碰运气。
   */
  it('刷写在途入缓冲的日志被同一轮补跑捞走，且不追加排队', async () => {
    store['request_logs'] = [];
    const { addRequestLog, flushLogs, getRequestLogs } = await import('@/utils/storage');
    const setMock = vi.mocked(chrome.storage.local.set);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    setMock.mockImplementation(async (items: Record<string, unknown>) => {
      await gate;
      Object.assign(store, items);
    });

    await addRequestLog(logEntry('in1', Date.now()));
    const p1 = flushLogs();
    await vi.advanceTimersByTimeAsync(0); // 让第一轮跑到 `set` 里被挂住

    await addRequestLog(logEntry('in2', Date.now() + 1));
    const p2 = flushLogs();
    release();
    await Promise.all([p1, p2]);

    expect((await getRequestLogs()).map(l => l.id)).toEqual(['in2', 'in1']);
    // 两轮：第一轮带走在途之前那条，收尾补跑带走在途那条；排队的第三轮不该存在
    expect(setMock).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizeImportedRules — 导入 id 重生成（修复：合并导入 id 冲突）
// ═══════════════════════════════════════════════════════════════════════════════

describe('normalizeImportedRules — 导入规则规范化', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn() },
      },
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('重新生成 id 并保留其余字段', async () => {
    const { normalizeImportedRules } = await import('@/entrypoints/background/messageRouter');
    const out = normalizeImportedRules([
      {
        id: 'old-id-from-file',
        name: 'n',
        matchPattern: 'https://a.com/*',
        targetUrl: 'https://b.com',
        matchType: 'wildcard',
        priority: 5,
        enabled: true,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).not.toBe('old-id-from-file');
    expect(out[0].id).toBeTruthy();
    expect(out[0].priority).toBe(5);
    expect(out[0].enabled).toBe(true);
    expect(out[0].createdAt).toBe(1);
  });

  it('小数优先级被取整（DNR 只接受整数，1.5 会让整批 updateDynamicRules 被拒）', async () => {
    const { normalizeImportedRules } = await import('@/entrypoints/background/messageRouter');
    const out = normalizeImportedRules([
      {
        id: 'x',
        name: 'n',
        matchPattern: 'https://a.com/*',
        targetUrl: 'https://b.com',
        matchType: 'wildcard',
        priority: 1.5,
      },
      {
        id: 'y',
        name: 'n2',
        matchPattern: 'https://a.com/*',
        targetUrl: 'https://b.com',
        matchType: 'wildcard',
        priority: '3',
      },
    ]);
    expect(out[0].priority).toBe(2);
    // 字符串不是有限数 → 回落默认值，而不是留下 "3" 让下游算出 NaN
    expect(out[1].priority).toBe(100);
  });

  it('两次导入同一份数据不会产生重复 id', async () => {
    const { normalizeImportedRules } = await import('@/entrypoints/background/messageRouter');
    const raw = [
      {
        id: 'same-id',
        name: 'n',
        matchPattern: 'https://a.com/*',
        targetUrl: 'https://b.com',
        matchType: 'wildcard',
      },
    ];
    const first = normalizeImportedRules(raw);
    const second = normalizeImportedRules(raw);
    expect(first[0].id).not.toBe(second[0].id);
  });

  it('过滤结构非法的条目并补默认值', async () => {
    const { normalizeImportedRules } = await import('@/entrypoints/background/messageRouter');
    const out = normalizeImportedRules([
      null,
      { name: 'missing-fields' },
      {
        id: 'ok',
        name: 'valid',
        matchPattern: 'https://a.com/*',
        targetUrl: 'https://b.com',
        matchType: 'bad-type',
      },
      {
        id: 'ok2',
        name: 'valid2',
        matchPattern: 'https://a.com/*',
        targetUrl: 'https://b.com',
        matchType: 'prefix',
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe(100);
    expect(out[0].enabled).toBe(false);
  });

  it('清洗导入的 headerOverrides：脏头逐条剔除，合法头保留；非法结构整体丢弃', async () => {
    const { normalizeImportedRules } = await import('@/entrypoints/background/messageRouter');
    const base = {
      matchPattern: 'https://a.com/*',
      targetUrl: 'https://b.com',
      matchType: 'wildcard',
    };
    const [mixed, broken] = normalizeImportedRules([
      {
        ...base,
        id: 'mixed',
        name: 'mixed',
        headerOverrides: { Accept: 'application/json', 'X Bad': 'v', 'X-Ok': 'a\r\nb', 'X-Keep': 'y' },
      },
      { ...base, id: 'broken', name: 'broken', headerOverrides: 'not-a-map' },
    ]);
    // 只留名与值都合规的那条；运行时的整条拒绝（页面拿到 status 0）不该由导入文件触发
    expect(mixed.headerOverrides).toEqual({ Accept: 'application/json', 'X-Keep': 'y' });
    expect(broken).not.toHaveProperty('headerOverrides');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleProxyRequest — 阻断契约与状态钳制
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleProxyRequest — 阻断与状态码钳制', () => {
  const store: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: clone(store[key]) })),
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
    vi.useRealTimers();
  });

  it('阻断规则返回 status 0 + statusText "Blocked"（MAIN 拦截器据此真正拦截而非回退）', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [
        makeRule({
          matchPattern: 'https://blocked.example.com/*',
          targetUrl: 'https://any.example.com',
          blocked: true,
        }),
      ],
    };
    const { handleProxyRequest } = await import('@/entrypoints/background/proxyHandler');
    const resp = await handleProxyRequest({
      requestId: 'req-1',
      url: 'https://blocked.example.com/api',
      method: 'GET',
      headers: {},
    });
    expect(resp.status).toBe(0);
    expect(resp.statusText).toBe('Blocked');
  });

  it('Mock 状态码低于 200 时钳制为 200（保证前端可构造 Response）', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [
        makeRule({
          matchPattern: 'https://mock.example.com/*',
          targetUrl: 'https://any.example.com',
          mockResponse: { body: '{"ok":true}', status: 100 },
        }),
      ],
    };
    const { handleProxyRequest } = await import('@/entrypoints/background/proxyHandler');
    const resp = await handleProxyRequest({
      requestId: 'req-2',
      url: 'https://mock.example.com/api',
      method: 'GET',
      headers: {},
    });
    expect(resp.status).toBe(200);
  });

  it('Mock 状态码高于 599 时钳制为 599', async () => {
    store['proxy_config'] = {
      enabled: true,
      rules: [
        makeRule({
          matchPattern: 'https://mock.example.com/*',
          targetUrl: 'https://any.example.com',
          mockResponse: { body: '{}', status: 999 },
        }),
      ],
    };
    const { handleProxyRequest } = await import('@/entrypoints/background/proxyHandler');
    const resp = await handleProxyRequest({
      requestId: 'req-3',
      url: 'https://mock.example.com/api',
      method: 'GET',
      headers: {},
    });
    expect(resp.status).toBe(599);
  });
});
