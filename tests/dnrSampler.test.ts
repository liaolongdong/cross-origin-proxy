/**
 * DNR 命中采样器：缓存新鲜度、配额滑窗、失败退避、失效与按标签页隔离
 *
 * `getMatchedRules` 是「20 次 / 10 分钟」的稀缺资源，且窗口只有 5 分钟，
 * 所以采样策略（谁能读缓存、谁必须打 API）是这个批次唯一真正的资源管理者。
 * 这里用假时钟逐个钉死判定顺序——顺序错一位，配额就会被白吃或读端拿到过期值却显示正常。
 *
 * 模块状态是模块级的，每个用例都 `vi.resetModules()` 重新取一份，避免上一个用例的缓存
 * 冒充本用例的新鲜缓存。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DNR_AGGREGATE_TTL_MS,
  DNR_QUOTA_WINDOW_MS,
  DNR_SAMPLE_CALL_BUDGET,
  DNR_TAB_CACHE_SIZE,
  DNR_TAB_TTL_MS,
} from '@/utils/constants';

type MatchedRuleInfo = chrome.declarativeNetRequest.MatchedRuleInfo;
type SamplerModule = typeof import('@/entrypoints/background/dnrSampler');

let getMatchedRules: ReturnType<typeof vi.fn>;
let getDynamicRules: ReturnType<typeof vi.fn>;
let sampleAggregate: SamplerModule['sampleAggregate'];
let sampleForTab: SamplerModule['sampleForTab'];
let invalidateDnrSample: SamplerModule['invalidateDnrSample'];

const START = new Date(2026, 8, 19, 12, 0, 0).getTime();

function hit(ruleId: number, tabId = -1): MatchedRuleInfo {
  return { rule: { ruleId, rulesetId: '_dynamic' }, tabId, timeStamp: Date.now() };
}

/**
 * 默认桩：动态规则集非空 + 三次命中（10001×2 + 10002×1）。
 *
 * 刻意用 `mockResolvedValue` 而不是 `Once`：`hasActiveDnrRules()` 每次采样都会读一次
 * `getDynamicRules`，用 `Once` 会在第二次调用时耗尽、返回 `undefined` 并抛 TypeError，
 * 测试就变成了在走「API 异常」分支却声称在测正常路径。需要不同返回值的用例自行
 * `mockResolvedValueOnce`（Once 队列优先于默认值）。
 */
function stubHappyPath(): void {
  getDynamicRules.mockResolvedValue([{ id: 10001 }, { id: 10002 }]);
  getMatchedRules.mockResolvedValue({ rulesMatchedInfo: [hit(10001), hit(10001), hit(10002)] });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  getMatchedRules = vi.fn();
  getDynamicRules = vi.fn();
  vi.stubGlobal('chrome', {
    declarativeNetRequest: { getMatchedRules, getDynamicRules },
  });

  vi.resetModules();
  const mod = await import('@/entrypoints/background/dnrSampler');
  sampleAggregate = mod.sampleAggregate;
  sampleForTab = mod.sampleForTab;
  invalidateDnrSample = mod.invalidateDnrSample;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 把时钟推到「缓存一定过期」之后 */
function advancePastTtl(): void {
  vi.setSystemTime(START + Math.max(DNR_AGGREGATE_TTL_MS, DNR_TAB_TTL_MS) + 1_000);
}

describe('新鲜度', () => {
  it('TTL 内重复读只调用一次 API', async () => {
    stubHappyPath();
    const first = await sampleAggregate();
    const second = await sampleAggregate();

    expect(getMatchedRules).toHaveBeenCalledTimes(1);
    expect(first.stale).toBe(false);
    expect(second.stale).toBe(false);
    expect(second.stats).toEqual(first.stats);
  });

  it('聚合缓存与按标签页缓存互不共享（同一份数据不会串用 tabId 语义）', async () => {
    stubHappyPath();
    await sampleAggregate();
    await sampleForTab(7);
    expect(getMatchedRules).toHaveBeenCalledTimes(2);
    expect(getMatchedRules.mock.calls[1][0]).toEqual({ tabId: 7 });
  });
});

describe('失败退避', () => {
  it('API 抛错时返回旧值并标记 stale，退避窗口内不再调用', async () => {
    stubHappyPath();
    const good = await sampleAggregate();

    advancePastTtl();
    getMatchedRules.mockRejectedValueOnce(new Error('Quota exceeded'));
    const failed = await sampleAggregate();

    expect(failed.stale).toBe(true);
    expect(failed.sampledAt).toBe(good.sampledAt);
    expect(failed.stats).toEqual(good.stats);

    const callsAfterFailure = getMatchedRules.mock.calls.length;
    await sampleAggregate();
    expect(getMatchedRules).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it('退避结束后重新采样', async () => {
    stubHappyPath();
    await sampleAggregate();

    advancePastTtl();
    getMatchedRules.mockRejectedValueOnce(new Error('Quota exceeded'));
    await sampleAggregate();

    // 越过 backoffUntil = (START + 61s) + 60s
    vi.setSystemTime(START + DNR_AGGREGATE_TTL_MS * 2 + 2_000);
    getMatchedRules.mockResolvedValueOnce({ rulesMatchedInfo: [hit(10001)] });
    const after = await sampleAggregate();

    expect(after.stale).toBe(false);
    expect(after.stats).toHaveLength(1);
  });
});

describe('配额滑窗', () => {
  /**
   * 每次都先 `invalidateDnrSample()` 再读：绕开 TTL，逼出一次真正的 API 调用。
   *
   * 不要用「推进时钟 > TTL」来凑次数——聚合 TTL 是 61 秒，18 次就要 18 分钟，
   * 滑窗会随之滚走，测出来的「被挡」根本不是配额造成的。时间在同一个瞬间累计，
   * 才能把「窗口内满 18 次」这件事单独钉住。
   */
  async function spendOneCall() {
    invalidateDnrSample('config-changed');
    return sampleAggregate();
  }

  it('滑窗内满 18 次后不再调用 API，返回 stale', async () => {
    stubHappyPath();
    for (let i = 0; i < DNR_SAMPLE_CALL_BUDGET; i++) await spendOneCall();
    expect(getMatchedRules).toHaveBeenCalledTimes(DNR_SAMPLE_CALL_BUDGET);

    const blocked = await spendOneCall();
    expect(getMatchedRules).toHaveBeenCalledTimes(DNR_SAMPLE_CALL_BUDGET);
    expect(blocked.stale).toBe(true);
  });

  it('滑窗滚动后重新放行', async () => {
    stubHappyPath();
    for (let i = 0; i < DNR_SAMPLE_CALL_BUDGET; i++) await spendOneCall();

    // 仍在同一 10 分钟窗口内：第 19 次被挡
    await spendOneCall();
    expect(getMatchedRules).toHaveBeenCalledTimes(DNR_SAMPLE_CALL_BUDGET);

    vi.setSystemTime(START + DNR_QUOTA_WINDOW_MS + 1_000);
    await spendOneCall();
    expect(getMatchedRules).toHaveBeenCalledTimes(DNR_SAMPLE_CALL_BUDGET + 1);
  });
});

describe('短路：没有生效的动态规则就不该吃配额', () => {
  it('动态规则集为空时零次 getMatchedRules，且 sampledAt 保持 0', async () => {
    getDynamicRules.mockResolvedValue([]);
    const result = await sampleAggregate();

    expect(getDynamicRules).toHaveBeenCalledTimes(1);
    expect(getMatchedRules).not.toHaveBeenCalled();
    expect(result.stats).toEqual([]);
    expect(result.sampledAt).toBe(0);
    expect(result.stale).toBe(false);
  });

  it('总开关关闭会清空动态规则集，因此关闭态同样短路为「不知道」而不是 0', async () => {
    getDynamicRules.mockResolvedValue([]);
    const result = await sampleForTab(3);
    expect(result.sampledAt).toBe(0);
    expect(result.tabId).toBe(3);
  });
});

describe('失效', () => {
  it('invalidateDnrSample 后立刻重新采样，不被旧缓存冒充', async () => {
    stubHappyPath();
    const first = await sampleAggregate();

    invalidateDnrSample('config-changed');
    // fake timers 不会自己走，不推时钟则两次 sampledAt 相同，断言就失去意义
    vi.setSystemTime(START + 1_000);
    getMatchedRules.mockResolvedValueOnce({ rulesMatchedInfo: [hit(10001)] });
    const second = await sampleAggregate();

    expect(getMatchedRules).toHaveBeenCalledTimes(2);
    expect(second.sampledAt).not.toBe(first.sampledAt);
    expect(second.stats).toHaveLength(1);
  });

  it('按标签页的缓存同样被清空', async () => {
    stubHappyPath();
    await sampleForTab(7);
    invalidateDnrSample('dnr-synced');
    await sampleForTab(7);
    expect(getMatchedRules).toHaveBeenCalledTimes(2);
  });
});

describe('按标签页', () => {
  it('不同 tabId 各自独立缓存', async () => {
    stubHappyPath();
    await sampleForTab(7);
    getMatchedRules.mockResolvedValueOnce({ rulesMatchedInfo: [] });
    await sampleForTab(8);

    expect(getMatchedRules).toHaveBeenCalledTimes(2);
    expect(getMatchedRules.mock.calls[1][0]).toEqual({ tabId: 8 });

    // tab 7 仍在自己的 TTL 内 → 不再调用
    await sampleForTab(7);
    expect(getMatchedRules).toHaveBeenCalledTimes(2);
  });

  it(`超过 ${DNR_TAB_CACHE_SIZE} 个 tabId 时丢弃最旧，缓存不会无界增长`, async () => {
    stubHappyPath();
    const total = DNR_TAB_CACHE_SIZE + 1;
    for (let tabId = 1; tabId <= total; tabId++) await sampleForTab(tabId);
    expect(getMatchedRules).toHaveBeenCalledTimes(total);

    // 最旧的 tab 1 已被逐出 → 再读必须重新采样
    await sampleForTab(1);
    expect(getMatchedRules).toHaveBeenCalledTimes(total + 1);

    // 最新的仍在缓存里 → 不产生新调用
    await sampleForTab(total);
    expect(getMatchedRules).toHaveBeenCalledTimes(total + 1);
  });
});
