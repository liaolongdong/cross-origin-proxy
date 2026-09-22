/**
 * dnrManager 的同步路径：一条非法规则绝不能连坐整批
 *
 * `updateDynamicRules` 是**整批**语义——规则集里任何一条非法（RE2 不接受的正则、捕获引用越界的
 * 替换串、越界的 DNR 优先级），Chrome 拒掉的是这一整次调用。优先级那条已由 `toDnrPriority` 两端
 * 钳制，正则与替换串这两条靠同步前逐条筛（`filterDnrApplicableRules`）：一批好规则里混一条坏的
 * 后果不是坏的那条不生效，而是**这批全都不生效**，而界面上它们个个写着「已启用」。
 * 筛的口径与界面告警必须同源，那一点由 `dnrSupport.test.ts` 守住。
 *
 * 本文件钉的是同一条路径上其余四件事：
 * 1. **总开关关闭 = 编译出空规则集，但旧规则要撤**：DNR 不经扩展 JS，SW 侧的开关判断拦不住它；
 * 2. **全量重建之后，命中统计的两份账跟着规则集走**：id 映射换掉、采样缓存丢掉（否则「这条命中
 *    3 次」说的其实是上一条规则）；写入被拒时反过来——Chrome 侧规则集没变，两份账一动不动；
 * 3. **同步路径不抛**：三个调用点都指望不上兜底——`initDnrManager` 里是 `void syncDnrRules(...)`，
 *    `background.ts` 的 `onInstalled` 是裸 `await`，两处抛出去都是没人接的 rejection；
 *    `initialSync` 自己有 catch，但那只是把失败降成一行 error；
 * 4. **「读旧规则 → 写入」串行**：这个窗口非原子，并发会算出同一批 ID，整批被拒。
 *
 * 外加配置变更监听器的入站闸门现状：只有「规则数组合法」的变更才重新同步并广播，改成非数组或整个
 * 键被删掉都不动（上一份重定向继续生效）。这与第 3 条里启动那一次「非数组按空集重建」是**两种**
 * 行为——同一个坏输入，SW 重启前后网络层结果不同。统一任一侧都是改行为，本文件只把现状钉住。
 *
 * 全部走真实模块（`dnrRules`/`dnrSupport`/`urlMatcher`/`dnrStats`/`dnrSampler`），只有
 * `utils/storage` 与 `utils/logger` 打桩：前者是为了把启动同步的配置来源握在手里，后者是因为
 * 这两条路径失败时唯一的出口就是日志。注意界面上那条「未生效」标记不来自这里——它由 options 侧
 * 的 `useDnrSupport` 调 `findDnrSkippedRules` 算出来，两边同源的关系在 `dnrSupport.test.ts`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DNR_RULE_ID_PREFIX, STORAGE_KEYS } from '@/utils/constants';
import { MessageType } from '@/utils/types';
import type { ProxyConfig, ProxyRule } from '@/utils/types';

type StatsMod = typeof import('@/entrypoints/background/dnrStats');
type SamplerMod = typeof import('@/entrypoints/background/dnrSampler');
type MatchedRuleInfo = chrome.declarativeNetRequest.MatchedRuleInfo;
type StorageListener = Parameters<typeof chrome.storage.onChanged.addListener>[0];

const getProxyConfig = vi.fn();
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock('@/utils/storage', () => ({ getProxyConfig: (args: unknown) => getProxyConfig(args) }));
vi.mock('@/utils/logger', () => ({ logger }));

let getDynamicRules: ReturnType<typeof vi.fn>;
let updateDynamicRules: ReturnType<typeof vi.fn>;
let isRegexSupported: ReturnType<typeof vi.fn>;
let getMatchedRules: ReturnType<typeof vi.fn>;

/** 事件序列：测串行化时看的是「读」与「写」是否交叠 */
let events: string[];

/** `initDnrManager` 注册的配置监听器 */
let storageListeners: StorageListener[];

/** 广播的落点：只放一个已加载完的 http 页，够观察「有没有推、推了什么」 */
let tabs: Array<{ id: number; url: string; status: string }>;
let sendMessage: ReturnType<typeof vi.fn>;

let syncDnrRules: (config: ProxyConfig) => Promise<void>;
let initDnrManager: () => void;
let sampleAggregate: SamplerMod['sampleAggregate'];
let aggregateMatchedInfo: StatsMod['aggregateMatchedInfo'];
let setDnrRuleIdMap: StatsMod['setDnrRuleIdMap'];

function simpleRule(overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id: 'r-good',
    name: 'good',
    enabled: true,
    matchType: 'wildcard',
    matchPattern: 'https://fat-api.example.com/*',
    targetUrl: 'https://uat-api.example.com',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 一条 RE2 不接受的简单规则（JS 环视语法） */
const re2Unsupported = (): ProxyRule =>
  simpleRule({ id: 'r-re2', name: 're2bad', matchType: 'regex', matchPattern: 'https://fat/(a)(?=b)' });

/** 一条 RE2 接受、但替换串引用了不存在的捕获组的简单规则 */
const substitutionInvalid = (): ProxyRule =>
  simpleRule({
    id: 'r-sub',
    name: 'subbad',
    matchType: 'regex',
    matchPattern: '^https://fat/(.*)$',
    targetUrl: 'https://uat$2',
  });

/** 复杂规则（带请求头覆盖）：不属于 DNR 候选，既不该写进去，也不该为它查一次 RE2 */
const complexRule = (): ProxyRule => simpleRule({ id: 'r-complex', name: 'complex', headerOverrides: { 'x-a': 'b' } });

const configOf = (rules: ProxyRule[], enabled = true): ProxyConfig => ({ enabled, rules });

const hitOf = (ruleId: number): MatchedRuleInfo => ({
  rule: { ruleId, rulesetId: '_dynamic' },
  tabId: 1,
  timeStamp: 0,
});

/** 悬浮的 `void initialSync()` 没有可等的句柄，用宏任务把它跑完 */
const drain = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

async function waitUntil(done: () => boolean, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds && !done(); i++) await drain();
}

beforeEach(async () => {
  events = [];
  storageListeners = [];
  tabs = [{ id: 1, url: 'https://fat.example.com/app', status: 'complete' }];
  sendMessage = vi.fn(async () => ({ received: true }));
  getProxyConfig.mockReset();
  Object.values(logger).forEach(fn => fn.mockReset());
  getDynamicRules = vi.fn(async () => {
    events.push('read');
    return [{ id: DNR_RULE_ID_PREFIX }, { id: DNR_RULE_ID_PREFIX + 1 }];
  });
  updateDynamicRules = vi.fn(async () => {
    events.push('write');
  });
  isRegexSupported = vi.fn(async ({ regex }: { regex: string }) => ({ isSupported: !regex.includes('?=') }));
  getMatchedRules = vi.fn(async () => ({ rulesMatchedInfo: [hitOf(DNR_RULE_ID_PREFIX)] }));

  getProxyConfig.mockResolvedValue(configOf([simpleRule()]));

  vi.resetModules();
  vi.stubGlobal('chrome', {
    declarativeNetRequest: { getDynamicRules, updateDynamicRules, isRegexSupported, getMatchedRules },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn((fn: StorageListener) => storageListeners.push(fn)) },
    },
    tabs: {
      query: vi.fn(async () => tabs),
      sendMessage,
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    runtime: { getURL: vi.fn(() => 'chrome-extension://test/') },
  });

  const dnr = await import('@/entrypoints/background/dnrManager');
  syncDnrRules = dnr.syncDnrRules;
  initDnrManager = dnr.initDnrManager;
  sampleAggregate = (await import('@/entrypoints/background/dnrSampler')).sampleAggregate;
  const stats = await import('@/entrypoints/background/dnrStats');
  aggregateMatchedInfo = stats.aggregateMatchedInfo;
  setDnrRuleIdMap = stats.setDnrRuleIdMap;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 本次 `updateDynamicRules` 真正写进去的规则 */
function writtenRules(): chrome.declarativeNetRequest.Rule[] {
  expect(updateDynamicRules).toHaveBeenCalledTimes(1);
  return updateDynamicRules.mock.calls[0][0].addRules;
}

/** 本次 `updateDynamicRules` 的完整载荷 */
function writtenPayload(): { removeRuleIds: number[]; addRules: chrome.declarativeNetRequest.Rule[] } {
  expect(updateDynamicRules).toHaveBeenCalledTimes(1);
  return updateDynamicRules.mock.calls[0][0];
}

describe('一条非法规则只丢它自己', () => {
  it('RE2 不兼容的正则被跳过，同批其它简单规则照常写入', async () => {
    await syncDnrRules(configOf([simpleRule(), re2Unsupported()]));

    const added = writtenRules();
    expect(added).toHaveLength(1);
    expect(added[0].condition.regexFilter).toBe('^https://fat-api\\.example\\.com/(.*)$');
    // 跳过要留下点名规则名的日志：否则用户在界面上只剩一条「已启用」却零作用的规则
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('re2bad'), expect.anything());
  });

  it('捕获引用越界的替换串同样只丢那一条', async () => {
    await syncDnrRules(configOf([simpleRule(), substitutionInvalid()]));

    const added = writtenRules();
    expect(added).toHaveLength(1);
    expect(added[0].id).toBe(DNR_RULE_ID_PREFIX);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('subbad'), expect.anything());
  });

  it('全部被跳过时写入空集，但仍然把旧规则撤掉', async () => {
    await syncDnrRules(configOf([re2Unsupported(), substitutionInvalid()]));

    expect(writtenPayload()).toEqual({
      removeRuleIds: [DNR_RULE_ID_PREFIX, DNR_RULE_ID_PREFIX + 1],
      addRules: [],
    });
  });

  it('复杂规则不进 DNR，也不为它查一次 RE2（它由 SW 通道执行，本来就没坏）', async () => {
    await syncDnrRules(configOf([complexRule(), simpleRule()]));

    expect(writtenRules()).toHaveLength(1);
    // 这一句是双层保险的口径：`filterDnrApplicableRules` 与 `checkDnrRule` 用同一个
    // `usesDnrChannel` 早退，删掉任一层它都仍然成立——所以别把这条当成「RE2 查询有闸门」的证据，
    // 它守的是「别为不参与 DNR 的规则白打 API」这个结果，不是某一层实现。
    expect(isRegexSupported).not.toHaveBeenCalled();
  });
});

describe('总开关与命中统计的两份账', () => {
  it('关闭代理：写入空规则集，且把旧的动态规则撤干净', async () => {
    await syncDnrRules(configOf([simpleRule()], false));

    expect(writtenPayload()).toEqual({
      removeRuleIds: [DNR_RULE_ID_PREFIX, DNR_RULE_ID_PREFIX + 1],
      addRules: [],
    });
  });

  it('同步成功后 id 映射换成这一批规则，命中明细归属得到具体规则', async () => {
    await syncDnrRules(configOf([simpleRule()]));

    expect(aggregateMatchedInfo([hitOf(DNR_RULE_ID_PREFIX)])).toEqual([
      { ruleId: 'r-good', ruleName: 'good', hitCount: 1 },
    ]);
  });

  it('开关关闭后映射是空的：历史命中回落成「#<DNR id>」，不冒充某条规则在工作', async () => {
    setDnrRuleIdMap(new Map([[DNR_RULE_ID_PREFIX, { ruleId: 'r-good', ruleName: 'good' }]]));

    await syncDnrRules(configOf([simpleRule()], false));

    expect(aggregateMatchedInfo([hitOf(DNR_RULE_ID_PREFIX)])).toEqual([
      { ruleId: String(DNR_RULE_ID_PREFIX), ruleName: `#${DNR_RULE_ID_PREFIX}`, hitCount: 1 },
    ]);
  });

  it('同步成功后丢掉采样缓存：下一次读端重新打 API，而不是拿旧窗口冒充新规则集', async () => {
    // 判据是「打了第二次 API」：缓存 TTL 60s（`DNR_AGGREGATE_TTL_MS`），同一个用例里两次读
    // 必然落在 TTL 内，所以没丢缓存就只会有一次调用。
    await sampleAggregate();
    expect(getMatchedRules).toHaveBeenCalledTimes(1);

    await syncDnrRules(configOf([simpleRule()]));
    await sampleAggregate();

    expect(getMatchedRules).toHaveBeenCalledTimes(2);
  });

  it('写入被拒时两份账都不动：Chrome 侧规则集还是原来那份', async () => {
    updateDynamicRules.mockRejectedValue(new Error('Rule ID 10000 is already in use'));
    setDnrRuleIdMap(new Map([[DNR_RULE_ID_PREFIX, { ruleId: 'r-old', ruleName: 'old' }]]));
    const primed = await sampleAggregate();
    expect(getMatchedRules).toHaveBeenCalledTimes(1);

    await syncDnrRules(configOf([simpleRule()]));
    const after = await sampleAggregate();

    // 账本没被换掉：命中仍归属到播种的那条规则（映射若提前写了，这里就是 r-good）
    expect(aggregateMatchedInfo([hitOf(DNR_RULE_ID_PREFIX)])).toEqual([
      { ruleId: 'r-old', ruleName: 'old', hitCount: 1 },
    ]);
    // 读到的还是同一份缓存（`sampledAt` 相同、没打第二次 API）——规则集没变，旧窗口仍然成立
    expect(after.sampledAt).toBe(primed.sampledAt);
    expect(getMatchedRules).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to sync DNR rules'), expect.anything());
  });
});

describe('同步路径不抛异常', () => {
  it('读旧动态规则就失败：只留一行 error，不把异常抛给没有接手人的监听器', async () => {
    getDynamicRules.mockRejectedValue(new Error('DNR unavailable'));

    await expect(syncDnrRules(configOf([simpleRule()]))).resolves.toBeUndefined();

    expect(updateDynamicRules).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to sync DNR rules'), expect.anything());
  });

  it('存储里的规则不是数组：启动同步按空集重建（网络层重定向全撤），而不是半途抛掉', async () => {
    // 这一条与 `initDnrManager` 的监听器是**两种**行为，别读成一种：监听器要求
    // `Array.isArray(newConfig.rules)` 才同步，所以「改配置改成非数组」时 DNR 保持上一份好规则；
    // 而启动这条路把非数组当空集，重定向全撤。同一个坏输入，刷新前后结果不同——已记为待确认点。
    getProxyConfig.mockResolvedValue({ enabled: true, rules: { 0: simpleRule(), length: 1 } });

    initDnrManager();
    await waitUntil(() => updateDynamicRules.mock.calls.length > 0);

    expect(writtenPayload()).toEqual({
      removeRuleIds: [DNR_RULE_ID_PREFIX, DNR_RULE_ID_PREFIX + 1],
      addRules: [],
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('启动时按存储里的配置建一次规则', async () => {
    initDnrManager();
    await waitUntil(() => updateDynamicRules.mock.calls.length > 0);

    expect(writtenRules()).toHaveLength(1);
  });
});

describe('配置变更监听器：什么才值得重新同步与广播', () => {
  /** 跑完启动那一次同步，只留监听器触发的次数可观察 */
  async function started(): Promise<void> {
    initDnrManager();
    await waitUntil(() => updateDynamicRules.mock.calls.length > 0);
  }

  function fire(newValue: unknown): void {
    storageListeners.forEach(fn => fn({ [STORAGE_KEYS.PROXY_CONFIG]: { oldValue: undefined, newValue } }, 'local'));
  }

  it('规则数组合法：重新同步一次', async () => {
    await started();

    fire(configOf([complexRule()]));
    await waitUntil(() => updateDynamicRules.mock.calls.length > 1);

    expect(updateDynamicRules).toHaveBeenCalledTimes(2);
    expect(updateDynamicRules.mock.calls[1][0].addRules).toEqual([]);
  });

  it('合法变更同时把配置推给已加载完的页面，且只推这一页用得上的复杂规则', async () => {
    await started();

    fire(configOf([simpleRule(), complexRule()]));
    await waitUntil(() => sendMessage.mock.calls.length > 0);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [tabId, message] = sendMessage.mock.calls[0];
    expect(tabId).toBe(1);
    expect(message.type).toBe(MessageType.UPDATE_PROXY_CONFIG);
    expect((message.data.rules as ProxyRule[]).map((r: ProxyRule) => r.id)).toEqual(['r-complex']);
  });

  it('启动那一次只同步 DNR、不广播：新文档自己会去拉配置', async () => {
    await started();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  // 监听器还顺带调了 `invalidateMatcherCache()`——那是 URL 匹配的正则缓存，
  // 从外面看不出区别（本文件没有可观察的命中路径），刻意不在这里假装有覆盖。
  it('规则被改成非数组：整条不同步，DNR 保持上一份规则集', async () => {
    // 与启动那条路相反（启动是「按空集重建」）——同一个坏输入，刷新前后结果不同。
    // 现状如此，两种统一法都会改行为，已作为待确认点交付。
    await started();

    fire({ enabled: true, rules: 'nope' });
    await drain();

    expect(updateDynamicRules).toHaveBeenCalledTimes(1);
  });

  it('`proxy_config` 被整体删掉（newValue 是 undefined）：同样不同步，旧的重定向继续生效', async () => {
    await started();

    fire(undefined);
    await drain();

    expect(updateDynamicRules).toHaveBeenCalledTimes(1);
  });

  it('不是 `local` 区域、或变更里没有 `proxy_config`：不触发同步', async () => {
    await started();

    storageListeners.forEach(fn => fn({ some_other_key: { newValue: configOf([simpleRule()]) } }, 'local'));
    storageListeners.forEach(fn => fn({ [STORAGE_KEYS.PROXY_CONFIG]: { newValue: configOf([simpleRule()]) } }, 'sync'));
    await drain();

    expect(updateDynamicRules).toHaveBeenCalledTimes(1);
  });
});

describe('读旧规则与写入之间串行', () => {
  it('两次同步不交叠：后一次的「读」必须等前一次「写」落定', async () => {
    await Promise.all([syncDnrRules(configOf([simpleRule()])), syncDnrRules(configOf([complexRule()]))]);

    // 交叠就是两个「读 → 写」窗口同时跑，两边算出同一批 ID，整批被 Chrome 拒掉
    expect(events).toEqual(['read', 'write', 'read', 'write']);
  });

  it('三连发也按序执行，不并发写', async () => {
    await Promise.all([
      syncDnrRules(configOf([simpleRule()])),
      syncDnrRules(configOf([simpleRule({ id: 'r2' })])),
      syncDnrRules(configOf([re2Unsupported()])),
    ]);

    expect(events).toEqual(['read', 'write', 'read', 'write', 'read', 'write']);
    expect(updateDynamicRules.mock.calls[2][0].addRules).toEqual([]);
  });
});
