/**
 * MAIN world 拦截器的 XHR 通道：跑起来测，而不是 grep 源码
 *
 * `entrypoints/main-interceptor.content.ts` 的 XHR 那一半此前只有**源码契约**在守：
 * `syncXhrFallback`（在源码里 `indexOf` 判分支顺序）、`xhrReadonlyProps`（正则抓 `defineProperty`
 * 是否带 `configurable: true`）、`cancelRequestPropagation` 的「[XHR 路径]」那一节、
 * `interceptorStats`（同样按字符串定位 `bump` 的调用点）。
 * 「那几行字还在」不等于「页面拿得到正确的那份账」——XHR 的难点恰恰在结局：属性回填到什么值、
 * 按什么顺序派发哪些事件、`load` 与 `error` 会不会同时到、abort 之后迟到的响应还写不写回。
 * 这些 grep 一概看不见，而它们错了的表现是页面「拿到一个空响应」或「永久 pending」，
 * 不是报错。批次 I 已经给 fetch 通道建好同一套夹具，这里把 XHR 补上。
 *
 * 假 `XMLHttpRequest` 只有一处形状是承重的，改之前先读完：
 * `readyState` / `status` / `statusText` / `response` / `responseText` / `responseURL` 必须是
 * **原型上的 getter**（只读、无 setter），跟 Chrome 把这几个做成 `XMLHttpRequest.prototype` 上的
 * 访问器一致。做成实例上的访问器就测不到真事——实例已有属性时 `defineProperty` 里缺省的
 * `configurable` 是「不改」而不是「设成 false」，第二次回填照样成功；只有在原型访问器之下，
 * 拦截器那一次 define 才是「新建一份 own data 属性」，此时两个旗标都缺省才得到一份
 * `{ writable: false, configurable: false }`。
 * 抛出点落在 `.then` 里 → 进 `.catch`，而 `.catch` 又做同样的定义 → 再抛一次，`error` / `loadend`
 * 都派发不出来，页面那次请求永久 pending。这条既有风险由本文件的「实例复用」用例按运行时守住，
 * 文本契约另有 `tests/xhrReadonlyProps.test.ts`。
 *
 * 两个旗标**并不对称**，这一点由变异实测（`.test-tmp/mutate-interceptor-xhr.py`）而不是推断：
 * 只漏 `configurable: true` 就会红（新建的那份 own 属性因此不可重定义，复用实例的第二遍回填
 * 哪怕值一模一样也抛），只漏 `writable: true` 不会红（`configurable: true` 还在时整份重定义
 * 本就允许改值）。所以承重的是 `configurable`，`writable` 是防御性的第二道（页面自己往
 * `xhr.status` 上赋值时不至于在严格模式抛）。
 * （顺带记一笔被本文件自己推翻过的猜测：ES class 的方法本来就是 `writable: true`，
 * 拦截器往原型上赋值换 `open` / `send` 不需要夹具做任何描述符手术。）
 *
 * 另一处夹具卫生值得知道：拦截器的节流补报、`xhr.timeout` 派发与 35s 代发超时都是**原生定时器**，
 * 而 `reportStats` 在触发那一刻才取 `window`——不登记不摘除，上一笔的账就会写进下一笔的 `posted`。
 * 见 `takeNativeTimers()`：它在每次挂载时先把上一笔的句柄摘掉，再由 `afterEach` 收尾。
 *
 * 拦截器自包含、不 import 枚举，所以测试同样按字面量说话——改这些字面量就是改线上协议。
 * `CONTENT_SCRIPT_CHANNEL` 例外：它经 `utils/constants.ts` 取值，桥接层用的是同一个常量。
 *
 * 刻意不在这里测的：fetch 通道（批次 I）、WebSocket（批次 L 补的是**选址**那半——交给原生构造器的
 * 地址与 protocols，见 `interceptorWebSocket`；握手与帧语义仍只有 `wsCapabilitySurface` 守着）、
 * `proxyFetch` 内部的回包整形与超时公式（`proxyResponseGuard` /
 * `interceptorResponseGuard` / `round3-bugfixes`）、以及规则优先级与模式匹配本身（`proxyRuleSelection` /
 * `urlMatcher`）。方法白名单例外，XHR 这一路的落点归本文件——页面那份手工副本在 fetch 那支只测了
 * 「白名单不符就不拦 + 请求方法侧的大小写」，握手那支测了「把握手当 GET 过白名单 + 条目侧小写」，
 * `methods: []` 两支都没有，所以 XHR 上原先一格都没有；两份副本是否同源另由 `channel-consistency` 判。
 * 假 `postMessage` 按引用记录载荷、不做结构化克隆；`xhr.upload` 与 `withCredentials` 拦截器根本不读。
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
const INTERCEPTOR_STATS = 'INTERCEPTOR_STATS';

interface PostedMessage {
  payload: { channel?: string; type?: string; data?: Record<string, unknown> };
  targetOrigin: string;
}

/** 假 XHR 的公开面，够测试说话即可 */
interface FakeXhr {
  readonly events: string[];
  readonly nativeSends: unknown[];
  readonly opens: unknown[][];
  readonly aborts: number;
  readyState: number;
  status: number;
  statusText: string;
  response: unknown;
  responseText: string;
  responseURL: string;
  responseType: string;
  timeout: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onreadystatechange: (() => void) | null;
  onloadend: (() => void) | null;
  addEventListener(type: string, listener: () => void): void;
  open(method: string, url: string | URL, asyncFlag?: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: unknown): void;
  abort(): void;
  getAllResponseHeaders(): string;
  getResponseHeader(name: string): string | null;
}

/** 每次挂载新建一份，避免第二次 patch 把上一次的替换函数当成「原型原生方法」 */
function createXhrClass(): new () => FakeXhr {
  class XhrStub {
    readonly events: string[] = [];
    readonly nativeSends: unknown[] = [];
    readonly opens: unknown[][] = [];
    aborts = 0;
    responseType = '';
    timeout = 0;
    withCredentials = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onreadystatechange: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    #listeners = new Map<string, Array<() => void>>();
    /** 只读属性的真值；实例上被 defineProperty 盖过之后就不再经过这里 */
    #state = { readyState: 1, status: 0, statusText: '', response: null as unknown, responseText: '', responseURL: '' };

    // 与浏览器一致：这六个是原型上的只读访问器（class 的访问器元素本就 configurable: true），
    // 所以「往实例上盖一层」才是拦截器唯一的写入手段，也正是复用第二遍回填会撞上的那层。
    get readyState(): number {
      return this.#state.readyState;
    }
    get status(): number {
      return this.#state.status;
    }
    get statusText(): string {
      return this.#state.statusText;
    }
    get response(): unknown {
      return this.#state.response;
    }
    get responseText(): string {
      return this.#state.responseText;
    }
    get responseURL(): string {
      return this.#state.responseURL;
    }

    addEventListener(type: string, listener: () => void): void {
      const list = this.#listeners.get(type) ?? [];
      list.push(listener);
      this.#listeners.set(type, list);
    }

    removeEventListener(type: string, listener: () => void): void {
      const list = this.#listeners.get(type) ?? [];
      this.#listeners.set(
        type,
        list.filter(entry => entry !== listener),
      );
    }

    /**
     * 承重的只有「`addEventListener` 与 `on<type>` 各只吃到一次」——拦截器正是靠这一条不再手动
     * 调 `onload`。真实 DOM 的派发顺序是注册顺序，这里固定「先 listener 后属性」，所以本文件
     * 不把两种监听器混在同一个事件上比顺序。
     */
    dispatchEvent(event: Event): boolean {
      this.events.push(event.type);
      (this.#listeners.get(event.type) ?? []).slice().forEach(listener => listener.call(this));
      const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
      if (typeof handler === 'function') (handler as () => void).call(this);
      return true;
    }

    open(method: string, url: string | URL, asyncFlag?: boolean): void {
      this.opens.push([method, url, asyncFlag]);
    }

    setRequestHeader(name: string, value: string): void {
      void name;
      void value;
    }

    send(body?: unknown): void {
      this.nativeSends.push(body);
    }

    abort(): void {
      this.aborts += 1;
    }

    getAllResponseHeaders(): string {
      return '';
    }

    getResponseHeader(): string | null {
      return null;
    }

    overrideMimeType(): void {
      /* 拦截器不读 */
    }
  }

  return XhrStub as unknown as new () => FakeXhr;
}

let posted: PostedMessage[];
let listeners: Array<(event: MessageEvent) => void>;
let win: Record<string, unknown>;
let XhrClass: new () => FakeXhr;
let warnSpy: ReturnType<typeof vi.spyOn>;
/** 本笔测试期间由拦截器挂上的原生定时器句柄，下一次挂载与 `afterEach` 一律掐掉 */
let nativeTimers: ReturnType<typeof setTimeout>[] = [];
/** 在第一次桩化之前取到的真 `setTimeout`，避免桩套桩地累加句柄 */
const realSetTimeout = globalThis.setTimeout;

/**
 * 摘掉上一次挂载遗留的定时器，再把全局 `setTimeout` 换成「照常跑、但登记句柄」的一份。
 *
 * 为什么要管：拦截器的三处定时器都是原生的（`bump()` 那个约 1s 的节流补报、`xhr.timeout`
 * 的到期派发、`proxyFetch` 的 35s 超时），而 `reportStats` 是**在触发那一刻**才取 `window`。
 * 旧闭包的句柄不会自己消失，一旦它在新的一桩测试里到期，写的是**新** `posted`——账看着像这一笔的，
 * 其实是上一笔的。清理必须发生在挂载点（不只是 `afterEach`），因为有的用例会在同一笔里
 * 再挂一次来模拟「下一笔测试」，那中间没有 `afterEach` 可跑。
 *
 * 为什么清理必须落在挂载点而不是只落在 `afterEach`：本文件有一笔用例在同一笔里挂两次，
 * 用来模拟「上一笔测试留下的定时器活到了这一笔」——那中间没有 `afterEach` 可跑。
 * 把这里的 `forEach(clearTimeout)` 摘掉，只有「上一笔没跑完的节流补报不会写进这一笔的账」
 * 那一条会红（多出一条 `INTERCEPTOR_STATS`，其余 30 条照常绿）。
 */
function takeNativeTimers(): void {
  nativeTimers.forEach(handle => clearTimeout(handle));
  nativeTimers = [];
  vi.stubGlobal(
    'setTimeout',
    (handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): ReturnType<typeof setTimeout> => {
      const handle = realSetTimeout(handler, ms, ...args);
      nativeTimers.push(handle);
      return handle;
    },
  );
}

function newXhr(): FakeXhr {
  return new XhrClass();
}

/** 真的跑一遍 `main()`：每笔测试拿到一份干净的闭包状态（含新的 XHR 桩） */
async function mount(): Promise<void> {
  posted = [];
  listeners = [];
  XhrClass = createXhrClass();
  win = {
    location: { origin: ORIGIN, href: HREF },
    postMessage: (message: unknown, targetOrigin: string) => {
      posted.push({ payload: message as PostedMessage['payload'], targetOrigin });
    },
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.push(listener);
    },
    fetch: vi.fn(async () => new Response('NATIVE', { status: 200 })),
    WebSocket: class FakeWebSocket {},
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('XMLHttpRequest', XhrClass);
  takeNativeTimers();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.resetModules();
  const definition = await import('@/entrypoints/main-interceptor.content');
  // 拦截器不读 `ctx`（它自包含），这一处转型只是为了满足 `defineContentScript` 声明的签名
  const start = definition.default.main as () => void;
  start();
}

function deliver(event: { source: unknown; data: unknown }): void {
  listeners.forEach(listener => listener(event as MessageEvent));
}

function armProxy(rules: ProxyRule[], enabled = true): void {
  deliver({ source: win, data: { channel: CHANNEL, type: SYNC_RULES, data: { enabled, rules } } });
}

/** 桥接层写回结果：拦截器按 `requestId` 兑现挂起请求 */
function respond(requestId: string, data: Record<string, unknown>): void {
  deliver({ source: win, data: { channel: CHANNEL, type: PROXY_RESPONSE, data: { requestId, ...data } } });
}

function payloadOfType(type: string): PostedMessage['payload'][] {
  return posted.filter(entry => entry.payload?.type === type).map(entry => entry.payload);
}

function proxiedRequests(): Record<string, unknown>[] {
  return payloadOfType(PROXY_REQUEST).map(payload => payload.data ?? {});
}

function lastRequest(): Record<string, unknown> | undefined {
  return proxiedRequests()[proxiedRequests().length - 1];
}

/** 取最近一笔代发请求的 `requestId`；拿不到就当场失败，免得后面挂到用例超时才看不出是谁的锅 */
function lastRequestId(): string {
  const requestId = lastRequest()?.requestId;
  if (typeof requestId !== 'string' || requestId === '') {
    throw new Error('没有发出任何代发请求：闸门或匹配判定先失败了');
  }
  return requestId;
}

function statsSnapshot(): Record<string, unknown> {
  const posts = payloadOfType(INTERCEPTOR_STATS);
  const last = posts[posts.length - 1]?.data;
  if (!last) throw new Error('没有任何 INTERCEPTOR_STATS 自报');
  return last;
}

/** 打开并发送一笔 XHR（异步，除非 `asyncFlag` 显式给 false） */
function request(xhr: FakeXhr, url: string = API_URL, body?: unknown, asyncFlag?: boolean): void {
  xhr.open('GET', url, asyncFlag);
  if (body !== undefined) xhr.send(body);
  else xhr.send();
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

/** 等微任务与 `setTimeout(0)` 那一类延后派发落定 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/**
 * 只看「实例上被盖出来的那一份」属性。
 *
 * 假对象的 `status` 初值就是 0、`responseText` 初值就是空串，直接读 `xhr.status` 分不清
 * 「回填了 0」与「压根没回填」——而后者正是这几条用例要否定的那个 bug。
 */
const shadowed = (xhr: FakeXhr, name: string): PropertyDescriptor | undefined =>
  Object.getOwnPropertyDescriptor(xhr, name);

beforeEach(async () => {
  await mount();
});

afterEach(() => {
  vi.useRealTimers();
  // 先摘假时钟再清原生句柄：这一笔没跑完的定时器不能带着 `posted` 活到下一笔
  nativeTimers.forEach(handle => clearTimeout(handle));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('什么时候不走代理：一律原样交给原生 XHR', () => {
  it('未命中规则：原生 send 收到页面那个 body 本身，一笔代发都不发', () => {
    armProxy([rule()]);
    const xhr = newXhr();
    const body = { not: 'a string' };

    request(xhr, `${ORIGIN}/other/thing`, body);

    expect(xhr.nativeSends).toHaveLength(1);
    expect(xhr.nativeSends[0]).toBe(body);
    expect(proxiedRequests()).toEqual([]);
  });

  it('总开关关闭：命中模式也一样原生', () => {
    armProxy([rule()], false);
    const xhr = newXhr();

    request(xhr, API_URL, 'payload');

    expect(xhr.nativeSends).toEqual(['payload']);
    expect(proxiedRequests()).toEqual([]);
  });

  it('方法白名单不符：这一路把那条规则当不存在，原生 send 照原样发', () => {
    // `request()` 用的是 `open('GET', …)`，而这条规则只放行 POST。结局必须是「等价于未装本扩展」，
    // 而不是「命中了但不发」——后者会让页面以为请求已经出去，却什么都没人收到。
    armProxy([rule({ methods: ['POST'] })]);
    const xhr = newXhr();

    request(xhr, API_URL, 'payload');

    expect(xhr.nativeSends).toEqual(['payload']);
    expect(proxiedRequests()).toEqual([]);
  });

  it('同步 XHR（open 第三参显式 false）只能原生：代理响应来不及在调用栈返回前到达', () => {
    armProxy([rule()]);
    const xhr = newXhr();

    request(xhr, API_URL, 'payload', false);

    // 换掉的 `open` 必须把第三个实参照原样交给原生：吞掉它，原生就按异步跑，调用方读到空响应
    expect(xhr.opens).toEqual([['GET', API_URL, false]]);
    expect(xhr.nativeSends).toEqual(['payload']);
    expect(proxiedRequests()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('同步 XHR 的回退提示一个页面只打一次：这类请求常在循环里', () => {
    armProxy([rule()]);
    for (let index = 0; index < 3; index += 1) {
      const xhr = newXhr();
      request(xhr, API_URL, 'payload', false);
      expect(xhr.nativeSends).toHaveLength(1);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('非字符串 body 跨不过 postMessage：回退原生，且把页面那个对象原样交出去', () => {
    armProxy([rule()]);
    const xhr = newXhr();
    const formData = { append: () => undefined };

    request(xhr, API_URL, formData);

    expect(xhr.nativeSends[0]).toBe(formData);
    expect(proxiedRequests()).toEqual([]);
  });

  it('被阻断的规则绝不回退原生：连非字符串 body 也不发出去', async () => {
    armProxy([rule({ blocked: true })]);
    const xhr = newXhr();

    request(xhr, API_URL, { append: () => undefined });

    expect(xhr.nativeSends).toEqual([]);
    expect(proxiedRequests()).toEqual([]);
    await settle();
    expect(xhr.events).toEqual(['readystatechange', 'error', 'loadend']);
    // 读 `xhr.status` 分不清「回填了 0」与「压根没回填」（假对象初值就是 0），所以看实例上那一份
    expect(shadowed(xhr, 'status')?.value).toBe(0);
    expect(shadowed(xhr, 'readyState')?.value).toBe(4);
  });

  it('同步 + 阻断：阻断优先，宁可不回包也不把请求真的发出去', () => {
    armProxy([rule({ blocked: true })]);
    const xhr = newXhr();

    request(xhr, API_URL, 'payload', false);

    expect(xhr.nativeSends).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('代理成功：属性回填、头读取与事件顺序', () => {
  it('交给后台的报文带得上页面的 method / url / headers / body', () => {
    armProxy([rule()]);
    const xhr = newXhr();
    xhr.open('POST', API_URL);
    xhr.setRequestHeader('X-Token', 'abc');
    xhr.send('payload');

    expect(xhr.nativeSends).toEqual([]);
    expect(lastRequest()).toMatchObject({
      method: 'POST',
      url: API_URL,
      headers: { 'X-Token': 'abc' },
      body: 'payload',
      ruleId: 'r-api',
    });
  });

  it('相对地址先按本页解析后再匹配，代发出去的是绝对地址', () => {
    armProxy([rule({ matchPattern: `${ORIGIN}/api/*` })]);
    const xhr = newXhr();

    request(xhr, '/api/users');

    expect(lastRequest()?.url).toBe(API_URL);
  });

  it('白名单的大小写与空数组这两半在 XHR 通道上同样成立', () => {
    // 页面侧那份 `methodAllowed` 是 `utils/urlMatcher` 的手工副本：条目侧小写此前只有握手那支钉着，
    // `methods: []` 三条路一格都没有——所以只改镜像那一半时，fetch 与 XHR 两条路照样绿。
    // 小写条目与 `[]` 的来路是导入文件与手改 storage（界面的下拉七个值全是大写，且只在非空时才写这个字段）。
    armProxy([rule({ id: 'r-lower', methods: ['post'] })]);
    const lower = newXhr();
    lower.open('POST', API_URL);
    lower.send('p1');

    expect(lower.nativeSends).toEqual([]);
    expect(lastRequest()).toMatchObject({ method: 'POST', ruleId: 'r-lower' });

    armProxy([rule({ id: 'r-empty', methods: [] })]);
    const empty = newXhr();
    empty.open('DELETE', API_URL);
    empty.send('p2');

    expect(empty.nativeSends).toEqual([]);
    expect(lastRequest()).toMatchObject({ method: 'DELETE', ruleId: 'r-empty' });
  });

  it('回包把 readyState / status / statusText / response / responseText / responseURL 一次填齐', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    request(xhr);

    respond(lastRequestId(), { status: 201, statusText: 'Created', body: 'CREATED', headers: { 'x-a': '1' } });
    await settle();

    expect([xhr.readyState, xhr.status, xhr.statusText]).toEqual([4, 201, 'Created']);
    expect(xhr.responseText).toBe('CREATED');
    expect(xhr.response).toBe('CREATED');
    expect(xhr.responseURL).toBe(API_URL);
  });

  it('头两个出口按浏览器口径说话：原始串用 CRLF 连接，按名字取值不区分大小写', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    request(xhr);

    respond(lastRequestId(), {
      status: 200,
      body: 'ok',
      headers: { 'X-Token': 'abc', 'content-type': 'application/json' },
    });
    await settle();

    // 拦截器只负责「`name: value` 以 CRLF 连接」；名字小写与排序来自 `Headers` 的迭代顺序，
    // 那是平台行为（Chrome 与 undici 都按名排序），不该钉在这条用例里，所以两边各排一次序。
    expect(xhr.getAllResponseHeaders().split('\r\n').sort()).toEqual([
      'content-type: application/json',
      'x-token: abc',
    ]);
    expect(xhr.getResponseHeader('X-TOKEN')).toBe('abc');
  });

  it('事件顺序是 readystatechange → load → loadend，且 addEventListener 与 onload 属性各只吃到一次', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    const listenerCalls: string[] = [];
    xhr.addEventListener('readystatechange', () => listenerCalls.push('listener:readystatechange'));
    xhr.addEventListener('load', () => listenerCalls.push('listener:load'));
    xhr.addEventListener('loadend', () => listenerCalls.push('listener:loadend'));
    let onloadAttributeCalls = 0;
    xhr.onload = () => {
      onloadAttributeCalls += 1;
    };

    request(xhr);
    respond(lastRequestId(), { status: 200, body: 'ok' });
    await settle();

    expect(xhr.events).toEqual(['readystatechange', 'load', 'loadend']);
    expect(listenerCalls).toEqual(['listener:readystatechange', 'listener:load', 'listener:loadend']);
    // 拦截器只派发事件、不再手动调 onload：这里多一次就是重复回调
    expect(onloadAttributeCalls).toBe(1);
  });

  it('非 2xx 也是一次正常回包：走 load，不走 error', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    request(xhr);

    respond(lastRequestId(), { status: 503, statusText: 'Unavailable', body: 'nope' });
    await settle();

    expect(xhr.events).toEqual(['readystatechange', 'load', 'loadend']);
    expect([xhr.status, xhr.responseText]).toEqual([503, 'nope']);
  });

  it('responseType 为 json 时只填 response，不顺手填 responseText', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    xhr.responseType = 'json';
    request(xhr);

    respond(lastRequestId(), { status: 200, body: '{"total":7}' });
    await settle();

    expect(xhr.response).toEqual({ total: 7 });
    // 真实 XHR 在 responseType='json' 下读 responseText 本来就该抛，这里守住「压根没填」而不是「填错」
    expect(shadowed(xhr, 'responseText')).toBeUndefined();
  });

  it('responseType 为 json 而正文不是合法 JSON：按 null 落，不把异常抛给页面', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    xhr.responseType = 'json';
    request(xhr);

    respond(lastRequestId(), { status: 200, body: 'not json' });
    await settle();

    expect(xhr.response).toBeNull();
    expect(xhr.events).toEqual(['readystatechange', 'load', 'loadend']);
  });

  it('responseType 为 arraybuffer 时交回的是二进制', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    xhr.responseType = 'arraybuffer';
    request(xhr);

    respond(lastRequestId(), { status: 200, body: 'QUJD', isBase64: true });
    await settle();

    expect(xhr.response).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(xhr.response as ArrayBuffer)).toEqual(new Uint8Array([65, 66, 67]));
    // 二进制那一支压根不填 responseText：真实 XHR 读它是抛 InvalidStateError
    expect(shadowed(xhr, 'responseText')).toBeUndefined();
  });
});

describe('代理失败、超时与取消：三条兜底各自落到哪个结局', () => {
  it('代发失败：status 0 + Proxy Error，派发 error 而不派发 load，也不回退原生', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    request(xhr);

    // 失败信封没有 status 字段（桥接层报错 / 后台抛错），按越界处理成 reject
    respond(lastRequestId(), { error: 'fetch failed' });
    await settle();

    expect(xhr.nativeSends).toEqual([]);
    expect([xhr.readyState, xhr.statusText]).toEqual([4, 'Proxy Error']);
    // 假对象的 `status` 初值就是 0，只有实例上那一份才能证明「回填发生了」
    expect(shadowed(xhr, 'status')?.value).toBe(0);
    expect(xhr.events).toEqual(['readystatechange', 'error', 'loadend']);
  });

  it('现状记录：XHR 的代理失败不记 fellBack，而 fetch 的同一条路径记', async () => {
    // 这条不是「应该这样」，是把两条通道的不对称钉住：fetch 代理失败会 bump('fellBack') 并回退原生，
    // XHR 代理失败只派发 error，请求就此落定。界面那句「回退原生」因此不包含这一格。
    // 统一任一侧都是改行为，已作为待确认点交付；修（补一次 bump 或改文案）会让这条红。
    // 尾差必须靠定时器补报：失败路径上一笔 bump 都不发，不推进这 1.1s 就等于什么都没断言。
    armProxy([rule()]);
    vi.useFakeTimers();
    const xhr = newXhr();
    request(xhr);
    const requestId = lastRequestId();

    respond(requestId, { error: 'fetch failed' });
    await vi.advanceTimersByTimeAsync(1100);

    expect(xhr.events).toEqual(['readystatechange', 'error', 'loadend']);
    expect(statsSnapshot()).toEqual({ intercepted: 1, proxied: 1, fellBack: 0, timedOut: 0 });
  });

  it('abort 之后迟到的响应一律丢弃：既不派发 load，也不回填属性', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    request(xhr);
    const requestId = lastRequestId();

    xhr.abort();
    expect(payloadOfType(CANCEL_REQUEST).map(post => post.data)).toEqual([{ requestId }]);
    const eventsBefore = [...xhr.events];

    respond(requestId, { status: 200, body: 'late' });
    await settle();

    // 断言「没有 own shadow」而不是 `readyState === 1`：前者只可能来自「拦截器没回填」，
    // 后者读的是原型 getter 的初始值，把夹具的默认值钉进了预期。
    expect(xhr.events).toEqual(eventsBefore);
    expect(shadowed(xhr, 'readyState')).toBeUndefined();
    expect(shadowed(xhr, 'responseText')).toBeUndefined();
    expect(xhr.aborts).toBe(1);
  });

  it('没走过代理的实例，abort 不去取消一个不存在的请求：open 会把上一笔的 id 清掉', () => {
    armProxy([rule()]);
    const xhr = newXhr();
    request(xhr);
    xhr.abort();
    expect(payloadOfType(CANCEL_REQUEST)).toHaveLength(1);

    // 复用同一个实例：open 之后还没有 send，此时 abort 不该把上一笔的 requestId 再取消一次
    xhr.open('GET', API_URL);
    xhr.abort();
    expect(payloadOfType(CANCEL_REQUEST)).toHaveLength(1);
  });

  it('尊重页面设置的 xhr.timeout：到期派发 timeout 并掐掉后台那笔，此后响应不再写回', async () => {
    armProxy([rule()]);
    const xhr = newXhr();
    xhr.timeout = 5;
    request(xhr);
    const requestId = lastRequestId();

    await new Promise(resolve => setTimeout(resolve, 30));

    expect(xhr.events).toEqual(['readystatechange', 'timeout', 'loadend']);
    // `status: 0` 与夹具的初始值同形，只有「实例上确实盖了一层」才证明超时路径回填过属性
    expect(shadowed(xhr, 'readyState')?.value).toBe(4);
    expect(shadowed(xhr, 'status')?.value).toBe(0);
    expect(payloadOfType(CANCEL_REQUEST).map(post => post.data)).toEqual([{ requestId }]);

    respond(requestId, { status: 200, body: 'late' });
    await settle();
    expect(xhr.events).toEqual(['readystatechange', 'timeout', 'loadend']);
  });

  it('响应先到、timeout 后到期：那个定时器不再补发 timeout，也不覆写已经交回的结果', async () => {
    // 页面设了 `xhr.timeout` 而响应先回来时，超时定时器还挂在事件循环里。它若无条件到期，
    // 页面就在拿到 200 之后又吃到一个 status 0 的 timeout，还会替这笔已落定的请求发一条取消。
    armProxy([rule()]);
    const xhr = newXhr();
    xhr.timeout = 5;
    request(xhr);

    respond(lastRequestId(), { status: 200, body: 'EARLY' });
    await settle();
    expect([xhr.status, xhr.responseText]).toEqual([200, 'EARLY']);

    await new Promise(resolve => setTimeout(resolve, 30));

    expect(xhr.events).toEqual(['readystatechange', 'load', 'loadend']);
    expect(xhr.status).toBe(200);
    expect(payloadOfType(CANCEL_REQUEST)).toEqual([]);
  });

  it('页面没设 timeout 时不挂任何超时定时器：等一会儿既不落定也不发取消', async () => {
    // 这一条等的是「什么都没发生」，因此它证明的是「拦截器没有为 timeout=0 挂定时器」，
    // 不是「只有真回包那一条路」——那一半要等出足够长的时间才有意义，不属于本用例。
    armProxy([rule()]);
    const xhr = newXhr();
    request(xhr);

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(xhr.events).toEqual([]);
    expect(payloadOfType(CANCEL_REQUEST)).toEqual([]);
  });
});

describe('实例复用与自报计数', () => {
  it('同一个实例第二次 open + send 不抛：只读属性第二遍照样盖得上去', async () => {
    armProxy([rule()]);
    const xhr = newXhr();

    request(xhr);
    respond(lastRequestId(), { status: 200, body: 'FIRST' });
    await settle();

    xhr.open('GET', API_URL);
    expect(() => xhr.send()).not.toThrow();
    respond(lastRequestId(), { status: 201, body: 'SECOND' });
    await settle();

    expect(xhr.responseText).toBe('SECOND');
    expect(xhr.status).toBe(201);
    expect(xhr.events).toEqual(['readystatechange', 'load', 'loadend', 'readystatechange', 'load', 'loadend']);
    expect(xhr.nativeSends).toEqual([]);
  });

  it('上一笔被 abort 之后复用实例：第二笔的回包不能被那次取消咽掉', async () => {
    // 轮询库的做法是同一个实例反复 open + send。`__proxyCancel` 若不在 open 里复位，
    // 第二笔的响应会在 `.then` 开头被当成迟到的旧账丢弃——页面既不报错也拿不到回包，永久 pending。
    armProxy([rule()]);
    const xhr = newXhr();
    request(xhr);
    xhr.abort();

    xhr.open('GET', API_URL);
    xhr.send();
    const secondId = lastRequestId();
    respond(secondId, { status: 200, body: 'SECOND' });
    await settle();

    expect(xhr.responseText).toBe('SECOND');
    expect(xhr.events).toEqual(['readystatechange', 'load', 'loadend']);
  });

  it('复用实例的第二笔照样有自己的 timeout：上一笔落定过的账不带过来', async () => {
    // 第一笔正常回包后 `__proxySettled` 置真；open 不清回去的话，第二笔那个定时器一到期就看到
    // 「已落定」，直接跳过派发——这一笔再也没人兜底，页面对着一个永不落定的请求。
    armProxy([rule()]);
    const xhr = newXhr();
    xhr.timeout = 5;
    request(xhr);
    respond(lastRequestId(), { status: 200, body: 'FIRST' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(xhr.events).toEqual(['readystatechange', 'load', 'loadend']);

    xhr.open('GET', API_URL);
    xhr.send();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(xhr.events).toEqual(['readystatechange', 'load', 'loadend', 'readystatechange', 'timeout', 'loadend']);
    expect(xhr.status).toBe(0);
  });

  it('复用实例时上一笔的取消登记不带过来：第二笔各记各的 requestId', () => {
    armProxy([rule()]);
    const xhr = newXhr();

    request(xhr);
    const firstId = lastRequestId();
    xhr.abort();
    respond(firstId, { status: 200, body: 'late' });

    xhr.open('GET', API_URL);
    xhr.send();
    expect(lastRequestId()).not.toBe(firstId);
    xhr.abort();

    // 两次 abort 各自取消一笔：第二次的 id 必须是新那一笔，而不是上一笔（已经落定了）
    expect(payloadOfType(CANCEL_REQUEST).map(post => (post.data as Record<string, unknown>).requestId)).toEqual([
      firstId,
      lastRequestId(),
    ]);
  });

  it('命中即记 intercepted、交给后台记 proxied；自报只有这四个键，不带 URL 也不带头', async () => {
    armProxy([rule()]);
    vi.useFakeTimers();
    const xhr = newXhr();

    // 首包在 `intercepted` 那一笔当场发出（此刻 proxied 还是 0），`proxied` 靠 1s 后的补报开口
    request(xhr);
    expect(statsSnapshot()).toEqual({ intercepted: 1, proxied: 0, fellBack: 0, timedOut: 0 });

    await vi.advanceTimersByTimeAsync(1100);
    expect(statsSnapshot()).toEqual({ intercepted: 1, proxied: 1, fellBack: 0, timedOut: 0 });
  });

  it('回退原生那一格确实进账：同步 XHR 一笔 → intercepted 与 fellBack 各加一', async () => {
    armProxy([rule()]);
    vi.useFakeTimers();
    const xhr = newXhr();

    request(xhr, API_URL, 'payload', false);
    await vi.advanceTimersByTimeAsync(1100);

    expect(statsSnapshot()).toEqual({ intercepted: 1, proxied: 0, fellBack: 1, timedOut: 0 });
  });

  it('非字符串 body 的回退同样进账：那一格有两个 XHR 调用点，漏挂一个是静默少一笔', async () => {
    // 上面那条测的是同步 XHR 那个调用点；这一条测非字符串 body 那个。二者是两行独立的
    // `bump('fellBack')`，只测一处等于给另一处留了盲区——而漏挂的表现只是数字偏小，不会报错。
    armProxy([rule()]);
    vi.useFakeTimers();
    const xhr = newXhr();

    request(xhr, API_URL, { append: () => undefined });
    await vi.advanceTimersByTimeAsync(1100);

    expect(statsSnapshot()).toEqual({ intercepted: 1, proxied: 0, fellBack: 1, timedOut: 0 });
  });

  it('上一笔没跑完的节流补报不会写进这一笔的账：挂载时先把旧句柄摘掉', async () => {
    // 这一条是给夹具自己用的：`reportStats` 在触发那一刻才取 `window`，所以旧闭包的补报到期后
    // 写的正是新那一份 `posted`——看起来像「这一笔拦到 1 个、一个都没交给后台」，而这一笔压根没发请求。
    // 实测：把 `takeNativeTimers()` 里那句 `forEach(clearTimeout)` 摘掉，这条红（多出一条自报包），
    // 其余 30 条照常绿——它是这套登记机制唯一可观察的证据。
    armProxy([rule()]);
    const xhr = newXhr();
    request(xhr);
    expect(payloadOfType(INTERCEPTOR_STATS)).toHaveLength(1);

    await mount();
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(payloadOfType(INTERCEPTOR_STATS)).toEqual([]);
  });
});
