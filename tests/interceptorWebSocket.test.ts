/**
 * MAIN world 拦截器的 WebSocket 通道：跑起来测，而不是 grep 源码
 *
 * `entrypoints/main-interceptor.content.ts` 的 WS 那一半此前只有**源码契约**在守：
 * `wsCapabilitySurface`（切出 `ProxyWebSocket` 那段字符串，判「先阻断后重写」的顺序）、
 * `channel-consistency`（`rewriteWsUrl` / `applyWsQuery` 与 `utils/urlMatcher.ts`「同源」——比的是文本）。
 * 而这条通道真正的风险恰恰是文本比不出来的：`rewriteWsUrl` 与 `applyWsQuery` 是
 * `utils/urlMatcher.ts` 的**手工副本**（MAIN world 自包含、不能 import），副本漂了的表现是页面
 * 连到一个看着没错、但签名参数已经被重编码过的地址——握手被服务端拒掉，扩展侧一声不响。
 * fetch（批次 I）与 XHR（批次 K）都已经按运行时测，这里补最后一条通道。
 *
 * 假 `WebSocket` 有两处形状是承重的：① **它是「原生」那一份**——拦截器在 `main()` 开头把
 * `window.WebSocket` 存成 `OriginalWebSocket`，再把 `window.WebSocket` 换成 `ProxyWebSocket`
 * （连 `prototype` 与四个静态常量一起搬过去），所以断言只能落在「交给原生构造器的那份实参」上，
 * 那是这条通道唯一的外部可观察面；② **桩构造器记的是实参个数**（`arity`），不只是值——
 * 拦截器判的是 `protocols ? …`，空串走的是「干脆不传第二参」，而值和「传了个 undefined」完全一样，
 * 只有个数能分开这两件事（真浏览器按 WebIDL 把空串判成非法子协议，`new WebSocket(url, '')` 抛
 * SyntaxError）。刻意不造假握手：帧语义、`readyState` 生命周期、`send`/`close` 的收发都不是
 * 这一段的逻辑，编出来只会让假实现本身变成被测物。**本文件测的是选址，不是通话。**
 *
 * 另两处需要知道：① `main()` 一进来也换 `XMLHttpRequest.prototype`，所以这里必须给一个
 * 极简 XHR 桩，否则挂载当场抛——它只为「让 main() 跑起来」存在，XHR 行为归
 * `tests/interceptorXhr.test.ts`；② 页面传 `URL` 对象、传单个协议字符串、传协议数组，
 * 拦截器三种都接得过来，各自的落地形态不同，所以各自一条。
 *
 * 拦截器自包含、不 import 枚举，所以测试同样按字面量说话——改这些字面量就是改线上协议。
 * `CONTENT_SCRIPT_CHANNEL` 例外：它经 `utils/constants.ts` 取值，桥接层用的是同一个常量。
 *
 * 承重性由 `.test-tmp/mutate-interceptor-ws.py` 逐点实测：47 个锚点改一处 → 跑本文件 → 43 条咬住、
 * 4 条存活（`W15`/`W16`/`W25` 是命中判定先把关的防御分支，`W28` 与不 early return 等价，
 * 都只是少一次 `new URL`），无锚点失效，跑完 `git status` 干净。
 * 最后一组「手工副本与 utils 侧」不钉具体答案，只钉两份副本对同一批输入给同一个答案——
 * 它的失败方向与前面那 40 条不同：**改的是 `utils/urlMatcher.ts` 而忘了镜像**。
 * 这一点同样实测过（把 utils 侧的空段过滤摘掉，全仓只有 mirror 那一组的 `?a=1&&` 一条红）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CONTENT_SCRIPT_CHANNEL } from '@/utils/constants';
import { applyQueryOverrides } from '@/utils/urlMatcher';
import type { ProxyRule } from '@/utils/types';

const ORIGIN = 'https://fat.example.com';
const HREF = `${ORIGIN}/app/index.html`;
const WS_URL = 'wss://fat.example.com/ws/live';

const CHANNEL = CONTENT_SCRIPT_CHANNEL;
const SYNC_RULES = 'SYNC_RULES';
const INTERCEPTOR_STATS = 'INTERCEPTOR_STATS';

interface PostedMessage {
  payload: { channel?: string; type?: string; data?: Record<string, unknown> };
  targetOrigin: string;
}

/** 原生构造器收到过的每一笔（含未被拦截的那些）；`arity` 记的是**实参个数** */
interface Constructed {
  url: string | URL;
  protocols?: string | string[];
  arity: number;
}

let posted: PostedMessage[];
let listeners: Array<(event: MessageEvent) => void>;
let win: Record<string, unknown>;
let constructs: Constructed[];
let warnSpy: ReturnType<typeof vi.spyOn>;

/** 假「原生」WebSocket：只登记构造实参，不做任何收发 */
function createWebSocketClass(): new (url: string | URL, protocols?: string | string[]) => unknown {
  class WebSocketStub {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readonly url: string | URL;
    readonly protocols?: string | string[];
    readyState = 0;

    constructor(...args: [string | URL] | [string | URL, string | string[]]) {
      const [url, protocols] = args;
      this.url = url;
      this.protocols = protocols;
      constructs.push({ url, protocols, arity: args.length });
    }

    send(): void {
      /* 本文件不测收发 */
    }

    close(): void {
      /* 本文件不测收发 */
    }

    addEventListener(): void {
      /* 本文件不测事件 */
    }

    removeEventListener(): void {
      /* 本文件不测事件 */
    }
  }

  return WebSocketStub as unknown as new (url: string | URL, protocols?: string | string[]) => unknown;
}

/** `main()` 会换掉 `XMLHttpRequest.prototype` 的四个方法，这里只给它一个可换的壳 */
function createXhrStub(): unknown {
  class XhrStub {
    open(): void {
      /* 归 tests/interceptorXhr.test.ts */
    }
    send(): void {
      /* 归 tests/interceptorXhr.test.ts */
    }
    setRequestHeader(): void {
      /* 归 tests/interceptorXhr.test.ts */
    }
    abort(): void {
      /* 归 tests/interceptorXhr.test.ts */
    }
  }
  return XhrStub;
}

/** 真的跑一遍 `main()`：每笔测试拿到一份干净的闭包状态（含新的 WS 桩） */
async function mount(): Promise<void> {
  posted = [];
  listeners = [];
  constructs = [];
  win = {
    location: { origin: ORIGIN, href: HREF },
    postMessage: (message: unknown, targetOrigin: string) => {
      posted.push({ payload: message as PostedMessage['payload'], targetOrigin });
    },
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.push(listener);
    },
    fetch: vi.fn(async () => new Response('NATIVE', { status: 200 })),
    WebSocket: createWebSocketClass(),
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('XMLHttpRequest', createXhrStub());
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

/** 以页面的方式连一笔，返回这一次新增的构造记录；多出来的那一支就是漏网的真实连接 */
function connectOne(url: string | URL = WS_URL, protocols?: string | string[]): Constructed {
  const before = constructs.length;
  const Ctor = win.WebSocket as unknown as new (u: string | URL, p?: string | string[]) => unknown;
  void new Ctor(url, protocols);
  expect(constructs.slice(before), '这一次连接不止一支构造').toHaveLength(1);
  return constructs[before];
}

/** 连一笔并只问地址 */
function connectedUrl(url?: string | URL, protocols?: string | string[]): string | URL {
  return connectOne(url, protocols).url;
}

/** 原生构造器收到的全部记录（测「一次都不出现真实地址」这类整串断言用） */
function allConstructs(): Constructed[] {
  return constructs;
}

function payloadOfType(type: string): PostedMessage['payload'][] {
  return posted.filter(entry => entry.payload?.type === type).map(entry => entry.payload);
}

function rule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r-ws',
    name: 'ws',
    enabled: true,
    matchType: 'wildcard',
    matchPattern: 'wss://fat.example.com/ws/*',
    targetUrl: 'https://uat.example.com/ws',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await mount();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('选址：交给原生构造器的是哪一个地址', () => {
  it('命中 wildcard：重写后的地址协议映射回 wss，且不被降级成 ws', () => {
    // targetUrl 存的是 `https://`，`toWsUrl` 负责升回 `wss://`。若实现先把目标按 http 归一化
    // （源码注释点名的那个坑），这里拿到的就是明文 `ws://`——握手内容被降级，页面还连得上。
    armProxy([rule()]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');
  });

  it('目标写成 wss:// 时原样保留', () => {
    armProxy([rule({ targetUrl: 'wss://uat.example.com/ws' })]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');
  });

  it('目标写成 http:// 时才降为 ws://', () => {
    armProxy([rule({ targetUrl: 'http://uat.example.com/ws' })]);
    expect(connectedUrl()).toBe('ws://uat.example.com/ws/live');
  });

  it('规则写成 http(s):// 形态也命中同一条长连接，且以归一化后的 http 形态为捕获基准', () => {
    // `findWsRule` 是「http 形态优先」：同一条规则用 https:// 写也能拦 wss://，
    // 而 `rewriteWsUrl` 拿 httpUrl 去匹配末尾捕获——两边不一致就会拼出两个不同的尾部。
    armProxy([rule({ matchPattern: 'https://fat.example.com/ws/*' })]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');
  });

  it('末尾 * 捕获为空时不补分隔斜杠（与 SW 侧 rewriteUrl 同一份已知差异）', () => {
    // 现状记录：DNR 的静态模板会补成 `https://b.com/`，而这里省略。两者指向同一资源，
    // 既有口径刻意保留差异（AGENTS.md「两处已接受的通道差异」），别当成待修项「顺手对齐」。
    armProxy([rule()]);
    expect(connectedUrl('wss://fat.example.com/ws/')).toBe('wss://uat.example.com/ws');
  });

  it('prefix 规则：模式以 / 结尾时把那一截补回去，两种写法拼出同一个地址', () => {
    armProxy([
      rule({ matchType: 'prefix', matchPattern: 'wss://fat.example.com/ws/', targetUrl: 'wss://uat.example.com/ws' }),
    ]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');

    // 模式不以 / 结尾时斜杠本就在剩余段里，不该再补一次
    armProxy([
      rule({
        id: 'r-p2',
        matchType: 'prefix',
        matchPattern: 'wss://fat.example.com/ws',
        targetUrl: 'wss://uat.example.com/ws',
      }),
    ]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');
  });

  it('regex 规则是片段替换，不是整体替换（与 DNR 的 regexSubstitution 语义不同）', () => {
    // 现状记录：`base.replace(regex, targetUrl)` 只替换匹配到的片段，所以这条覆盖不全的
    // 模式留下的尾部还在。这是双通道已确认差异（AGENTS.md），统一它要改的是匹配语义本身。
    armProxy([
      rule({
        matchType: 'regex',
        matchPattern: '^wss://fat\\.example\\.com/ws',
        targetUrl: 'wss://uat.example.com/backup',
      }),
    ]);
    expect(connectedUrl()).toBe('wss://uat.example.com/backup/live');
  });

  it('正则写成 https:// 形态也参与重写：替换的基准是归一化后的地址', () => {
    // `rewriteWsUrl` 换的是 `base`，而 base 只在「http 形态能匹配上」时才取归一化地址。
    // 这一条与上一条正好凑成两边：漏了这层选择，https 形态的正则规则会命中却不改写——
    // 页面看着规则是绿的、连接照旧打到自己域，比不命中更难查。
    armProxy([
      rule({
        matchType: 'regex',
        matchPattern: '^https://fat\\.example\\.com/ws',
        targetUrl: 'wss://uat.example.com/backup',
      }),
    ]);
    expect(connectedUrl()).toBe('wss://uat.example.com/backup/live');
  });

  it('目标地址带尾部斜杠时不拼出双斜杠：wildcard 与 prefix 各自收一份', () => {
    // 两条分支各写了一遍 `wsTarget.replace(/\/$/, '')`（SW 侧 `rewriteUrl` 是同罪第三处）。
    // 表单里填成 `https://uat.example.com/ws/` 是很自然的写法，而拼出双斜杠之后
    // 有的网关按另一条路由处理——页面只会拿到一个说不清的响应。
    armProxy([rule({ targetUrl: 'https://uat.example.com/ws/' })]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');

    armProxy([
      rule({
        id: 'r-p',
        matchType: 'prefix',
        matchPattern: 'wss://fat.example.com/ws',
        targetUrl: 'wss://uat.example.com/ws/',
      }),
    ]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');
  });

  it('多 * 模式（*://*.example.com/ws/*）走正则捕获，而不是 startsWith', () => {
    armProxy([rule({ matchPattern: '*://*.example.com/ws/*', targetUrl: 'wss://uat.example.com/ws' })]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');
  });

  it('没有 targetUrl 的规则：命中也不改写，交回原地址', () => {
    armProxy([rule({ targetUrl: '' })]);
    expect(connectedUrl()).toBe(WS_URL);
  });

  it('协议与子协议一起交下去：单个字符串与数组两种写法都不吞', () => {
    armProxy([rule()]);
    expect(connectOne(WS_URL, 'chat').protocols).toBe('chat');
    expect(connectOne(WS_URL, ['chat', 'superchat']).protocols).toEqual(['chat', 'superchat']);
  });

  it("页面传空串协议时干脆不交第二参：`new WebSocket(url, '')` 会被浏览器判成非法子协议", () => {
    // `protocols ? …` 走的是真假值而不是「有没有传」，空串正好落进不交第二参这一支。
    // 这条钉的是**实参个数**：值一样、个数不一样，结局一个是正常握手、一个是构造器抛
    // SyntaxError——真浏览器按 WebIDL 把空串当非法子协议，而拦截器不该替页面制造它。
    armProxy([rule()]);
    expect(connectOne(WS_URL, '').arity).toBe(1);
    // 现状记录：空数组是 truthy，会带着第二参交下去——WebIDL 把空序列视为「不协商子协议」，
    // 与不传等价，所以这一支不需要跟着收口。
    expect(connectOne(WS_URL, []).arity).toBe(2);
  });

  it('模式里的 `.` 是真点号：写给内网域名的规则不放行同形异名域', () => {
    // wildcard 编译时先转义 `[.+?^${}()|[\]\\]` 再把 `*` 换成 `.*`。漏掉转义，`fat.example.com`
    // 就会顺手放行 `fatXexample.com`。这条只在阻断规则上量得出来——命中判定先把关，
    // 改写那一步另有一份转义，所以「不改写」那一半两种实现都给同一个结果，误伤却是实打实的。
    // （`utils/urlMatcher.ts` 与拦截器各持一份同样的转义。）
    armProxy([rule()]);
    expect(connectedUrl('wss://fatXexample.com/ws/live')).toBe('wss://fatXexample.com/ws/live');

    armProxy([rule({ blocked: true })]);
    expect(connectedUrl('wss://fatXexample.com/ws/live')).toBe('wss://fatXexample.com/ws/live');
  });
});

describe('什么时候不拦：闸门、方法白名单与阻断', () => {
  it('未命中任何规则：URL 与 protocols 原样交给原生构造器', () => {
    armProxy([rule({ matchPattern: 'wss://other.example.com/ws/*' })]);
    const entry = connectOne(WS_URL, ['chat', 'superchat']);
    expect(entry.url).toBe(WS_URL);
    expect(entry.protocols).toEqual(['chat', 'superchat']);
    // 未命中那一支也要收空串：它和命中分支是两处同样的三元表达式，少收一处就是
    // 「只有被代理的页面会炸」这种更难查的表现。
    expect(connectOne(WS_URL, '').arity).toBe(1);
  });

  it('传 URL 对象时按 href 匹配，未命中则把那个对象本身交回原生', () => {
    armProxy([rule({ matchPattern: 'wss://other.example.com/ws/*' })]);
    const url = new URL(WS_URL);
    expect(connectOne(url).url).toBe(url);
  });

  it('传 URL 对象且命中时，交下去的是重写后的字符串', () => {
    // 命中分支用的是 `wsUrl`（已取过 href），未命中分支用的是原始入参——两条路径不同形，
    // 页面拿到的类型因此可能是 string 或 URL。这里钉的是「重写一定给字符串」，
    // 因为 `new WebSocket(URL 对象)` 与 `new WebSocket(string)` 对服务端是同一件事，
    // 而带重写的 URL 对象会让拼接结果被再解析一次。
    armProxy([rule()]);
    expect(connectOne(new URL(WS_URL)).url).toBe('wss://uat.example.com/ws/live');
  });

  it('总开关关闭：连命中规则的模式也原样发出', () => {
    armProxy([rule()], false);
    expect(connectedUrl()).toBe(WS_URL);
  });

  it('规则被禁用：不参与匹配', () => {
    armProxy([rule({ enabled: false })]);
    expect(connectedUrl()).toBe(WS_URL);
  });

  it('握手按 GET 过方法白名单：只放行 POST 的规则拦不到长连接', () => {
    armProxy([rule({ methods: ['POST'] })]);
    expect(connectedUrl()).toBe(WS_URL);
  });

  it('方法白名单大小写不敏感：写 get 照样拦', () => {
    armProxy([rule({ id: 'r-get', methods: ['get'] })]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');
  });

  it('正则规则读不动时连拦都不拦：ReDoS 嫌疑与写坏的模式同一条退路', () => {
    // `getCompiledRegex` 返回 null → `matchUrl` 判 false → `findWsRule` 压根找不到这条规则。
    // 这一档必须是「当这条规则不存在」，不能是「命中了再想办法」：抛在页面的 `new WebSocket()`
    // 里，站点看到的是一个和自己代码无关的 SyntaxError。
    armProxy([rule({ matchType: 'regex', matchPattern: '^wss://fat\\.example\\.com/(a+)+' })]);
    expect(connectedUrl()).toBe(WS_URL);
    expect(warnSpy.mock.calls.flat()).toContain('[CrossOriginProxy] Skipping unsafe regex pattern (ReDoS risk):');

    armProxy([rule({ id: 'r-broken', matchType: 'regex', matchPattern: '^wss://fat\\.example\\.com/ws(' })]);
    expect(connectedUrl()).toBe(WS_URL);
  });

  it('wildcard 模式不以 * 结尾：命中判定认它，重写那一步拒它，于是原样连出去', () => {
    // 现状记录：`matchUrl` 把 `*` 编译成正则通吃，而 `rewriteWsUrl` 只认「末尾那截捕获」这一种
    // 形态，模式不以 `*` 收尾就直接 return 原地址。结果是一条在界面上看着生效、
    // 实际不改写的规则——真要把这种写法支持了，得连 SW 侧 `rewriteUrl` 一起改匹配语义。
    armProxy([rule({ matchPattern: 'wss://fat.example.com/ws*live' })]);
    expect(connectedUrl()).toBe(WS_URL);
  });

  it('阻断规则连向必然拒绝的本地端口，真实地址一次都不出现', () => {
    // 「先判阻断、后重写」这个顺序按结局钉：顺序反了会真的连出去一次（`fat.example.com`
    // 出现在任何一支构造里），再由第二次构造去拒绝——阻断对长连接静默失效。
    armProxy([rule({ blocked: true })]);
    connectOne(WS_URL, ['chat']);
    expect(allConstructs().map(entry => entry.url)).toEqual(['ws://127.0.0.1:1']);
    expect(JSON.stringify(allConstructs())).not.toContain('fat.example.com');
  });

  it('现状记录：阻断那一支不带 protocols（连接永远不会建立，子协议无从协商）', () => {
    armProxy([rule({ blocked: true })]);
    expect(connectOne(WS_URL, ['chat']).protocols).toBeUndefined();
  });

  it('阻断的告警点名规则与原始地址', () => {
    armProxy([rule({ name: '禁止长连接', blocked: true })]);
    connectOne(WS_URL);
    const message = warnSpy.mock.calls.flat();
    expect(message).toContain('禁止长连接');
    expect(message).toContain(WS_URL);
  });

  it('命中重写的告警说出「从哪到哪」', () => {
    armProxy([rule()]);
    connectOne();
    expect(warnSpy.mock.calls.flat()).toContain('wss://uat.example.com/ws/live');
  });
});

describe('queryOverrides：定点增删，不重编码别人那一份', () => {
  it('追加一个新参数，已有参数的原文一字不动', () => {
    // 镜像自 `utils/urlMatcher.ts` 的 applyQueryOverrides，承重理由相同：
    // `searchParams.set()` 会把**所有**参数重新编解码，`redirect=https://y.com?a=1`
    // 这种回调地址一变，服务端的白名单比对与签名就废了——而页面只看得到握手被拒。
    armProxy([rule({ queryOverrides: { token: 'abc def' } })]);
    expect(connectedUrl('wss://fat.example.com/ws/live?redirect=https://y.com?a=1&sign=x%2Fy')).toBe(
      'wss://uat.example.com/ws/live?redirect=https://y.com?a=1&sign=x%2Fy&token=abc%20def',
    );
  });

  it('覆盖同名参数：重复项合并成一条，留在首次出现的位置', () => {
    armProxy([rule({ queryOverrides: { room: 'r2' } })]);
    expect(connectedUrl('wss://fat.example.com/ws/live?room=r1&room=r0')).toBe('wss://uat.example.com/ws/live?room=r2');
  });

  it('参数名写成编码形态也认得：to%6Ben 与 token 算同一个', () => {
    armProxy([rule({ queryOverrides: { token: 'new' } })]);
    expect(connectedUrl('wss://fat.example.com/ws/live?to%6Ben=old')).toBe('wss://uat.example.com/ws/live?token=new');
  });

  it('没有配置 queryOverrides 时不凭空加一个问号', () => {
    armProxy([rule()]);
    expect(connectedUrl()).toBe('wss://uat.example.com/ws/live');
  });

  it('queryOverrides 是空对象时同样不改地址', () => {
    armProxy([rule({ queryOverrides: {} })]);
    expect(connectedUrl('wss://fat.example.com/ws/live?a=1')).toBe('wss://uat.example.com/ws/live?a=1');
  });

  it('hash 留在最后：注入的参数进不了片段标识符', () => {
    armProxy([rule({ queryOverrides: { a: '1' } })]);
    expect(connectedUrl('wss://fat.example.com/ws/live#frag')).toBe('wss://uat.example.com/ws/live?a=1#frag');
  });

  it('查询串含裸 % 时不抛错：解码失败退回原值', () => {
    // 目标地址是用户填的、查询串是页面拼的，两处都可能带非法规则；抛在构造器里
    // 等于页面的 `new WebSocket()` 直接炸。
    armProxy([rule({ queryOverrides: { '100%': 'x' } })]);
    expect(connectedUrl('wss://fat.example.com/ws/live?100%bad=1')).toBe(
      'wss://uat.example.com/ws/live?100%bad=1&100%25=x',
    );
  });

  it('查询串里的空段不跟着进结果：`?a=1&&` 不会长成 `?a=1&&&b=2`', () => {
    // 页面自己拼的串经常带空段（`params.set()` 循环、模板尾部多个 `&`）。
    // 空段原样留着，注入的参数就挂在一片空白后面——服务端按 split('&') 数参数时会多算一个。
    armProxy([rule({ queryOverrides: { b: '2' } })]);
    expect(connectedUrl('wss://fat.example.com/ws/live?a=1&&')).toBe('wss://uat.example.com/ws/live?a=1&b=2');
  });

  it('重写结果本身不是合法 URL 时只放弃注入，不把异常抛给页面', () => {
    // 目标地址是用户填的原文，`new URL` 是这里唯一读得懂它的东西。判非法之后返回的是
    // 「没叠参数的那一份」，而不是替用户把地址改合法——真浏览器随后会在自己的构造器里
    // 拒掉这个地址，那是它该报的错；扩展这边要守的只有「我这一段不炸」。
    armProxy([
      rule({
        matchType: 'regex',
        matchPattern: '^wss://fat\\.example\\.com/ws',
        targetUrl: '::invalid::',
        queryOverrides: { token: 'x' },
      }),
    ]);
    expect(connectedUrl()).toBe('::invalid::/live');
  });

  it('阻断规则不注入查询参数：连的是本地死端口，参数没有落脚处', () => {
    armProxy([rule({ blocked: true, queryOverrides: { token: 'abc' } })]);
    expect(connectedUrl('wss://fat.example.com/ws/live')).toBe('ws://127.0.0.1:1');
  });
});

describe('替换 window.WebSocket 之后留下的那一面', () => {
  it('四个静态常量跟着搬过来：页面的 WebSocket.OPEN 还是 1', () => {
    const Ctor = win.WebSocket as unknown as Record<string, number>;
    expect([Ctor.CONNECTING, Ctor.OPEN, Ctor.CLOSING, Ctor.CLOSED]).toEqual([0, 1, 2, 3]);
  });

  it('prototype 指向原生那一份：页面的 instance instanceof WebSocket 不塌', () => {
    // 拦截器返回的是原生实例，而 `new` 看的是被替换掉的那个函数的 prototype——
    // 少了这一行赋值，页面里 `socket instanceof WebSocket` 会静默变成 false。
    armProxy([rule()]);
    const Ctor = win.WebSocket as unknown as new (u: string) => unknown;
    expect(new Ctor(WS_URL)).toBeInstanceOf(Ctor);
  });

  it('握手不记任何自报计数：这一条通道刻意在四个计数之外', async () => {
    // AGENTS.md「WebSocket 握手刻意不计数」。推进 1.1s 是为了把节流补报的窗口也覆盖掉：
    // 若哪天有人给 WS 加一笔 bump，这条会红，那时要问的是「界面那句话还准不准」。
    armProxy([rule()]);
    vi.useFakeTimers();
    connectOne();
    await vi.advanceTimersByTimeAsync(1100);
    expect(payloadOfType(INTERCEPTOR_STATS)).toEqual([]);
  });
});

describe('手工副本与 utils 侧：同一批输入必须给同一个答案', () => {
  /** 一份输入同时喂两边：拦截器（副本走 wss 形态、utils 走 https 形态），只比参数结果 */
  const MIRROR_BASE = 'wss://fat.example.com/';
  const MIRROR_TARGET = 'https://api.uat.example.com';

  const cases: Array<[string, Record<string, string> | undefined]> = [
    ['wss://fat.example.com/x?redirect=https://y.com?a=1', { s: '1' }],
    ['wss://fat.example.com/x?env=dev&env=old&keep=1', { env: 'uat' }],
    ['wss://fat.example.com/x?a=1&&', { b: '2' }],
    ['wss://fat.example.com/x?to%6Ben=old', { token: 'new' }],
    ['wss://fat.example.com/x?q=a%20b', { env: 'uat' }],
    ['wss://fat.example.com/x?y=1#/route', { env: 'uat' }],
    ['wss://fat.example.com/x?100%bad=1', { '100%': 'x' }],
    ['wss://fat.example.com/x', { q: 'a b' }],
    ['wss://fat.example.com/x?a=1', {}],
    ['wss://fat.example.com/x?a=1', undefined],
  ];

  it.each(cases)('%s + %j', (input, overrides) => {
    armProxy([rule({ matchPattern: `${MIRROR_BASE}*`, targetUrl: MIRROR_TARGET, queryOverrides: overrides })]);
    const rest = input.slice(MIRROR_BASE.length);
    // utils 侧的答案按 `toWsUrl` 的映射规则换成 wss，剩下的应当逐字符相同
    const fromUtils = applyQueryOverrides(`${MIRROR_TARGET}/${rest}`, overrides).replace(/^https:\/\//, 'wss://');
    expect(connectedUrl(input)).toBe(fromUtils);
  });
});
