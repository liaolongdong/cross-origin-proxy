/**
 * MAIN world 拦截器的 fetch 通道：跑起来测，而不是 grep 源码
 *
 * `entrypoints/main-interceptor.content.ts` 有 10 个测试文件按源码字符串守着
 * （`interceptorStats` / `interceptorResponseGuard` / `cancelRequestPropagation` /
 * `channel-consistency` / `syncXhrFallback` / `xhrReadonlyProps` / `wsCapabilitySurface` /
 * `proxyResponseGuard` / `proxyRuleSelection` / `variables`），另有 `round3-bugfixes` 抄了它的
 * 超时公式——也就是「那几行字还在」就等于「行为没变」。而它是全仓唯一在页面 JS 层决定请求去向的代码
 * （网络层那半条归 DNR 动态规则），里面那条铁律写的正是「任何异常路径都必须落到一个结局」——
 * grep 看不见结局。
 *
 * 这里真的执行 `main()`：假 `window` 收 `postMessage`、按 `SYNC_RULES` 下发规则、
 * 用 `PROXY_RESPONSE` 写回结果，然后调用被替换后的 `window.fetch`。每一笔请求走哪条路、
 * 以什么落定（兑现 / reject / 回退原生；「挂住不落定」不靠断言，靠它必然撞满 5s 用例超时），
 * 全部按可观察结果说话。
 * 拦截器自包含、不 import 枚举，所以测试同样按字面量说话——改这些字面量就是改线上协议。
 * `CONTENT_SCRIPT_CHANNEL` 例外：它经 `utils/constants.ts` 取值，桥接层用的是同一个常量，
 * 改名时两边一起红，而不是让这份夹具悄悄跟着改。
 *
 * 覆盖范围只有 fetch 通道。XHR 需要一份能派发 `readyState`/`load` 事件的假实例，
 * WebSocket 需要握手与帧语义——假握手会成为被测物的主要风险源，所以这里的空桩只为让
 * `main()` 跑到末尾不抛；两条通道各自的运行时用例在 `interceptorXhr`（结局）与
 * `interceptorWebSocket`（选址：交给原生构造器的是哪个地址、带不带 protocols）。
 * 握手与帧语义本身仍然只有源码契约（`wsCapabilitySurface`），刻意没补。
 *
 * 同为 fetch 通道、这里刻意没碰的分支（要加先想清楚该不该由运行时用例守）：
 * `input` 是 `Request` 对象的那一半（`request?.method/signal/headers` 回退、`request.clone().text()`
 * 读体）、`new URL` 解析失败按原值匹配、`prefix` / `regex` 两种 `matchType`、单条规则 `enabled: false`、
 * `normalizePriority` 的非有限值回落、以及 `PROXY_RESPONSE` 带着无人认领的 `requestId` 进来时的空操作。
 * 假 `postMessage` 按引用记录载荷、不做结构化克隆——跨界的都是纯数据，没有克隆不上的东西，
 * 代价是「载荷能不能过 postMessage」这件事本身不在这里验证。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CONTENT_SCRIPT_CHANNEL } from '@/utils/constants';
import type { ProxyRule } from '@/utils/types';

const ORIGIN = 'https://fat.example.com';
const HREF = `${ORIGIN}/app/index.html`;
const API_URL = `${ORIGIN}/api/users`;

const CHANNEL = CONTENT_SCRIPT_CHANNEL;
const PROXY_REQUEST = 'PROXY_REQUEST';
const PROXY_RESPONSE = 'PROXY_RESPONSE';
const CANCEL_REQUEST = 'CANCEL_REQUEST';
const SYNC_RULES = 'SYNC_RULES';
const REQUEST_CONFIG = 'REQUEST_CONFIG';
const INTERCEPTOR_STATS = 'INTERCEPTOR_STATS';

interface PostedMessage {
  payload: { channel?: string; type?: string; data?: Record<string, unknown> };
  targetOrigin: string;
}

interface FakeWindow {
  location: { origin: string; href: string };
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  fetch: typeof globalThis.fetch;
  WebSocket: unknown;
}

/** 原生 fetch 的替身：拦截器判定「不归我管」时必然落回这里，正文可辨识以免把代理结果当成原生结果 */
const nativeFetch = vi.fn(
  async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => new Response('NATIVE', { status: 200 }),
);

let posted: PostedMessage[];
let listeners: Array<(event: MessageEvent) => void>;
let win: FakeWindow;

/** 造一份假 `window` 并清掉上一笔的观察记录；`fetch` 必须先就位，拦截器挂载时抓的就是它 */
function prepareFakeWindow(): void {
  posted = [];
  listeners = [];
  nativeFetch.mockClear();
  nativeFetch.mockImplementation(async () => new Response('NATIVE', { status: 200 }));
  win = {
    location: { origin: ORIGIN, href: HREF },
    postMessage: (message, targetOrigin) => {
      posted.push({ payload: message as PostedMessage['payload'], targetOrigin });
    },
    addEventListener: (type, listener) => {
      if (type === 'message') listeners.push(listener);
    },
    fetch: nativeFetch,
    WebSocket: class FakeWebSocket {},
  };
}

/** 真的跑一遍 `main()`：每次调用都新建一份闭包状态，所以每笔测试拿到一个干净的拦截器 */
async function mount(): Promise<void> {
  prepareFakeWindow();
  vi.stubGlobal('window', win);
  vi.stubGlobal('XMLHttpRequest', class FakeXHR {});
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.resetModules();
  const definition = await import('@/entrypoints/main-interceptor.content');
  // 拦截器不读 `ctx`（它自包含），这一处转型只是为了满足 `defineContentScript` 声明的签名
  const start = definition.default.main as () => void;
  start();
}

/** 把一条消息投递给拦截器（`source` 默认本窗口，闸门用例自己换） */
function deliver(event: { source: unknown; data: unknown }): void {
  listeners.forEach(listener => listener(event as MessageEvent));
}

function syncRules(data: unknown): void {
  deliver({ source: win, data: { channel: CHANNEL, type: SYNC_RULES, data } });
}

function armProxy(rules: ProxyRule[]): void {
  syncRules({ enabled: true, rules });
}

/** 桥接层写回结果：拦截器按 `requestId` 兑现挂起请求 */
function respond(requestId: string, data: Record<string, unknown>): void {
  deliver({ source: win, data: { channel: CHANNEL, type: PROXY_RESPONSE, data: { requestId, ...data } } });
}

function postsOfType(type: string): PostedMessage[] {
  return posted.filter(entry => entry.payload?.type === type);
}

function payloadOfType(type: string): PostedMessage['payload'][] {
  return postsOfType(type).map(entry => entry.payload);
}

function proxiedRequests(): Record<string, unknown>[] {
  return payloadOfType(PROXY_REQUEST).map(payload => payload.data ?? {});
}

function lastRequest(): Record<string, unknown> | undefined {
  return proxiedRequests()[proxiedRequests().length - 1];
}

/** 取最近一笔代发请求的 `requestId`；拿不到就当场失败，免得后面挂到 5s 超时才看不出是谁的锅 */
function lastRequestId(): string {
  const requestId = lastRequest()?.requestId;
  if (typeof requestId !== 'string' || requestId === '') {
    throw new Error('没有发出任何代发请求：闸门或匹配判定先失败了');
  }
  return requestId;
}

/**
 * 发出请求但不等它落定。
 *
 * 拦截器对字符串入参是在调用栈内就 `postMessage` 出 `PROXY_REQUEST` 的，所以「请求有没有被拦」
 * 在这一步就能断言；回包由用例自己写回。顺手挂一个 `catch`，不让中途的拒绝污染观察。
 */
function send(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const pending = win.fetch(input, init);
  pending.catch(() => undefined);
  return pending;
}

function rule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r-api',
    name: 'api',
    enabled: true,
    matchType: 'wildcard',
    matchPattern: `${ORIGIN}/api/*`,
    targetUrl: 'https://uat.example.com/api',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(async () => {
  await mount();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('挂载与入站闸门', () => {
  it('挂载即请求配置回放，且发往页面的每一笔都以本页 origin 投递（不是 `*`）', async () => {
    expect(payloadOfType(REQUEST_CONFIG)).toEqual([{ channel: CHANNEL, type: REQUEST_CONFIG }]);

    armProxy([rule()]);
    const pending = send(API_URL);
    respond(lastRequestId(), { status: 200, body: 'ok' });
    await pending;

    // 先确保下面那个循环不是空转：回放 + 代发 + 一笔自报，三笔以上
    expect(posted.length).toBeGreaterThan(2);
    for (const entry of posted) expect(entry.targetOrigin).toBe(ORIGIN);
  });

  it('不是本窗口发来的、或不是自家 channel 的，一律不听', async () => {
    const foreignEvents: Array<[string, { source: unknown; data: unknown }]> = [
      // 父页朝这个 iframe 的 postMessage 会以本 frame 的 window 为投递目标，但 source 是父窗口
      [
        '外来的 event.source',
        { source: { top: {} }, data: { channel: CHANNEL, type: SYNC_RULES, data: { enabled: true, rules: [rule()] } } },
      ],
      [
        '别人的 channel',
        {
          source: win,
          data: { channel: 'some-other-extension', type: SYNC_RULES, data: { enabled: true, rules: [rule()] } },
        },
      ],
    ];

    for (const [label, event] of foreignEvents) {
      deliver(event);
      send(API_URL);
      expect(nativeFetch, label).toHaveBeenCalledTimes(1);
      expect(proxiedRequests(), label).toEqual([]);
      nativeFetch.mockClear();
    }
  });

  it('形状非法的 SYNC_RULES 当空处理：不把异常抛给监听器，也不留上一份缓存', async () => {
    armProxy([rule()]);
    send(API_URL);
    expect(proxiedRequests()).toHaveLength(1);

    // 这条消息的发送方不只有桥接层：同页脚本拿着 channel 字面量就能投一份（`event.source` 挡不住它）
    const rulesObject = { nested: { enabled: true, matchPattern: `${ORIGIN}/api/*`, matchType: 'wildcard' } };
    expect(() => syncRules({ enabled: true, rules: rulesObject })).not.toThrow();
    expect(() => syncRules(undefined)).not.toThrow();

    send(`${ORIGIN}/api/other`);
    expect(proxiedRequests()).toHaveLength(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('总开关关闭时一律走原生：规则命中也不代发', async () => {
    syncRules({ enabled: false, rules: [rule()] });
    send(API_URL);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(proxiedRequests()).toEqual([]);
  });
});

describe('命中判定', () => {
  it('相对路径按页面地址解析后再匹配，交给后台的是绝对地址', async () => {
    armProxy([rule()]);
    send('/api/users');
    expect(lastRequest()?.url).toBe(API_URL);
  });

  it('未命中的请求原样交给原生 fetch：实参不动，也不发代发请求', async () => {
    armProxy([rule({ matchPattern: 'https://other.example.com/*' })]);
    const init: RequestInit = { headers: { 'x-a': '1' } };
    const response = await win.fetch(API_URL, init);

    expect(nativeFetch.mock.calls).toEqual([[API_URL, init]]);
    // 用 `toBe` 而非只靠上面的 `toEqual`：后者对浅拷贝同样通过，「实参不动」要的是同一个对象
    expect(nativeFetch.mock.calls[0][1]).toBe(init);
    expect(await response.text()).toBe('NATIVE');
    expect(proxiedRequests()).toEqual([]);
  });

  it('方法不在规则白名单内就不拦，命中时大小写不敏感', async () => {
    armProxy([rule({ methods: ['POST'] })]);

    send(API_URL, { method: 'GET' });
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(proxiedRequests()).toEqual([]);

    send(API_URL, { method: 'post' });
    expect(proxiedRequests()).toHaveLength(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('两条都能命中时按 priority 选，选中的 ruleId 随请求交给后台复核', async () => {
    armProxy([
      rule({ id: 'wide', priority: 50 }),
      rule({ id: 'narrow', priority: 1, matchPattern: `${ORIGIN}/api/users*` }),
    ]);
    send(API_URL);
    expect(lastRequest()?.ruleId).toBe('narrow');
  });
});

describe('代发载荷', () => {
  it('headers 的三种入参形态都收成扁平对象再跨 world', async () => {
    armProxy([rule()]);

    send(API_URL, { headers: { 'x-a': '1' } });
    expect(lastRequest()?.headers).toEqual({ 'x-a': '1' });

    send(API_URL, { headers: new Headers({ 'x-b': '2' }) });
    expect(lastRequest()?.headers).toEqual({ 'x-b': '2' });

    send(API_URL, { headers: [['x-c', '3']] });
    expect(lastRequest()?.headers).toEqual({ 'x-c': '3' });
  });

  it('字符串 body 原样带走，URLSearchParams 先转字符串，没有 body 记 null', async () => {
    armProxy([rule()]);

    send(API_URL, { method: 'POST', body: '{"q":1}' });
    expect(lastRequest()?.body).toBe('{"q":1}');

    send(API_URL, { method: 'POST', body: new URLSearchParams({ a: '1' }) });
    expect(lastRequest()?.body).toBe('a=1');

    send(API_URL, { method: 'POST' });
    expect(lastRequest()?.body).toBe(null);
  });

  it('非字符串 body 无法跨 postMessage：回退原生并带上原实参，不静默丢掉请求体', async () => {
    armProxy([rule()]);
    const form = new FormData();
    form.append('file', 'x');
    const init: RequestInit = { method: 'POST', body: form };

    const pending = win.fetch(API_URL, init);
    // 同步判据先断言：回退分支被摘掉时这里就是干净的红，而不是让下面那句 await 挂到 5s 超时
    expect(nativeFetch.mock.calls).toEqual([[API_URL, init]]);
    expect(nativeFetch.mock.calls[0][1]).toBe(init);
    expect(proxiedRequests()).toEqual([]);

    expect(await (await pending).text()).toBe('NATIVE');
  });
});

describe('回包兑现', () => {
  it('合法回包还原成页面可读的 Response，不再碰原生 fetch', async () => {
    armProxy([rule()]);
    const pending = send(API_URL);
    respond(lastRequestId(), { status: 201, statusText: 'Created', headers: { 'x-a': 'b' }, body: '{"ok":true}' });

    const response = await pending;

    expect([response.status, response.statusText, response.headers.get('x-a')]).toEqual([201, 'Created', 'b']);
    expect(await response.text()).toBe('{"ok":true}');
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('isBase64 的回包解码成字节，页面读到的是二进制而不是 base64 文本', async () => {
    armProxy([rule()]);
    const pending = send(API_URL);
    respond(lastRequestId(), { status: 200, body: btoa('ab'), isBase64: true });

    const bytes = new Uint8Array(await (await pending).arrayBuffer());

    expect([...bytes]).toEqual([97, 98]);
  });

  it('204 配非空正文不会让请求永久 pending：正文归 null，照常兑现', async () => {
    armProxy([rule()]);
    const pending = send(API_URL);
    respond(lastRequestId(), { status: 204, body: '有正文' });

    const response = await pending;

    expect(response.status).toBe(204);
    expect(response.body).toBe(null);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('含 CR/LF 的 statusText 与非 ByteString 的响应头只丢那一条，不把整笔打成回退', async () => {
    armProxy([rule()]);
    const pending = send(API_URL);
    respond(lastRequestId(), {
      status: 200,
      statusText: 'OK\r\nX-Injected: 1',
      headers: { 'x-cn': '中文', 'content-type': 'application/json' },
      body: '{}',
    });

    const response = await pending;

    expect(response.status).toBe(200);
    expect(response.statusText).not.toMatch(/[\r\n]/);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-cn')).toBe(null);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('回包 status 为 0、缺失或越界都按失败处理，不会被当成一次 200 空响应', async () => {
    // 三种形状分开看：`status: 0` 是桥接层对失败信封的真实整形结果
    // （`utils/proxyResponse.ts` 把缺失的 status 补成 0），`{}` 是它发不出来的输入、
    // 只测本 world 那道兜底守卫，`700` 是上游给了个非法值。
    // 这条钉的是结局，不是那行区间守卫：把守卫整块摘掉，越界 status 到了
    // `new Response()` 一样抛 RangeError，末尾的 try/catch 接住后结局仍是回退原生
    // （代价只是 reject 的原因从「带上游文案的 Error」变成 RangeError，本用例不主张这一点）。
    // 守卫独有、别处接不住的那一半是 Blocked 标记，由「后台明确回 Blocked」那条钉。
    armProxy([rule()]);

    const zero = send(API_URL);
    respond(lastRequestId(), { status: 0, statusText: 'Proxy Error' });
    const missing = send(API_URL);
    respond(lastRequestId(), { error: 'fetch failed' });
    const outOfRange = send(API_URL);
    respond(lastRequestId(), { status: 700, statusText: 'Nope' });

    const responses = await Promise.all([zero, missing, outOfRange]);

    expect(nativeFetch).toHaveBeenCalledTimes(3);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('NATIVE');
    }
  });
});

describe('阻断不得回退', () => {
  it('阻断规则遇到非字符串 body 也不回退：请求根本没机会发出', async () => {
    armProxy([rule({ blocked: true })]);

    const pending = win.fetch(API_URL, { method: 'POST', body: new FormData() });
    // 同上：这条用例的红必须落在「它到底发出去了没有」，而不是等 await
    expect(proxiedRequests()).toEqual([]);
    expect(nativeFetch).not.toHaveBeenCalled();

    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('Failed to fetch');
  });

  it('阻断规则拿到失败信封也绝不回退：读不到判定就当阻断处理', async () => {
    armProxy([rule({ blocked: true })]);
    const pending = send(API_URL);
    respond(lastRequestId(), {});

    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TypeError);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('后台明确回 Blocked 时，本地没标阻断的规则也不回退', async () => {
    armProxy([rule()]);
    const pending = send(API_URL);
    respond(lastRequestId(), { statusText: 'Blocked' });

    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('Failed to fetch');
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});

describe('取消', () => {
  it('进来就已取消：一笔都不发出，也不补发取消', async () => {
    armProxy([rule()]);
    const controller = new AbortController();
    controller.abort();

    const pending = win.fetch(API_URL, { signal: controller.signal });
    // `abort` 事件在拦截器挂监听之前就已经过去了，这一笔只能靠「进来先看看是不是已取消」兜住；
    // 摘掉那一道就是无声地把页面放弃的请求发给后台，所以先断言同步事实
    expect(proxiedRequests()).toEqual([]);
    expect(payloadOfType(CANCEL_REQUEST)).toEqual([]);

    const error = await pending.catch((reason: unknown) => reason);

    expect((error as Error).name).toBe('AbortError');
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('中途 abort：掐掉后台那一笔、按 signal.reason 落定，且不回退原生', async () => {
    armProxy([rule()]);
    const controller = new AbortController();
    const pending = send(API_URL, { signal: controller.signal });
    const requestId = lastRequestId();

    controller.abort();
    const error = await pending.catch((reason: unknown) => reason);

    expect((error as Error).name).toBe('AbortError');
    // 取消只带 requestId：其余坐标由 Chrome 写的 sender 提供，载荷里多一个字段就多一份可伪造的面
    expect(payloadOfType(CANCEL_REQUEST).map(payload => payload.data)).toEqual([{ requestId }]);
    expect(postsOfType(CANCEL_REQUEST)[0].targetOrigin).toBe(ORIGIN);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('已落定之后再取消，不补发无主的取消', async () => {
    armProxy([rule()]);
    const controller = new AbortController();
    const pending = send(API_URL, { signal: controller.signal });
    respond(lastRequestId(), { status: 200, body: 'ok' });
    await pending;

    controller.abort();
    await settle();

    expect(payloadOfType(CANCEL_REQUEST)).toEqual([]);
  });
});

describe('超时与自报口径', () => {
  it('代发等到期：同一笔既记进 timedOut 又记进 fellBack，最后交给原生', async () => {
    armProxy([rule()]);
    vi.useFakeTimers();
    const pending = send(API_URL);

    await vi.advanceTimersByTimeAsync(35000);
    const response = await pending;
    // 尾差靠定时器补报：最后那一笔回退不会自己开口
    await vi.advanceTimersByTimeAsync(1100);

    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe('NATIVE');
    const stats = payloadOfType(INTERCEPTOR_STATS).map(payload => payload.data);
    expect(stats[stats.length - 1]).toEqual({ intercepted: 1, proxied: 1, fellBack: 1, timedOut: 1 });
  });

  it('超时上限按规则配置算：配了 delayMs 的慢请求不会被固定 30s 误杀', async () => {
    // 公式本身由 tests/round3-bugfixes.test.ts 的 B6 钉；这里钉「定时器真的按它来」
    armProxy([rule({ delayMs: 10000 })]);
    vi.useFakeTimers();
    let settled = false;
    send(API_URL).then(
      () => (settled = true),
      () => (settled = true),
    );

    await vi.advanceTimersByTimeAsync(36000);
    expect(settled).toBe(false);
    expect(nativeFetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('自报统计只带那四个键，且第一笔立刻报出去', async () => {
    armProxy([rule()]);
    send(API_URL);

    expect(payloadOfType(INTERCEPTOR_STATS).map(payload => payload.data)).toEqual([
      { intercepted: 1, proxied: 0, fellBack: 0, timedOut: 0 },
    ]);
  });
});
