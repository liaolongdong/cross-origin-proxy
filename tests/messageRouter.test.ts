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
 * 只读消息、`PROXY_REQUEST` 与 `CANCEL_REQUEST` 不经 gate 是当前实现的既有事实：内容脚本的
 * `sender.url` 就是页面 URL。来源约束的正解在桥接层（见 `entrypoints/content.ts`），不在这里。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageType } from '@/utils/types';
import { SCHEMA_VERSION, STORAGE_KEYS } from '@/utils/constants';

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
  MessageType.RESTORE_CONFIG_HISTORY,
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
const CREDENTIAL_READING_TYPES: MessageType[] = [MessageType.GET_VARIABLES, MessageType.GET_CONFIG_HISTORY];

/** 刻意不经 gate 的消息：内容脚本要靠它们拉配置与代理，被 gate 住代理当场失效 */
const UNGATED_REACHABLE: Array<[MessageType, unknown]> = [
  [MessageType.GET_PROXY_CONFIG, undefined],
  [MessageType.GET_REQUEST_LOG, undefined],
  [MessageType.GET_PROXY_STATUS, undefined],
  [MessageType.GET_SW_STATS, undefined],
  [MessageType.GET_PROFILES, undefined],
  // 导入预览是只读纯计算，回的是条数与规则名/模式，不含任何凭据真值
  [MessageType.GET_IMPORT_PLAN, { config: { enabled: false, rules: [] } }],
  // 拦截器自报（页面发来）与它的读端（popup 用）：一个最坏后果是显示假数字，一个回的是四个计数
  [MessageType.INTERCEPTOR_STATS, { intercepted: 1, proxied: 1, fellBack: 0, timedOut: 0 }],
  [MessageType.GET_INTERCEPTOR_STATS, { tabId: 7 }],
  // 配置广播的送达账：回的是一个布尔，改不了任何状态，加 gate 等于让那句话永远说不出口
  [MessageType.GET_CONFIG_SYNC, { tabId: 7 }],
  [MessageType.PROXY_REQUEST, { requestId: 'r1', url: EXTERNAL_PAGE_URL, method: 'GET' }],
  // 取消的正是页面自己发出去的那笔代发：给它加 gate 等于把「取消」这条通道焊死在页面之外
  [MessageType.CANCEL_REQUEST, { requestId: 'r1' }],
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
  [MessageType.RESTORE_CONFIG_HISTORY]: { id: 'h1' },
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
  return sendResponse.mock.calls.at(-1)?.[0] as { success?: boolean; error?: string } | undefined;
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

/** 构造一条结构合法、可与现网同键的规则 */
function importableRule(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: `https://api-${id}.example.com/*`,
    targetUrl: 'https://target.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('IMPORT_CONFIG — 实际写入结果带回界面', () => {
  it('合并模式回报 added / skipped / invalid 三个数（不再只报一句「导入成功」）', async () => {
    store[STORAGE_KEYS.PROXY_CONFIG] = {
      enabled: false,
      rules: [importableRule('c1')],
    };
    const { sendResponse } = dispatch(MessageType.IMPORT_CONFIG, TRUSTED_PAGE_URL, {
      config: {
        enabled: false,
        rules: [
          importableRule('i1', { name: 'rule-c1', matchPattern: 'https://api-c1.example.com/*' }),
          importableRule('i2'),
          { name: '缺字段的旧条目' },
        ],
      },
      mode: 'merge',
    });
    await flush();

    expect(lastResponse(sendResponse)).toEqual({ success: true, added: 1, skipped: 1, invalid: 1 });
    const stored = store[STORAGE_KEYS.PROXY_CONFIG] as { rules: Array<{ name: string }> };
    expect(stored.rules.map(r => r.name)).toEqual(['rule-c1', 'rule-i2']);
  });

  it('替换模式 skipped 恒为 0，invalid 仍然如实上报', async () => {
    const { sendResponse } = dispatch(MessageType.IMPORT_CONFIG, TRUSTED_PAGE_URL, {
      config: { enabled: true, rules: [importableRule('i1'), { name: 'x' }] },
      mode: 'replace',
    });
    await flush();

    expect(lastResponse(sendResponse)).toEqual({ success: true, added: 1, skipped: 0, invalid: 1 });
  });
});

describe('schemaVersion — 读并拒绝过新，不拒绝旧', () => {
  it('比本机认识的格式更新的导出被明确拒掉，且不触达存储', async () => {
    store[STORAGE_KEYS.PROXY_CONFIG] = { enabled: false, rules: [importableRule('c1')] };
    const { sendResponse } = dispatch(MessageType.IMPORT_CONFIG, TRUSTED_PAGE_URL, {
      schemaVersion: SCHEMA_VERSION + 1,
      config: { enabled: false, rules: [importableRule('i1')] },
      mode: 'replace',
    });
    await flush();

    expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'SCHEMA_TOO_NEW' });
    expect(setSpy).not.toHaveBeenCalled();
    expect(store[STORAGE_KEYS.PROXY_CONFIG]).toEqual({ enabled: false, rules: [importableRule('c1')] });
  });

  it('没有 schemaVersion 的历史文件照旧可导入（缺省按 v1 处理）', async () => {
    const { sendResponse } = dispatch(MessageType.IMPORT_CONFIG, TRUSTED_PAGE_URL, {
      exportTime: Date.now(),
      config: { enabled: false, rules: [importableRule('i1')] },
      mode: 'replace',
    });
    await flush();
    expect(lastResponse(sendResponse)?.success).toBe(true);
  });

  it('预览与写入用同一份版本判据（不能出现「预览能算、写入拒掉」）', async () => {
    const { sendResponse } = dispatch(MessageType.GET_IMPORT_PLAN, TRUSTED_PAGE_URL, {
      schemaVersion: SCHEMA_VERSION + 1,
      config: { enabled: false, rules: [importableRule('i1')] },
      mode: 'merge',
    });
    await flush();
    expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'SCHEMA_TOO_NEW' });
  });

  it('导出时写上当前版本', async () => {
    store[STORAGE_KEYS.PROXY_CONFIG] = { enabled: false, rules: [] };
    const { sendResponse } = dispatch(MessageType.EXPORT_CONFIG, TRUSTED_PAGE_URL, undefined);
    await flush();
    expect(lastResponse(sendResponse)).toMatchObject({ schemaVersion: SCHEMA_VERSION });
  });
});

describe('GET_IMPORT_PLAN — 纯计算，不落库', () => {
  it('回的是 plan，且一次写入都没有', async () => {
    store[STORAGE_KEYS.PROXY_CONFIG] = { enabled: false, rules: [importableRule('c1')] };
    const before = JSON.stringify(store[STORAGE_KEYS.PROXY_CONFIG]);

    const { sendResponse, keepChannelOpen } = dispatch(MessageType.GET_IMPORT_PLAN, TRUSTED_PAGE_URL, {
      config: {
        enabled: false,
        rules: [importableRule('i1', { name: 'rule-c1', matchPattern: 'https://api-c1.example.com/*' })],
      },
      mode: 'merge',
    });
    expect(keepChannelOpen).toBe(true);
    await flush();

    expect(lastResponse(sendResponse)).toEqual({
      success: true,
      plan: {
        mode: 'merge',
        added: 0,
        skipped: 1,
        conflicts: [
          {
            name: 'rule-c1',
            matchPattern: 'https://api-c1.example.com/*',
            currentTargetUrl: 'https://target.example.com',
            incomingTargetUrl: 'https://target.example.com',
          },
        ],
        duplicatesWithinFile: 0,
        replaces: 0,
        exceedsLimit: false,
      },
    });
    expect(setSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(store[STORAGE_KEYS.PROXY_CONFIG])).toBe(before);
  });

  it('内容脚本 / 页面来源的 sender 照样能读（只读消息不得加 gate）', async () => {
    const { sendResponse } = dispatch(MessageType.GET_IMPORT_PLAN, EXTERNAL_PAGE_URL, {
      config: { enabled: false, rules: [] },
      mode: 'merge',
    });
    await flush();
    expect(lastResponse(sendResponse)?.success).toBe(true);
  });
});

describe('配置恢复点消息 — 读取与凭据同档，回退属状态修改', () => {
  it('可信 sender 读到整包快照列表', async () => {
    store[STORAGE_KEYS.CONFIG_HISTORY] = [
      {
        id: 'h1',
        savedAt: 5,
        reason: 'replace-import',
        ruleCount: 1,
        config: { enabled: true, rules: [importableRule('old')] },
      },
    ];
    const { sendResponse } = dispatch(MessageType.GET_CONFIG_HISTORY, TRUSTED_PAGE_URL, undefined);
    await flush();

    const list = lastResponse(sendResponse) as unknown as Array<{ id: string; ruleCount: number }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.map(e => e.id)).toEqual(['h1']);
  });

  it('外部页面带着合法 id 也读不到快照（快照里的请求头是原样的真实值）', async () => {
    store[STORAGE_KEYS.CONFIG_HISTORY] = [
      {
        id: 'h1',
        savedAt: 5,
        reason: 'replace-import',
        ruleCount: 1,
        config: {
          enabled: true,
          rules: [importableRule('old', { headerOverrides: { Cookie: 'session=leak-me' } })],
        },
      },
    ];
    const { sendResponse } = dispatch(MessageType.GET_CONFIG_HISTORY, EXTERNAL_PAGE_URL, undefined);
    await flush();

    expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'Unauthorized sender' });
    expect(JSON.stringify(sendResponse.mock.calls)).not.toContain('leak-me');
  });

  it('非字符串 id 同步拒绝，不开异步通道', () => {
    const { sendResponse, keepChannelOpen } = dispatch(MessageType.RESTORE_CONFIG_HISTORY, TRUSTED_PAGE_URL, {
      id: 42,
    });
    expect(keepChannelOpen).toBe(false);
    expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'Invalid history id' });
  });

  it('可信 sender 回退不存在的 id 时明确失败，配置原样保留', async () => {
    store[STORAGE_KEYS.PROXY_CONFIG] = { enabled: false, rules: [importableRule('current')] };
    store[STORAGE_KEYS.CONFIG_HISTORY] = [];
    const { sendResponse } = dispatch(MessageType.RESTORE_CONFIG_HISTORY, TRUSTED_PAGE_URL, { id: 'nope' });
    await flush();

    expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'HISTORY_ENTRY_NOT_FOUND' });
    expect(store[STORAGE_KEYS.PROXY_CONFIG]).toEqual({ enabled: false, rules: [importableRule('current')] });
  });

  it('外部页面的回退请求在触达存储之前就被拒', async () => {
    store[STORAGE_KEYS.PROXY_CONFIG] = { enabled: false, rules: [importableRule('current')] };
    store[STORAGE_KEYS.CONFIG_HISTORY] = [
      {
        id: 'h1',
        savedAt: 5,
        reason: 'replace-import',
        ruleCount: 1,
        config: { enabled: true, rules: [importableRule('old')] },
      },
    ];
    const { sendResponse } = dispatch(MessageType.RESTORE_CONFIG_HISTORY, EXTERNAL_PAGE_URL, { id: 'h1' });
    await flush();

    expect(lastResponse(sendResponse)).toEqual({ success: false, error: 'Unauthorized sender' });
    expect(store[STORAGE_KEYS.PROXY_CONFIG]).toEqual({ enabled: false, rules: [importableRule('current')] });
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('拦截器自报消息 — 不 gate、不落盘，但会与代发数交叉校验', () => {
  /**
   * 带 `sender.tab` 的派发：`recordInterceptorStats` 认的是 Chrome 写入的 tabId，
   * 而 `dispatch()` 造的 sender 只有 url（那条路径要守的是「没有 tab 就不记录」）。
   * `frameId` 同样由 Chrome 写入，默认 0 = 顶层 frame。
   */
  function dispatchFromTab(type: MessageType, data: unknown, tabId: number, frameId = 0) {
    const sendResponse = vi.fn();
    const keepChannelOpen = listener!(
      { type, data },
      { url: EXTERNAL_PAGE_URL, tab: { id: tabId }, frameId },
      sendResponse,
    );
    return { sendResponse, keepChannelOpen };
  }

  /** 与真实现同一份模块实例（router 已把它拉进注册表），因此读到的是 router 写进去的状态 */
  async function statsMod() {
    return import('@/entrypoints/background/interceptorStats');
  }

  it('页面来源的合法自报被记下，并且能原样读回', async () => {
    const stats = await statsMod();
    const { sendResponse, keepChannelOpen } = dispatchFromTab(
      MessageType.INTERCEPTOR_STATS,
      { intercepted: 3, proxied: 1, fellBack: 1, timedOut: 0 },
      7,
    );
    // 同步应答：这条消息不触发任何异步工作，不该把通道留着
    expect(keepChannelOpen).toBe(false);
    expect(lastResponse(sendResponse)).toEqual({ success: true });
    expect(await stats.getInterceptorStats(7)).toMatchObject({ intercepted: 3, fellBack: 1 });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('非法自报回 { success:false }，且不留下半成品读数', async () => {
    const stats = await statsMod();
    const { sendResponse } = dispatchFromTab(MessageType.INTERCEPTOR_STATS, { intercepted: '9' }, 8);
    expect(lastResponse(sendResponse)).toEqual({ success: false });
    expect(await stats.getInterceptorStats(8)).toBeNull();
  });

  it('同一标签页经 PROXY_REQUEST 建立基准后，低于基准的自报一律不采信', async () => {
    const stats = await statsMod();
    dispatch(MessageType.PROXY_REQUEST, EXTERNAL_PAGE_URL, { requestId: 'r1', url: EXTERNAL_PAGE_URL, method: 'GET' });
    await flush();
    expect(await stats.getInterceptorStats(7)).toBeNull(); // 上面那条 sender 没有 tab，不该建基准

    dispatchFromTab(MessageType.PROXY_REQUEST, { requestId: 'r2', url: EXTERNAL_PAGE_URL, method: 'GET' }, 9);
    await flush();
    const baseline = await stats.getInterceptorStats(9);
    expect(baseline).toMatchObject({ swProxied: 1, updatedAt: 0 }); // 只有基准，还没有可信自报

    const tooSmall = dispatchFromTab(
      MessageType.INTERCEPTOR_STATS,
      { intercepted: 5, proxied: 0, fellBack: 0, timedOut: 0 },
      9,
    );
    expect(lastResponse(tooSmall.sendResponse)).toEqual({ success: false });
    expect(await stats.getInterceptorStats(9)).toMatchObject({ swProxied: 1, updatedAt: 0 });

    const honest = dispatchFromTab(
      MessageType.INTERCEPTOR_STATS,
      { intercepted: 5, proxied: 1, fellBack: 4, timedOut: 0 },
      9,
    );
    expect(lastResponse(honest.sendResponse)).toEqual({ success: true });
    expect(await stats.getInterceptorStats(9)).toMatchObject({ proxied: 1, fellBack: 4, swProxied: 1 });
  });

  it('基准与自报两侧都带着 frameId：iframe 的诚实自报不被顶层的代发数误杀', async () => {
    const stats = await statsMod();
    // 顶层代发 3 笔、iframe 代发 1 笔（requestId 各自从 1 数起，跨 frame 会重名）
    for (let i = 0; i < 3; i++) {
      dispatchFromTab(MessageType.PROXY_REQUEST, { requestId: `r${i}`, url: EXTERNAL_PAGE_URL, method: 'GET' }, 12, 0);
    }
    dispatchFromTab(MessageType.PROXY_REQUEST, { requestId: 'r0', url: EXTERNAL_PAGE_URL, method: 'GET' }, 12, 1);
    await flush();

    const sub = dispatchFromTab(
      MessageType.INTERCEPTOR_STATS,
      { intercepted: 1, proxied: 1, fellBack: 0, timedOut: 0 },
      12,
      1,
    );
    expect(lastResponse(sub.sendResponse)).toEqual({ success: true });
    const top = dispatchFromTab(
      MessageType.INTERCEPTOR_STATS,
      { intercepted: 3, proxied: 3, fellBack: 0, timedOut: 0 },
      12,
      0,
    );
    expect(lastResponse(top.sendResponse)).toEqual({ success: true });
    // popup 读的是整页合账：那一行说的仍是「这一页」，不是某一个 frame
    expect(await stats.getInterceptorStats(12)).toMatchObject({ intercepted: 4, proxied: 4, swProxied: 4 });
  });

  it('popup 读的是内存态，读不到时回 null 而不是 0 命中', async () => {
    const { sendResponse, keepChannelOpen } = dispatch(MessageType.GET_INTERCEPTOR_STATS, TRUSTED_PAGE_URL, {
      tabId: 424242,
    });
    expect(keepChannelOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith(null);
  });

  it('不带 tabId 的读取回 null（不给某个标签页编一个数）', async () => {
    const { sendResponse } = dispatch(MessageType.GET_INTERCEPTOR_STATS, TRUSTED_PAGE_URL, undefined);
    expect(sendResponse).toHaveBeenCalledWith(null);
  });
});

describe('GET_CONFIG_SYNC — 只读一笔送达账，不 gate、不写任何状态', () => {
  /** 与真实现同一份模块实例（router 已经把 `configSyncState` 拉进注册表） */
  async function syncMod() {
    return import('@/entrypoints/background/configSyncState');
  }

  it('记过「没送达」的标签页读回 false，没记过的读回 true', async () => {
    const sync = await syncMod();
    sync.markConfigUnsynced(21);

    const flagged = dispatch(MessageType.GET_CONFIG_SYNC, TRUSTED_PAGE_URL, { tabId: 21 });
    expect(flagged.keepChannelOpen).toBe(false);
    expect(lastResponse(flagged.sendResponse)).toEqual({ synced: false });

    const clean = dispatch(MessageType.GET_CONFIG_SYNC, TRUSTED_PAGE_URL, { tabId: 22 });
    expect(lastResponse(clean.sendResponse)).toEqual({ synced: true });
  });

  it('页面来源的读取照常回答（它是 popup 的证据，不是状态修改）', async () => {
    const sync = await syncMod();
    sync.markConfigUnsynced(23);
    const { sendResponse } = dispatch(MessageType.GET_CONFIG_SYNC, EXTERNAL_PAGE_URL, { tabId: 23 });
    await flush();
    expect(lastResponse(sendResponse)).toEqual({ synced: false });
  });

  it('读取本身不改账：问一百次，那一页仍是「没送达」', async () => {
    const sync = await syncMod();
    sync.markConfigUnsynced(24);
    for (let i = 0; i < 3; i++) dispatch(MessageType.GET_CONFIG_SYNC, TRUSTED_PAGE_URL, { tabId: 24 });
    await flush();
    expect(sync.isConfigUnsynced(24)).toBe(true);
  });

  it('不带 tabId 的读取回 null（不给「当前页面」编一个结论）', async () => {
    const { sendResponse } = dispatch(MessageType.GET_CONFIG_SYNC, TRUSTED_PAGE_URL, undefined);
    expect(sendResponse).toHaveBeenCalledWith(null);
  });
});
