/**
 * messageRouter 安全边界的行为测试
 *
 * 断言全部打在 `@/entrypoints/background/messageRouter` 的真实现上（`vi.stubGlobal` +
 * 动态 `import`，与 `batchMigrate` / `round4-regression` 同一套路）。
 *
 * 三层契约：
 * 1. `isTrustedSender` 只认「以本扩展 URL 根（含尾斜杠）**开头**」的 `sender.url`，
 *    且只读 `url` 一个字段；
 * 2. 状态修改类消息在 gate 处同步拒绝、不触达存储，且 gate 先于参数校验；
 * 3. 不可信 sender 的**任何**消息类型都不得产生写入——这条与第 2 条合起来钉住
 *    「新加写 handler 却忘了进 `STATE_MUTATING_TYPES`」的盲区（类型清单是手抄的，
 *    清单漏一项时第 2 条抓不到，第 3 条抓得到）。
 *
 * 只读消息与 `PROXY_REQUEST` 不经 gate 是当前实现的既有事实：内容脚本的 `sender.url`
 * 就是页面 URL。来源约束的正解在桥接层（见 `entrypoints/content.ts`），不在这里。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageType } from '@/utils/types';
import { STORAGE_KEYS } from '@/utils/constants';

type RouterModule = typeof import('@/entrypoints/background/messageRouter');
type RouterListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

/** Chrome 真实扩展 ID 是 32 位 a–p，用近真值才不会让「同前缀伪 ID」用例失真 */
const SELF_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXT_ID = 'pppppppppppppppppppppppppppppppp';
const SELF_BASE = `chrome-extension://${SELF_ID}/`;
const TRUSTED_PAGE_URL = `${SELF_BASE}options/index.html`;
const EXTERNAL_PAGE_URL = 'https://evil.example.com/app.html';

/** 预期处于 gate 之下的状态修改面：断言的是真行为，不是这份清单自身 */
const MUTATING_TYPES: MessageType[] = [
  MessageType.UPDATE_PROXY_CONFIG,
  MessageType.TOGGLE_PROXY,
  MessageType.TOGGLE_RULE,
  MessageType.ADD_RULE,
  MessageType.BATCH_ADD_RULES,
  MessageType.UPDATE_RULE,
  MessageType.DELETE_RULE,
  MessageType.BATCH_DELETE_RULES,
  MessageType.BATCH_TOGGLE_RULES,
  MessageType.BATCH_UPDATE_TARGETS,
  MessageType.REORDER_RULES,
  MessageType.CLEAR_REQUEST_LOG,
  MessageType.IMPORT_CONFIG,
  MessageType.IMPORT_HAR,
  MessageType.SAVE_PROFILE,
  MessageType.LOAD_PROFILE,
  MessageType.DELETE_PROFILE,
  MessageType.SET_VARIABLES,
];

/**
 * 只读、但响应体是凭据真值或整包历史快照的消息：与状态修改类共用同一道 gate。
 *
 * 这一组的存在正是「只读消息不加 gate」那条约束的边界——它挡的是内容脚本要用的消息，
 * 而这两条桥接层从不转发。少了这道 gate，任意页面一次 sendMessage 就能读走
 * 用户所有环境的密钥（或历次成套替换前的真实请求头），「真值只在 SW 展开」的整套设计当场作废。
 *
 * 判据是「页面从不读取 + 回的是凭据类数据」，两者缺一都不该加进来：给内容脚本要用的消息
 * 加 gate 等于当场废掉代理。
 */
const CREDENTIAL_READING_TYPES: MessageType[] = [MessageType.GET_VARIABLES];

/** 刻意不经 gate 的消息：内容脚本要靠它们拉配置与代理，被 gate 住代理当场失效 */
const UNGATED_REACHABLE: Array<[MessageType, unknown]> = [
  [MessageType.GET_PROXY_CONFIG, undefined],
  [MessageType.GET_REQUEST_LOG, undefined],
  [MessageType.GET_PROXY_STATUS, undefined],
  [MessageType.GET_SW_STATS, undefined],
  [MessageType.GET_PROFILES, undefined],
  [MessageType.PROXY_REQUEST, { requestId: 'r1', url: EXTERNAL_PAGE_URL, method: 'GET' }],
];

/** 各状态修改类型的最小可用载荷：证明「被拒」是因为 sender，不是因为数据 */
const PAYLOADS: Partial<Record<MessageType, unknown>> = {
  [MessageType.UPDATE_PROXY_CONFIG]: { enabled: false, rules: [] },
  [MessageType.TOGGLE_PROXY]: { enabled: true },
  [MessageType.TOGGLE_RULE]: { ruleId: 'a', enabled: true },
  [MessageType.ADD_RULE]: { rule: {} },
  [MessageType.BATCH_ADD_RULES]: { rules: [] },
  [MessageType.UPDATE_RULE]: { rule: { id: 'a' } },
  [MessageType.DELETE_RULE]: { ruleId: 'a' },
  [MessageType.BATCH_DELETE_RULES]: { ruleIds: ['a'] },
  [MessageType.BATCH_TOGGLE_RULES]: { ruleIds: ['a'], enabled: true },
  [MessageType.BATCH_UPDATE_TARGETS]: { updates: [{ id: 'a', targetUrl: 'https://uat.example.com' }] },
  [MessageType.REORDER_RULES]: { orderedIds: ['a'] },
  [MessageType.IMPORT_CONFIG]: { config: { enabled: false, rules: [] } },
  [MessageType.IMPORT_HAR]: { log: { entries: [] } },
  [MessageType.SAVE_PROFILE]: { name: 'p' },
  [MessageType.LOAD_PROFILE]: { profileId: 'p1' },
  [MessageType.DELETE_PROFILE]: { profileId: 'p1' },
  [MessageType.SET_VARIABLES]: { variables: { UAT_TOKEN: 'x' } },
};

let isTrustedSender: RouterModule['isTrustedSender'];
let listener: RouterListener | undefined;
let setSpy: ReturnType<typeof vi.fn>;
let extensionUrlBase: string;
let getMatchedRulesFn: ReturnType<typeof vi.fn>;
let getDynamicRulesFn: ReturnType<typeof vi.fn>;
const store: Record<string, unknown> = {};

beforeEach(async () => {
  listener = undefined;
  extensionUrlBase = SELF_BASE;
  for (const key of Object.keys(store)) delete store[key];
  // 总开关关闭：PROXY_REQUEST 走 Bypass 分支，测试期间不会有真 fetch
  store[STORAGE_KEYS.PROXY_CONFIG] = { enabled: false, rules: [] };

  setSpy = vi.fn(async (obj: Record<string, unknown>) => {
    Object.assign(store, obj);
  });
  // GET_DNR_STATS 会打到采样器：默认给一份「有动态规则 + 一条命中」的桩，
  // 让「所有消息类型都被 dispatch 一遍」的那两个用例不会因为缺桩而 reject。
  getMatchedRulesFn = vi.fn(async () => ({
    rulesMatchedInfo: [{ rule: { ruleId: 10001, rulesetId: '_dynamic' }, tabId: 7, timeStamp: Date.now() }],
  }));
  getDynamicRulesFn = vi.fn(async () => [{ id: 10001 }]);
  vi.stubGlobal('chrome', {
    runtime: {
      id: SELF_ID,
      getURL: (path?: string) => `${extensionUrlBase}${path ?? ''}`,
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: {
        addListener: vi.fn((fn: typeof listener) => {
          listener = fn;
        }),
      },
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: setSpy,
      },
      onChanged: { addListener: vi.fn() },
    },
    declarativeNetRequest: {
      getMatchedRules: getMatchedRulesFn,
      getDynamicRules: getDynamicRulesFn,
    },
  });

  vi.resetModules();
  const mod = await import('@/entrypoints/background/messageRouter');
  isTrustedSender = mod.isTrustedSender;
  mod.setupMessageRouter();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 把一条消息打进真的 onMessage 监听器，同步返回通道保持标记 */
function dispatch(type: MessageType, senderUrl: unknown, data: unknown = PAYLOADS[type]) {
  const sendResponse = vi.fn();
  const keepChannelOpen = listener!({ type, data }, { url: senderUrl }, sendResponse);
  return { sendResponse, keepChannelOpen };
}

function lastResponse(sendResponse: ReturnType<typeof vi.fn>) {
  return sendResponse.mock.calls.at(-1)?.[0] as { error?: string } | undefined;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('isTrustedSender — 只信任以本扩展 URL 根开头的 sender.url', () => {
  const trustedPaths = ['popup.html', 'options/index.html', 'background/service_worker.js', 'deep/a/b/c.html', ''];

  for (const path of trustedPaths) {
    it(`扩展自身资源 ${path || '(URL 根)'} 应被信任`, () => {
      expect(isTrustedSender({ url: `${SELF_BASE}${path}` })).toBe(true);
    });
  }

  const untrustedUrls: Array<[string, string]> = [
    ['http 页面', 'http://example.com/page.html'],
    ['https 页面', EXTERNAL_PAGE_URL],
    ['本地开发服务器', 'http://localhost:5173/app'],
    ['裸 IP 页面', 'http://127.0.0.1:8080/page'],
    ['file 协议', 'file:///Users/dev/page.html'],
    ['about:blank', 'about:blank'],
    ['data URL', 'data:text/html,<html></html>'],
    ['其他扩展', `chrome-extension://${OTHER_EXT_ID}/popup.html`],
    ['同前缀但更长的 ID', `chrome-extension://${SELF_ID}x/popup.html`],
    ['同前缀 + 连字符', `chrome-extension://${SELF_ID}-evil/popup.html`],
    ['缺尾斜杠的拼接', `${SELF_BASE.slice(0, -1)}-popup.html`],
    ['域名式伪装', `chrome-extension://${SELF_ID}.evil.com/popup.html`],
    ['被截短的 ID', `chrome-extension://${SELF_ID.slice(0, 31)}/popup.html`],
    ['大写化 ID', `chrome-extension://${SELF_ID.toUpperCase()}/popup.html`],
    ['西里尔字母混淆', 'chrome-extension://аbcdefghijklmnopabcdefghijklmnop/popup.html'],
  ];

  for (const [label, url] of untrustedUrls) {
    it(`${label} 应被拒绝`, () => {
      expect(isTrustedSender({ url })).toBe(false);
    });
  }

  it('扩展 URL 根出现在非起始位置时应被拒绝（判据必须是前缀而非包含）', () => {
    expect(isTrustedSender({ url: `https://evil.example.com/?next=${encodeURIComponent(SELF_BASE)}x.html` })).toBe(
      false,
    );
    expect(isTrustedSender({ url: `http://127.0.0.1/${SELF_BASE}popup.html` })).toBe(false);
  });

  const emptyUrls: Array<[string, string | undefined]> = [
    ['undefined', undefined],
    ['空字符串', ''],
    ['仅空格', '   '],
  ];

  for (const [label, url] of emptyUrls) {
    it(`sender.url 为 ${label} 时应被拒绝`, () => {
      expect(isTrustedSender({ url })).toBe(false);
    });
  }

  it('sender.url 为 null 时应被拒绝', () => {
    expect(isTrustedSender({ url: null as unknown as string })).toBe(false);
  });

  it('只看 sender.url，其余字段不参与信任判定', () => {
    expect(isTrustedSender({ id: SELF_ID, frameId: 0, documentId: 'doc-1' })).toBe(false);
  });

  it('换一个运行时基址即不认旧 URL（扩展之间互不信任）', () => {
    expect(isTrustedSender({ url: TRUSTED_PAGE_URL })).toBe(true);
    extensionUrlBase = `chrome-extension://${OTHER_EXT_ID}/`;
    expect(isTrustedSender({ url: TRUSTED_PAGE_URL })).toBe(false);
  });
});

describe('状态修改类与凭据读取类消息 — 不可信 sender 必须同步拒绝且不触达存储', () => {
  for (const type of [...MUTATING_TYPES, ...CREDENTIAL_READING_TYPES]) {
    it(`${type} 由外部页面发出：回传 Unauthorized sender 且不写存储`, () => {
      const { sendResponse, keepChannelOpen } = dispatch(type, EXTERNAL_PAGE_URL);

      expect(keepChannelOpen).toBe(false);
      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'Unauthorized sender' });
      expect(setSpy).not.toHaveBeenCalled();
    });

    // 数据非法也不能掩盖来源判定：报的必须是来源不合法，而不是 Invalid data / Invalid rule
    // （传 null 而非 undefined：默认参数会把 undefined 换成合法载荷）
    it(`${type} 载荷非法时依旧优先报来源不合法`, () => {
      const { sendResponse, keepChannelOpen } = dispatch(type, EXTERNAL_PAGE_URL, null);

      expect(keepChannelOpen).toBe(false);
      expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'Unauthorized sender' });
    });
  }

  it(`枚举里被 gate 拦住的类型恰好等于预期的 ${MUTATING_TYPES.length + CREDENTIAL_READING_TYPES.length} 个`, () => {
    const gated = new Set<MessageType>();
    for (const type of Object.values(MessageType)) {
      const { sendResponse } = dispatch(type, EXTERNAL_PAGE_URL, { enabled: false });
      if (lastResponse(sendResponse)?.error === 'Unauthorized sender') gated.add(type);
    }
    expect([...gated].sort()).toEqual([...MUTATING_TYPES, ...CREDENTIAL_READING_TYPES].sort());
  });

  it('不可信 sender 的任何消息类型（含未来新增的）都不得写入存储', async () => {
    for (const type of Object.values(MessageType)) {
      dispatch(type, EXTERNAL_PAGE_URL, { enabled: true, rules: [], config: { enabled: true, rules: [] } });
    }
    await flush();
    expect(setSpy).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.PROXY_CONFIG]).toEqual({ enabled: false, rules: [] });
  });
});

describe('可信 sender 与未被 gate 的消息 — 路由照常往下走', () => {
  it('可信 sender 的 TOGGLE_PROXY 真正落库', async () => {
    const { sendResponse, keepChannelOpen } = dispatch(MessageType.TOGGLE_PROXY, TRUSTED_PAGE_URL, { enabled: true });
    expect(keepChannelOpen).toBe(true);
    await flush();
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
    expect((store[STORAGE_KEYS.PROXY_CONFIG] as { enabled: boolean }).enabled).toBe(true);
  });

  it('可信 sender 的非法载荷走参数校验分支而非 Unauthorized', () => {
    const { sendResponse } = dispatch(MessageType.TOGGLE_PROXY, TRUSTED_PAGE_URL, null);
    expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'Invalid data' });
  });

  for (const [type, data] of UNGATED_REACHABLE) {
    it(`${type} 不被 gate 拒（内容脚本 sender 的 URL 就是页面 URL）`, async () => {
      const { sendResponse } = dispatch(type, EXTERNAL_PAGE_URL, data);
      await flush();

      expect(sendResponse).toHaveBeenCalledTimes(1);
      expect(lastResponse(sendResponse)?.error).not.toBe('Unauthorized sender');
    });
  }
});

describe('GET_DNR_STATS — 只读、可带 tabId、采样失败不拖垮消息', () => {
  /** 取本次响应的 Promise 结果（`dispatch` 已把响应灌进 mock 的 sendResponse） */
  async function respondWith(data: unknown) {
    const { sendResponse, keepChannelOpen } = dispatch(MessageType.GET_DNR_STATS, TRUSTED_PAGE_URL, data);
    expect(keepChannelOpen).toBe(true);
    await flush();
    return sendResponse.mock.calls.at(-1)?.[0];
  }

  it('缺省走全局聚合：不带 filter 内容，返回 DnrSample', async () => {
    const sample = (await respondWith(undefined)) as { stats?: unknown; sampledAt?: number; stale?: boolean };
    expect(getMatchedRulesFn).toHaveBeenCalledWith({});
    expect(Array.isArray(sample.stats)).toBe(true);
    expect(typeof sample.sampledAt).toBe('number');
    expect(typeof sample.stale).toBe('boolean');
  });

  it('带 tabId 走按标签页采样（popup 用，不吃第二次配额）', async () => {
    await respondWith({ tabId: 7 });
    expect(getMatchedRulesFn).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('非数字 tabId 视为未提供，不产生 `{ tabId: undefined }` 这种歧义 filter', async () => {
    await respondWith({ tabId: '7' });
    expect(getMatchedRulesFn).toHaveBeenCalledWith({});
  });

  it('采样抛错时仍回结构完整的 DnrSample（stale 为真），读端才分得清「0 次」和「不知道」', async () => {
    getMatchedRulesFn.mockRejectedValueOnce(new Error('Quota exceeded'));
    const sample = (await respondWith(undefined)) as { stats?: unknown; stale?: boolean; error?: string };
    expect(sample.error).toBeUndefined();
    expect(Array.isArray(sample.stats)).toBe(true);
    expect(sample.stale).toBe(true);
  });

  it('内容脚本来源的 sender 也能读（只读消息不得加 gate）', async () => {
    const { sendResponse, keepChannelOpen } = dispatch(MessageType.GET_DNR_STATS, EXTERNAL_PAGE_URL, undefined);
    expect(keepChannelOpen).toBe(true);
    await flush();
    const sample = sendResponse.mock.calls.at(-1)?.[0] as { error?: string };
    expect(sample.error).toBeUndefined();
  });
});

describe('凭据变量消息 — 只有扩展页面能读写，非法载荷不得清空整表', () => {
  it('可信 sender 读回变量表原值', async () => {
    store[STORAGE_KEYS.VARIABLES] = { UAT_TOKEN: 'secret-a' };
    const { sendResponse, keepChannelOpen } = dispatch(MessageType.GET_VARIABLES, TRUSTED_PAGE_URL);
    expect(keepChannelOpen).toBe(true);
    await flush();
    expect(sendResponse).toHaveBeenCalledWith({ UAT_TOKEN: 'secret-a' });
  });

  it('可信 sender 整表写入并回报丢弃数', async () => {
    const { sendResponse } = dispatch(MessageType.SET_VARIABLES, TRUSTED_PAGE_URL, {
      variables: { UAT_TOKEN: 'secret-a', '1BAD NAME': 'x' },
    });
    await flush();
    expect(sendResponse).toHaveBeenCalledWith({ success: true, dropped: 1 });
    expect(store[STORAGE_KEYS.VARIABLES]).toEqual({ UAT_TOKEN: 'secret-a' });
  });

  it('载荷不是键值对象时报错，绝不落成空表把用户凭据清空', async () => {
    store[STORAGE_KEYS.VARIABLES] = { UAT_TOKEN: 'secret-a' };
    const { sendResponse } = dispatch(MessageType.SET_VARIABLES, TRUSTED_PAGE_URL, { variables: null });
    await flush();
    expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'INVALID_VARIABLES_PAYLOAD' });
    expect(setSpy).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.VARIABLES]).toEqual({ UAT_TOKEN: 'secret-a' });
  });

  it('外部页面即使带着合法载荷也读不到变量表', async () => {
    store[STORAGE_KEYS.VARIABLES] = { UAT_TOKEN: 'secret-a' };
    const { sendResponse } = dispatch(MessageType.GET_VARIABLES, EXTERNAL_PAGE_URL, undefined);
    await flush();
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(lastResponse(sendResponse))).not.toContain('secret-a');
    expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'Unauthorized sender' });
  });
});
