/**
 * 桥接层（ISOLATED world）的消息流：页面与 SW 之间只有这一道门
 *
 * `entrypoints/content.ts` 此前只被源码字符串契约守着：七个测试文件各自 `readFileSync` 一段
 * （`configSyncState` / `interceptorStats` / `cancelRequestPropagation` / `sendCredentials` /
 * `variables` / `messageRouter` / `channel-consistency`），也就是「读得到那几个词」就等于
 * 「认为行为没变」。这里把它当运行时代码测：真的调用 `main()`，用假 `window` 收 `postMessage`、
 * 用假 `chrome.runtime` 收发往 SW 的消息，再按消息流断言进出。
 *
 * 桥接层独立承担的四件事值得单独钉：
 * 1. **入站闸门**：只认本窗口 + 自家 channel。它挡的是跨窗口投递（父页朝这个 iframe 的
 *    `postMessage` 会以本 frame 的 window 为投递目标，但 `event.source` 是父窗口）；
 *    **同页面脚本挡不住**——那正是出口还要收窄一遍的理由（见第 2 条）。
 * 2. **出口形状**：发往页面的每一份配置都过 `toInterceptorConfig`，后台广播路径也不例外；
 *    每一份都用 `window.location.origin` 投递而不是 `*`。
 * 3. **失败必须出声**：SW 回失败信封或 `sendMessage` 抛错，都要落成一份带原 `requestId`、
 *    `status: 0` 的 `PROXY_RESPONSE`——静默意味着页面的请求挂到超时再回退原生。
 * 4. **旁路消息按键转发**：自报统计与取消请求各只带走自己那一两个键，页面塞进来的其余
 *    字段（URL、凭据）不得跟着进 SW。
 *
 * 只 stub `chrome`、`window` 与 `logger`（外加一份只负责收监听器的 `ctx`），收窄/整形/分流
 * 判定全走真实实现。逐字段凭据面在 `interceptorConfigPrivacy.test.ts`，
 * `normalizeProxyResponse` 的三处形状约束在 `proxyResponseGuard.test.ts`——这里只钉
 * 「桥接层确实用了它们，且用在了正确的出口上」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONTENT_SCRIPT_CHANNEL } from '@/utils/constants';
import { MessageType } from '@/utils/types';
import type { ProxyConfig, ProxyRule } from '@/utils/types';

type ContentScript = (typeof import('@/entrypoints/content'))['default'];
type MainFn = NonNullable<ContentScript['main']>;
type BridgeCtx = NonNullable<Parameters<MainFn>[0]>;
type PageListener = (event: { source: unknown; data: unknown }) => unknown;
type SwListener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => unknown) => unknown;
type Responder = (message: Record<string, unknown>) => unknown;

const ORIGIN = 'https://fat.example.com';
/** 桥接层与 MAIN world 之间的两个自有消息名（不走 `MessageType`，页面侧同样是字面量） */
const SYNC_RULES = 'SYNC_RULES';
const REQUEST_CONFIG = 'REQUEST_CONFIG';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/utils/logger', () => ({ logger }));

let main: MainFn | undefined;
let answer: Responder = () => undefined;

/**
 * 发往 SW 的每一个信封都在这里落账；`answer` 决定回什么，
 * 给它一个 reject 的 Promise 就是「SW 回收期 / 后台抛错」那条分支。
 */
const runtimeSendMessage = vi.fn((message: Record<string, unknown>) => {
  toSw.push(message);
  const result = answer(message);
  return result instanceof Promise ? result : Promise.resolve(result);
});

let posted: Array<{ payload: Record<string, unknown>; targetOrigin: string }>;
let toSw: Record<string, unknown>[];
let pageListeners: PageListener[];
let swListeners: SwListener[];

const fakeWindow = {
  location: { origin: ORIGIN },
  postMessage: (payload: unknown, targetOrigin: string): void => {
    posted.push({ payload: payload as Record<string, unknown>, targetOrigin });
  },
};

/** 桥接层只用 `ctx.addEventListener` 注册 message 监听，其余生命周期 API 一概不碰 */
const ctxStub = {
  addEventListener: (_target: unknown, type: string, handler: PageListener): void => {
    if (type === 'message') pageListeners.push(handler);
  },
};

function makeRule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchType: 'wildcard',
    matchPattern: 'https://fat.example.com/api/*',
    targetUrl: 'https://uat.example.com/api',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 复杂规则 + 全套凭据字段：桥接层必须把它收窄后才发回页面 */
const credentialedRule = (): ProxyRule =>
  makeRule({
    headerOverrides: { Authorization: 'Bearer secret-token' },
    mockResponse: { status: 200, body: '{"token":"secret-token"}' },
    sendCredentials: true,
    delayMs: 50,
  });

const configOf = (rules: ProxyRule[], enabled = true): ProxyConfig => ({ enabled, rules });

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** 从已发出的 `postMessage` 里按消息名取载荷 */
function sentOf(type: string): unknown[] {
  return posted.filter(entry => entry.payload.type === type).map(entry => entry.payload.data);
}

function toSwOf(type: string): Record<string, unknown>[] {
  return toSw.filter(message => message.type === type);
}

/** 页面（MAIN world）发来一条消息，并等桥接层把异步分支跑完 */
async function fromPage(data: unknown, source: unknown = fakeWindow): Promise<void> {
  for (const listener of pageListeners) await listener({ source, data });
  await settle();
}

/** 后台用 `tabs.sendMessage` 推来一条消息；回执是否**同步**给出，由调用方自己观察 */
function fromBackground(message: unknown): ReturnType<typeof vi.fn> {
  const sendResponse = vi.fn();
  for (const listener of swListeners) listener(message, {}, sendResponse);
  return sendResponse;
}

async function mount(responder: Responder = () => undefined): Promise<void> {
  posted = [];
  toSw = [];
  pageListeners = [];
  swListeners = [];
  answer = responder;
  runtimeSendMessage.mockClear();
  Object.values(logger).forEach(fn => fn.mockReset());
  if (!main) throw new Error('桥接层入口未导出 main()');
  await main(ctxStub as unknown as BridgeCtx);
}

beforeEach(async () => {
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: runtimeSendMessage,
      onMessage: { addListener: (fn: SwListener) => swListeners.push(fn) },
    },
  });
  vi.resetModules();
  main = (await import('@/entrypoints/content')).default.main;
});

describe('挂载即自取配置：不等页面开口', () => {
  it('main() 一运行就向 SW 拉一次配置', async () => {
    await mount();

    expect(toSw.map(message => message.type)).toEqual([MessageType.GET_PROXY_CONFIG]);
  });

  it('拉到的配置发往页面前先收窄：到页面的副本既没有凭据、也没被过度收窄', async () => {
    await mount(message =>
      message.type === MessageType.GET_PROXY_CONFIG ? configOf([credentialedRule()]) : undefined,
    );
    await settle();

    const [synced] = sentOf(SYNC_RULES) as ProxyConfig[];
    expect(synced.rules.map(rule => rule.id)).toEqual(['r1']);
    // 逐字段判据在 `interceptorConfigPrivacy.test.ts`，这里只钉「运行时这一跳确实过了它」：
    // 一个负向哨兵 + 一个正向哨兵，删掉 `toInterceptorConfig` 或换成原文都会红。
    expect(synced.rules[0]).not.toHaveProperty('headerOverrides');
    // 延迟由拦截器本身消费，不属于凭据，必须留着
    expect(synced.rules[0]).toHaveProperty('delayMs', 50);
  });

  it('每一封发往页面的消息都投给本页 origin，不是 `*`', async () => {
    await mount(message =>
      message.type === MessageType.PROXY_REQUEST
        ? { requestId: 'q1', status: 200, statusText: 'OK', headers: {}, body: '', isBase64: false }
        : configOf([credentialedRule()]),
    );
    await settle();
    await fromPage({
      channel: CONTENT_SCRIPT_CHANNEL,
      type: MessageType.PROXY_REQUEST,
      data: { requestId: 'q1', url: 'https://fat.example.com/api/x', method: 'GET' },
    });

    expect(posted.length).toBeGreaterThan(1);
    for (const entry of posted) {
      expect(entry.targetOrigin).toBe(ORIGIN);
    }
  });
});

describe('入站闸门：来源与频道不对，桥接层一个字都不转发', () => {
  const proxyAsk = { channel: CONTENT_SCRIPT_CHANNEL, type: MessageType.PROXY_REQUEST, data: { requestId: 'q1' } };
  /**
   * 每种子形状都应当「什么都不做」：既不进 SW，也不回页面。
   *
   * 关于第一条：`event.source` 由浏览器写成发送方的 window，同页面脚本（含 MAIN world 拦截器）
   * 发的一定是本窗口——那正是桥接层放行它的前提。node 环境造不出真的 window 代理，
   * 这条只能证明「代码读了这个判据」，真实语义是父页朝本 iframe 投递时 `source` 是父窗口。
   */
  const rejected: [string, { source: unknown; data: unknown }][] = [
    ['不是投给本窗口的（父页 → 本 iframe 的 postMessage）', { source: {}, data: proxyAsk }],
    [
      'channel 不是自家的',
      {
        source: fakeWindow,
        data: { channel: 'something-else', type: MessageType.PROXY_REQUEST, data: { requestId: 'q1' } },
      },
    ],
    [
      '连 channel 都没有（页面的普通 postMessage）',
      { source: fakeWindow, data: { type: MessageType.PROXY_REQUEST, data: { requestId: 'q1' } } },
    ],
    ['data 不是对象', { source: fakeWindow, data: CONTENT_SCRIPT_CHANNEL }],
    [
      'channel 对、type 是页面编的',
      {
        source: fakeWindow,
        data: { channel: CONTENT_SCRIPT_CHANNEL, type: 'DO_SOMETHING', data: { requestId: 'q1' } },
      },
    ],
    [
      'channel 对、type 是回包方向（不能让桥接层再发一次回包）',
      {
        source: fakeWindow,
        data: { channel: CONTENT_SCRIPT_CHANNEL, type: MessageType.PROXY_RESPONSE, data: { requestId: 'q1' } },
      },
    ],
  ];

  for (const [label, event] of rejected) {
    it(`${label} → 不转发、不回包`, async () => {
      await mount();

      await fromPage(event.data, event.source);

      expect(toSwOf(MessageType.PROXY_REQUEST)).toEqual([]);
      expect(sentOf(MessageType.PROXY_RESPONSE)).toEqual([]);
      expect(sentOf(SYNC_RULES)).toEqual([]);
    });
  }
});

describe('配置回放：消除两个 world 的注入时序竞态', () => {
  it('拦截器主动索取时已有缓存 → 直接回放，不再问一次 SW', async () => {
    await mount(message =>
      message.type === MessageType.GET_PROXY_CONFIG ? configOf([credentialedRule()]) : undefined,
    );
    await settle();

    await fromPage({ channel: CONTENT_SCRIPT_CHANNEL, type: REQUEST_CONFIG });

    expect(toSwOf(MessageType.GET_PROXY_CONFIG)).toHaveLength(1);
    expect(sentOf(SYNC_RULES)).toHaveLength(2);
    expect(sentOf(SYNC_RULES)[1]).toEqual(sentOf(SYNC_RULES)[0]);
  });

  it('拦截器先注入、缓存还是空的 → 现拉一份再下发', async () => {
    let pull = 0;
    await mount(() => {
      pull += 1;
      // 挂载那一次先空手而归，模拟「SW 还没准备好」
      return pull === 1 ? undefined : configOf([credentialedRule()]);
    });
    await settle();
    expect(sentOf(SYNC_RULES)).toEqual([]);

    await fromPage({ channel: CONTENT_SCRIPT_CHANNEL, type: REQUEST_CONFIG });

    expect(toSwOf(MessageType.GET_PROXY_CONFIG)).toHaveLength(2);
    const [synced] = sentOf(SYNC_RULES) as ProxyConfig[];
    expect(synced.rules.map(rule => rule.id)).toEqual(['r1']);
  });

  it('广播会顶掉缓存：之后来要配置的拦截器拿到的是新那一份', async () => {
    // 缓存有两个写者（初次/按需拉取、后台广播），只测一个就等于没测——
    // 漏了广播这一写，迟到的 MAIN world 会拿到旧规则还自称已同步。
    await mount(() => undefined);
    await settle();

    fromBackground({
      type: MessageType.UPDATE_PROXY_CONFIG,
      data: configOf([credentialedRule()]),
    });
    await fromPage({ channel: CONTENT_SCRIPT_CHANNEL, type: REQUEST_CONFIG });

    expect(toSwOf(MessageType.GET_PROXY_CONFIG)).toHaveLength(1);
    expect(sentOf(SYNC_RULES)).toHaveLength(2);
    expect((sentOf(SYNC_RULES)[1] as ProxyConfig).rules[0]).toHaveProperty('delayMs', 50);
  });
});

describe('后台广播：回执就是送达账唯一的信号', () => {
  it('UPDATE_PROXY_CONFIG：同步回执，且发往页面的仍是收窄版', async () => {
    await mount();

    const sendResponse = fromBackground({
      type: MessageType.UPDATE_PROXY_CONFIG,
      data: configOf([credentialedRule()]),
    });

    // 「同步」是硬要求：等一拍再回执，后台那条 promise 已经 reject 了
    expect(sendResponse).toHaveBeenCalledWith({ received: true });
    const [synced] = sentOf(SYNC_RULES) as ProxyConfig[];
    expect(synced.rules[0]).not.toHaveProperty('headerOverrides');
  });

  it('别的类型不作答、也不回内容：全仓只有广播那一次在等回执', async () => {
    // 送达账只认 `tabs.sendMessage` 那一条 promise 自己的落定（`dnrManager.ts:153-161`），
    // 所以「顺手给别的消息回执」并不会把账抹平——它的问题是往一个没有等待者的信道里回数据。
    // 这条钉的是形状：监听器只对 `UPDATE_PROXY_CONFIG` 有分支。
    await mount();

    for (const type of [MessageType.GET_PROXY_CONFIG, MessageType.PROXY_RESPONSE, 'SOMETHING_NEW']) {
      expect(fromBackground({ type, data: configOf([]) })).not.toHaveBeenCalled();
    }
    expect(sentOf(SYNC_RULES)).toEqual([]);
  });
});

describe('代理请求：完整载荷进 SW，回包必须认得原 requestId', () => {
  const request = { requestId: 'q1', url: 'https://fat.example.com/api/x', method: 'GET', headers: { accept: '*/*' } };

  it('原样转发给后台，并把响应按同一 requestId 送回页面', async () => {
    await mount(message =>
      message.type === MessageType.PROXY_REQUEST
        ? { requestId: 'q1', status: 204, statusText: 'No Content', headers: {}, body: 'ignored', isBase64: false }
        : undefined,
    );

    await fromPage({ channel: CONTENT_SCRIPT_CHANNEL, type: MessageType.PROXY_REQUEST, data: request });

    expect(toSwOf(MessageType.PROXY_REQUEST)).toEqual([{ type: MessageType.PROXY_REQUEST, data: request }]);
    const [response] = sentOf(MessageType.PROXY_RESPONSE) as Record<string, unknown>[];
    expect(response.requestId).toBe('q1');
    expect(response.status).toBe(204);
    // 桥接层不自己发明形状：null body 状态由 `normalizeProxyResponse` 收口
    expect(response.body).toBeNull();
  });

  it('后台回失败信封（没有 requestId / status）→ 补齐成一次可认领的失败，且不外泄内部错误文案', async () => {
    await mount(message =>
      message.type === MessageType.PROXY_REQUEST ? { success: false, error: 'fetch failed: ECONNREFUSED' } : undefined,
    );

    await fromPage({ channel: CONTENT_SCRIPT_CHANNEL, type: MessageType.PROXY_REQUEST, data: request });

    const [response] = sentOf(MessageType.PROXY_RESPONSE) as Record<string, unknown>[];
    expect(response.requestId).toBe('q1');
    expect(response.status).toBe(0);
    expect(response).not.toHaveProperty('error');
  });

  it('sendMessage 抛错（SW 回收期）→ 页面仍收到一份失败回包，不静默', async () => {
    await mount(message =>
      message.type === MessageType.PROXY_REQUEST ? Promise.reject(new Error('message port closed')) : undefined,
    );

    await fromPage({ channel: CONTENT_SCRIPT_CHANNEL, type: MessageType.PROXY_REQUEST, data: request });

    const [response] = sentOf(MessageType.PROXY_RESPONSE) as Record<string, unknown>[];
    expect(response).toMatchObject({ requestId: 'q1', status: 0, statusText: 'Content Script Error', headers: {} });
    // 静默是最糟的分支：请求会挂到超时再回退原生，所以这一层必须出声
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('旁路消息：按键转发，页面塞的其余字段不进 SW', () => {
  it('自报统计只带走四个计数（URL 与凭据不跟着走）', async () => {
    await mount();

    await fromPage({
      channel: CONTENT_SCRIPT_CHANNEL,
      type: MessageType.INTERCEPTOR_STATS,
      data: {
        intercepted: 3,
        proxied: 2,
        fellBack: 1,
        timedOut: 0,
        url: 'https://fat.example.com/api/x?token=secret',
        headerOverrides: { Authorization: 'Bearer secret-token' },
      },
    });

    expect(toSwOf(MessageType.INTERCEPTOR_STATS)).toEqual([
      {
        type: MessageType.INTERCEPTOR_STATS,
        data: { intercepted: 3, proxied: 2, fellBack: 1, timedOut: 0 },
      },
    ]);
  });

  it('自报统计的载荷不是对象 → 整条丢弃，不转发一个空壳', async () => {
    await mount();

    for (const data of [undefined, null, 'counts', 7]) {
      await fromPage({ channel: CONTENT_SCRIPT_CHANNEL, type: MessageType.INTERCEPTOR_STATS, data });
    }

    expect(toSwOf(MessageType.INTERCEPTOR_STATS)).toEqual([]);
  });

  it('SW 回收期本来就送不出去：不抛、不重试、不降级成 error', async () => {
    await mount(message =>
      message.type === MessageType.INTERCEPTOR_STATS ? Promise.reject(new Error('port closed')) : undefined,
    );

    await fromPage({
      channel: CONTENT_SCRIPT_CHANNEL,
      type: MessageType.INTERCEPTOR_STATS,
      data: { intercepted: 1, proxied: 0, fellBack: 1, timedOut: 0 },
    });

    expect(toSwOf(MessageType.INTERCEPTOR_STATS)).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('取消请求只带 requestId', async () => {
    await mount();

    await fromPage({
      channel: CONTENT_SCRIPT_CHANNEL,
      type: MessageType.CANCEL_REQUEST,
      data: { requestId: 'q9', url: 'https://fat.example.com/api/x' },
    });

    expect(toSwOf(MessageType.CANCEL_REQUEST)).toEqual([
      { type: MessageType.CANCEL_REQUEST, data: { requestId: 'q9' } },
    ]);
  });

  it('requestId 不是一个非空字符串 → 不转发', async () => {
    // 越权面不归这一层管：登记键是 `tabId::frameId::requestId`，前两段取自 Chrome 写入的
    // sender（`proxyHandler.ts:307`），跨标签页、跨 frame 本来就打不中；同 frame 内另一个
    // 合法 id 这一层也照样放行。拦下空 id 省掉的是「一次注定回 `Invalid requestId` 的往返」
    // 与一个没人读的回执（`content.ts:141` 不等回执）。
    await mount();

    for (const data of [undefined, {}, { requestId: '' }, { requestId: 12 }, { requestId: {} }]) {
      await fromPage({ channel: CONTENT_SCRIPT_CHANNEL, type: MessageType.CANCEL_REQUEST, data });
    }

    expect(toSwOf(MessageType.CANCEL_REQUEST)).toEqual([]);
  });
});

describe('现状记录：载荷缺失的 PROXY_REQUEST 抛在 try 之外', () => {
  it('不回包、不落 error 日志，监听器自己的 promise 落空', async () => {
    // 这一条是记账，不是背书。`const { data } = event.data` 与紧接着那句 `logger.debug`
    // 排在 `try` 之前（`content.ts:147-148`），所以 `data` 缺失时抛的是 TypeError：
    // 既走不到 catch 里那份 `status: 0` 信封，也不会 `logger.error`。
    // 真实拦截器永远带 `data`；同页脚本伪造这条只会给本 frame 添一个未处理拒绝，
    // 不会有请求被误代理——危害是「日志缺失」，不是「行为错误」。
    // 要不要挪进 `try`（那样页面会收到一份 requestId 为空串的回包）属于改行为，已列为待确认点。
    await mount();

    await expect(fromPage({ channel: CONTENT_SCRIPT_CHANNEL, type: MessageType.PROXY_REQUEST })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(toSwOf(MessageType.PROXY_REQUEST)).toEqual([]);
    expect(sentOf(MessageType.PROXY_RESPONSE)).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

/**
 * 桥接层通往 SW 的**出口清单**——门禁分档的前提，所以按源码枚举而不是逐型举例
 *
 * 上面各组只能证明「这四个出口各自行为正确」，证不出「没有第五个」。而 SW 侧有一批消息
 * 正是拿「页面没有通往它的路径」当不加 `isTrustedSender` 的理由（最典型是 `GET_IMPORT_PLAN`，
 * 见 `entrypoints/background/messageRouter.ts` 的 `handleImportPlan`）。这里多转发一型，
 * 那条理由当场失效，而所有既有用例照样全绿——所以把它钉成一张清单。
 * 新增出口时这里红是预期：先回来判一次「这一型该不该在门禁内」，再把名字加进清单。
 */
describe('[源码契约] 通往 SW 的出口只有这四种', () => {
  /** 先摘掉注释行：否则一句写着 `.sendMessage(` 的注释就能把计数抬到 6，报出的还是「第 6 处出口」那句误导话 */
  const bridgeSrc = readFileSync('entrypoints/content.ts', 'utf-8')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
  const callSites = [...bridgeSrc.matchAll(/\.sendMessage\(/g)].length;

  /** 只认 `.sendMessage(` 后面紧跟的对象字面量里那一个 `type:`，页面的 `postMessage` 不算出口 */
  const forwardedTypes = [
    ...new Set(
      [...bridgeSrc.matchAll(/\.sendMessage\(\s*\{[^}]*?type:\s*(?:MessageType\.)?([A-Z_]+)/g)].map(m => m[1]),
    ),
  ].sort();

  it('出口调用点恰有 5 处（`GET_PROXY_CONFIG` 两处、其余各一处），第 6 处一进来就红', () => {
    // 这一条是上面那条正则的盲区兜底：新增一处不带 `type: MessageType.X` 字面量的转发
    // （换行写法、常量表驱动、变量拼装），枚举可能看不见，调用点计数一定看得见。
    expect(callSites).toBe(5);
    expect(forwardedTypes).toHaveLength(4);
  });

  it('枚举结果恰是 GET_PROXY_CONFIG / INTERCEPTOR_STATS / CANCEL_REQUEST / PROXY_REQUEST', () => {
    expect(forwardedTypes).toEqual(['CANCEL_REQUEST', 'GET_PROXY_CONFIG', 'INTERCEPTOR_STATS', 'PROXY_REQUEST']);
  });

  it('没有绕过这两个正则的通道：解构出的 `sendMessage`、`runtime.connect` 长连接', () => {
    // `const { sendMessage } = chrome.runtime` 之后的调用点不带前导点号，上面两条同时失声，
    // 而它对页面而言就是一个新出口；端口通道更是一条正则根本覆盖不到的通路（今天为零）。
    expect(bridgeSrc).not.toMatch(/const\s*\{[^}]*\bsendMessage\b/);
    expect(bridgeSrc).not.toMatch(/\bruntime\.connect\s*\(/);
  });

  it('SW 侧引用这份清单的那两句判据，四个名字一个都没抄漏', () => {
    // `handleImportPlan` 与 `isTrustedSender` 的注释都把「不加 gate」的理由外包给这份清单，
    // 三处各写一份就会各说各话（实测只把其中一处一个类型名改短，只有这条红）。
    const routerSrc = readFileSync('entrypoints/background/messageRouter.ts', 'utf-8');
    const jsdocBefore = (anchor: string): string => {
      const at = routerSrc.indexOf(anchor);
      expect(at).toBeGreaterThan(-1);
      return routerSrc.slice(routerSrc.lastIndexOf('/**', at), at);
    };
    for (const anchor of ['async function handleImportPlan(', 'export function isTrustedSender(']) {
      const jsdoc = jsdocBefore(anchor);
      expect(jsdoc.length).toBeGreaterThan(0);
      for (const type of forwardedTypes) expect(jsdoc).toContain(type);
    }
  });

  it('AGENTS.md 里那份给下游读的清单与代码枚举一致', () => {
    // 内部文档是第三份手抄，而且是别人最不会去翻测试的那一份；它一漂，判据就又只剩口头承诺。
    const agents = readFileSync('AGENTS.md', 'utf-8');
    const at = agents.indexOf('桥接层通往 SW 只有');
    expect(at).toBeGreaterThan(-1);
    const clauseEnd = agents.indexOf('四个出口', at);
    expect(clauseEnd).toBeGreaterThan(at);
    const clause = agents.slice(at, clauseEnd);
    for (const type of forwardedTypes) expect(clause).toContain(type);
    // `REQUEST_CONFIG` 只能以「页面那侧写作 …」的身份出现——它是页面发给桥接层的名字，不是 SW 出口
    expect(clause).toContain('页面那侧写作 `REQUEST_CONFIG`');
  });
});
