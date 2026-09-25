/**
 * SW 通道命中计数的运行时覆盖（`entrypoints/background/proxyHandler.ts` 的 `swHitStats`）
 *
 * 这一本账有两个读端，都在 options：规则列表「扩展通道」那一格（`App.vue` 把它交给
 * `groupHitStatsByRule` 折成 `{ net, ext }`），以及日志抽屉那份**原样**列表（`:sw-stats` 直接
 * `v-for`，所以这里的降序与 `ruleId` 归并是它画面的顺序与 key）。`locales/<locale>/options.json`
 * 的 `swStatsHint` 对外承诺了它的口径：「配置变更、或服务工作线程被浏览器回收后从 0 重新计数」。
 *
 * 「什么算一次命中」这件事本身也在这里钉：命中判据排在 `blocked` / mock / 重写这些分支**之前**
 * （`proxyHandler.ts:380`），所以被阻断的请求算命中、没匹配到任何规则的不算、总开关关闭时
 * 连规则都不去看所以也不算。
 *
 * 落证在 `.test-tmp/probe-r19.py` / `probe-r19b.py` / `probe-r19c.py`（盲测哪些格无主）与
 * `.test-tmp/mutate-r19.py`（最终表，均不入库）：本文件之前，把读数改成不排序、改成升序、让被阻断
 * 的那一笔不计、让什么都没命中的那一笔也记一笔、把累加写成 `+= 0`、按 `ruleName` 归并、把
 * `resetSwHitStats()` 变成空转、把那句过期挪进守卫里、整句删掉、把 DNR 采样失效那句删掉（这一格是
 * 最终表才补进来的，不在那两支探针的清单里，于是单独把本文件挪走、在 HEAD 上复跑过一次同样全绿）、
 * 让 `GET_SW_STATS` 恒回空数组、把总开关的早退摘掉 —— 这十二处改写在 HEAD（`943dbe4`）的 1597 用例上
 * 一条都不红。加了本文件之后复跑最终表：M1、M2、M4–M13 这十二条每一条都红，且只红在本文件的用例上
 * （累加那处牵动三条——排序格与置零格都依赖它累加）。
 *
 * 夹具自证：探针那批**想当然挑的三条对照全活**（把 `groupHitStatsByRule` 的累加改成覆盖、把
 * `computeLogStats` 的 success 区间从 399 掐到 299、摘掉总开关的早退——在 HEAD 上都不红），说明
 * 「随手挑一条应该红的断言」不能当夹具自检。真正证明这套跑法读得出红的是两条**已知有主人**的改写：
 * `probe-r19c.py` 的 C1（主题写到 `data-color` 上，红 9 条）与最终表的 M14（同一处，仍红 9 条）。
 * 它们红了，上面那十二处的「活」才是无主，而不是测不出。三条假对照里早退那一格本文件顺手收下了；
 * 另外两格（`utils/ruleStats.ts` 里同规则多条读数的累加、`computeLogStats` 的 2xx/3xx 边界）
 * 仍无主人，本轮刻意不扩范围。
 *
 * 刻意没断的一处（最终表的 M3 因此必须活）：`getSwHitStats()` 交出去的是内部对象的**拷贝**
 * （`.map` 那一步）。两个读端都只挑字段看，谁也不改返回项——所以「交出内部引用」在当前代码里是
 * 等价改写，为它写断言只是钉住一个还没有主人的形状。
 *
 * 还有一类断言是**夹具佐证**而不是某格的主人（回包的 `status` / `statusText`、`fetch` 未被调用、
 * 列表长度）：它们的作用是让「这一格红」始终意味着账算错了，而不是那一笔压根没走到对应分支。
 *
 * `entrypoints/background.ts` 的那句 `resetSwHitStats()` 只能按源码契约钉：`defineBackground`
 * 收到函数时只返回 `{ main }`，导入该模块永远不会执行 `main()`，所以监听器压根没注册
 * （全仓也没有任何测试挂载 SW 入口）。给它的是「排在 `if (newConfig?.rules)` 守卫之前」这个
 * 位置关系，而不是行号——守卫之内还是之外是本轮真正的判据：`proxy_config` 被整体清掉时
 * `newValue` 是 `undefined`，写在守卫里就等于「配置都没了，命中数还留着」。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { MessageType } from '@/utils/types';
import type { ProxyRule } from '@/utils/types';

function makeRule(overrides: Partial<ProxyRule>): ProxyRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    matchPattern: 'https://api.example.com/*',
    targetUrl: '',
    matchType: 'wildcard',
    priority: 10,
    // mockResponse 让每一笔都停在 Mock 分支：既保证走 SW 通道（isSimpleRule 因此为 false），
    // 又不需要真发请求，计数与网络层彻底解耦。
    mockResponse: { body: '{"mocked":true}', status: 200 },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const HIT_URL = 'https://api.example.com/users';
const MISS_URL = 'https://other.example.com/users';

type HandlerModule = typeof import('@/entrypoints/background/proxyHandler');

/** 真 onMessage 监听器的形状：注册进来之后由用例直接调用 */
type RouterListener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean | undefined;

describe('swHitStats — SW 通道命中的记账与读数', () => {
  const store: Record<string, unknown> = {};
  const fetchMock = vi.fn();
  let mod: HandlerModule;

  beforeEach(async () => {
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
    vi.stubGlobal(
      'fetch',
      fetchMock.mockImplementation(async () => new Response('real upstream', { status: 200, statusText: 'OK' })),
    );
    // 每个用例一份全新模块图：`swHitStats` 是模块级 Map，resetModules 比跨用例共享更可靠
    vi.resetModules();
    mod = await import('@/entrypoints/background/proxyHandler');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function setConfig(config: unknown) {
    store['proxy_config'] = config;
  }

  async function hit(data: { url: string; method?: string; ruleId?: string }) {
    return mod.handleProxyRequest({
      requestId: 'req-1',
      headers: {},
      url: data.url,
      method: data.method ?? 'GET',
      ruleId: data.ruleId,
    });
  }

  it('同一规则连打三笔，读数累加到 3（不是恒为 1，也不是 +0）', async () => {
    setConfig({ enabled: true, rules: [makeRule({ id: 'a', name: '规则 A' })] });

    await hit({ url: HIT_URL });
    await hit({ url: HIT_URL });
    const resp = await hit({ url: HIT_URL });

    expect(resp.status).toBe(200);
    expect(mod.getSwHitStats()).toEqual([{ ruleId: 'a', ruleName: '规则 A', hitCount: 3 }]);
  });

  it('两条规则同名不同 id 各记各的（归并键是 ruleId，不是 ruleName）', async () => {
    setConfig({
      enabled: true,
      rules: [makeRule({ id: 'a', name: '同名', priority: 1 }), makeRule({ id: 'b', name: '同名', priority: 2 })],
    });

    await hit({ url: HIT_URL });
    await hit({ url: HIT_URL, ruleId: 'b' });

    const stats = mod.getSwHitStats();
    expect(stats).toHaveLength(2);
    expect(stats.map(s => s.ruleId).sort()).toEqual(['a', 'b']);
    expect(stats.every(s => s.hitCount === 1)).toBe(true);
  });

  it('读数按命中数降序，与写入顺序无关', async () => {
    setConfig({
      enabled: true,
      rules: [
        makeRule({ id: 'few', name: '只中一次', priority: 1 }),
        makeRule({ id: 'many', name: '中了三次', priority: 2 }),
      ],
    });

    // 先写少数那条：Map 的插入序是 few → many，「不排序」与「升序」都会把 few 排在前面
    await hit({ url: HIT_URL, ruleId: 'few' });
    await hit({ url: HIT_URL, ruleId: 'many' });
    await hit({ url: HIT_URL, ruleId: 'many' });
    await hit({ url: HIT_URL, ruleId: 'many' });

    expect(mod.getSwHitStats().map(s => [s.ruleId, s.hitCount])).toEqual([
      ['many', 3],
      ['few', 1],
    ]);
  });

  it('被阻断的请求算一次命中（命中判据排在 blocked 分支之前）', async () => {
    setConfig({ enabled: true, rules: [makeRule({ id: 'blk', name: '阻断', blocked: true })] });

    const resp = await hit({ url: HIT_URL });

    expect(resp.statusText).toBe('Blocked');
    expect(mod.getSwHitStats()).toEqual([{ ruleId: 'blk', ruleName: '阻断', hitCount: 1 }]);
  });

  it('没有规则命中时不记账，也不会凭空长出一条', async () => {
    setConfig({ enabled: true, rules: [makeRule({ id: 'a', name: '规则 A' })] });

    const resp = await hit({ url: MISS_URL });

    expect(resp.statusText).toBe('Proxy Bypass');
    expect(mod.getSwHitStats()).toEqual([]);
  });

  it('总开关关闭时直接 Bypass：不匹配规则、不记账、不发请求', async () => {
    setConfig({ enabled: false, rules: [makeRule({ id: 'a', name: '规则 A' })] });

    const resp = await hit({ url: HIT_URL });

    expect(resp.status).toBe(0);
    expect(resp.statusText).toBe('Proxy Bypass');
    expect(resp.body).toBe('Proxy is disabled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mod.getSwHitStats()).toEqual([]);
  });

  it('置零之后再打一笔是从 1 开始，而不是接着上一次的数', async () => {
    setConfig({ enabled: true, rules: [makeRule({ id: 'a', name: '规则 A' })] });

    await hit({ url: HIT_URL });
    await hit({ url: HIT_URL });
    expect(mod.getSwHitStats()).toEqual([{ ruleId: 'a', ruleName: '规则 A', hitCount: 2 }]);

    mod.resetSwHitStats();
    expect(mod.getSwHitStats()).toEqual([]);

    await hit({ url: HIT_URL });
    expect(mod.getSwHitStats()).toEqual([{ ruleId: 'a', ruleName: '规则 A', hitCount: 1 }]);
  });
});

describe('GET_SW_STATS — 读数经真 messageRouter 出到 options', () => {
  const store: Record<string, unknown> = {};
  const SELF_ID = 'abcdefghijklmnopabcdefghijklmnop';
  const OPTIONS_URL = `chrome-extension://${SELF_ID}/options/index.html`;
  let listener: RouterListener | undefined;

  beforeEach(async () => {
    listener = undefined;
    for (const key of Object.keys(store)) delete store[key];
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      runtime: {
        id: SELF_ID,
        getURL: (path?: string) => `chrome-extension://${SELF_ID}/${path ?? ''}`,
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
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
        },
        onChanged: { addListener: vi.fn() },
      },
      declarativeNetRequest: {
        getMatchedRules: vi.fn(async () => ({ rulesMatchedInfo: [] })),
        getDynamicRules: vi.fn(async () => []),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('real upstream', { status: 200 })),
    );
    vi.resetModules();
    const [{ setupMessageRouter }, handler] = await Promise.all([
      import('@/entrypoints/background/messageRouter'),
      import('@/entrypoints/background/proxyHandler'),
    ]);
    setupMessageRouter();
    // messageRouter 与这里拿到的 handler 必须是同一份模块实例：账记进去了却读不回来，
    // 说明 `vi.resetModules()` 把两张图分开了，下面的回包断言就成了空话。
    store['proxy_config'] = { enabled: true, rules: [makeRule({ id: 'a', name: '规则 A' })] };
    await handler.handleProxyRequest({ requestId: 'req-1', headers: {}, url: HIT_URL, method: 'GET' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('回包是刚记下的那本账，不是空数组', () => {
    const sendResponse = vi.fn();
    listener!({ type: MessageType.GET_SW_STATS, data: undefined }, { url: OPTIONS_URL }, sendResponse);

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0][0]).toEqual([{ ruleId: 'a', ruleName: '规则 A', hitCount: 1 }]);
  });
});

describe('配置变更即作废两份读数（源码契约）', () => {
  const src = fs.readFileSync('entrypoints/background.ts', 'utf-8');

  it('resetSwHitStats 与 invalidateDnrSample 排在 `newConfig?.rules` 守卫之前', () => {
    const start = src.indexOf('chrome.storage.onChanged.addListener');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);

    const reset = body.indexOf('resetSwHitStats()');
    const sample = body.indexOf("invalidateDnrSample('config-changed')");
    const guard = body.indexOf('if (newConfig?.rules)');

    expect(reset).toBeGreaterThan(-1);
    expect(sample).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    // 键被整体清掉时 newValue 是 undefined，守卫之内的那半边压根不执行：
    // 关代理之后 popup 还能看到历史命中，就是这么留下来的。
    expect(reset).toBeLessThan(guard);
    expect(sample).toBeLessThan(guard);
  });
});
