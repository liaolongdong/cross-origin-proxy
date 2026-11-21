import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_RULES, MAX_LOG_ENTRIES, MAX_CONFIG_HISTORY, STORAGE_KEYS } from '@/utils/constants';

// 内存版 chrome.storage mock（照 tests/importPlan.test.ts 的样板）。
// onChanged 的 listener 被捕获进数组，用例里手动触发，模拟「设置页写入后其它上下文缓存失效」。
let store: Record<string, unknown> = {};
let changeListeners: ((changes: Record<string, { newValue?: unknown }>) => void)[] = [];
let getSpiCount = 0;

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async () => {
        getSpiCount++;
        return store;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, JSON.parse(JSON.stringify(items)));
      }),
    },
    onChanged: {
      addListener: vi.fn((fn: (changes: Record<string, { newValue?: unknown }>) => void) => {
        changeListeners.push(fn);
      }),
    },
  },
  runtime: { sendMessage: vi.fn() },
});

// limits.ts 持模块级缓存，每个用例重置模块再取一份新实例
let limits: typeof import('@/utils/limits') = undefined as unknown as typeof import('@/utils/limits');

beforeEach(async () => {
  vi.resetModules();
  store = {};
  changeListeners = [];
  getSpiCount = 0;
  limits = await import('@/utils/limits');
});

describe('sanitizeCapacityLimits（纯函数：任意输入 → 合法上限）', () => {
  it('整份缺省时逐位回退 constants 的 MAX_*（与「用户从没改过」逐位相同）', () => {
    expect(limits.sanitizeCapacityLimits(undefined)).toEqual({
      maxRules: MAX_RULES,
      maxLogEntries: MAX_LOG_ENTRIES,
      maxConfigHistory: MAX_CONFIG_HISTORY,
    });
    expect(limits.sanitizeCapacityLimits(null)).toEqual(limits.sanitizeCapacityLimits(undefined));
    expect(limits.sanitizeCapacityLimits('oops')).toEqual(limits.sanitizeCapacityLimits(undefined));
    expect(limits.sanitizeCapacityLimits({})).toEqual(limits.sanitizeCapacityLimits(undefined));
  });

  it('字段越界时收进合法区间（上下两界都收）', () => {
    const clamped = limits.sanitizeCapacityLimits({
      maxRules: 99999,
      maxLogEntries: 1,
      maxConfigHistory: 100,
    });
    expect(clamped.maxRules).toBe(limits.LIMIT_BOUNDS.maxRules.max);
    expect(clamped.maxLogEntries).toBe(limits.LIMIT_BOUNDS.maxLogEntries.min);
    expect(clamped.maxConfigHistory).toBe(limits.LIMIT_BOUNDS.maxConfigHistory.max);
  });

  it('非数与小数字段按字段各自处理，不拖垮整份', () => {
    expect(limits.sanitizeCapacityLimits({ maxRules: 'abc' }).maxRules).toBe(MAX_RULES);
    expect(limits.sanitizeCapacityLimits({ maxRules: '250' }).maxRules).toBe(250);
    // 小数取整：上限是条数，250.7 条没有意义
    expect(limits.sanitizeCapacityLimits({ maxRules: 250.7 }).maxRules).toBe(251);
    expect(limits.sanitizeCapacityLimits({ maxLogEntries: Number.NaN }).maxLogEntries).toBe(MAX_LOG_ENTRIES);
  });
});

describe('readCapacityLimits（读取热路径：缓存与回退）', () => {
  it('storage 里没有这一键时回退默认值', async () => {
    const result = await limits.readCapacityLimits();
    expect(result).toEqual({
      maxRules: MAX_RULES,
      maxLogEntries: MAX_LOG_ENTRIES,
      maxConfigHistory: MAX_CONFIG_HISTORY,
    });
  });

  it('命中缓存时不再回 storage（第二次读取零 get 调用）', async () => {
    await limits.readCapacityLimits();
    const countAfterFirst = getSpiCount;
    await limits.readCapacityLimits();
    expect(getSpiCount).toBe(countAfterFirst);
  });

  it('onChanged 广播这一键后缓存作废，下一次读取拿到新值', async () => {
    store[STORAGE_KEYS.CAPACITY_LIMITS] = { maxRules: 300 };
    expect((await limits.readCapacityLimits()).maxRules).toBe(300);

    // 「设置页写入」：storage 内容换新 + onChanged 广播（本上下文没有写入，只收到广播）
    store[STORAGE_KEYS.CAPACITY_LIMITS] = { maxRules: 400 };
    changeListeners.forEach(fn =>
      fn({ [STORAGE_KEYS.CAPACITY_LIMITS]: { newValue: store[STORAGE_KEYS.CAPACITY_LIMITS] } }),
    );
    expect((await limits.readCapacityLimits()).maxRules).toBe(400);
  });

  it('onChanged 广播别的键不动这一份缓存', async () => {
    await limits.readCapacityLimits();
    const countAfterFirst = getSpiCount;
    changeListeners.forEach(fn => fn({ some_other_key: { newValue: 1 } }));
    await limits.readCapacityLimits();
    expect(getSpiCount).toBe(countAfterFirst);
  });

  it('storage 读取抛错时回退默认值且不抛（上限这件事宁可保守，不让写入整条失败）', async () => {
    const localGet = vi.mocked(chrome.storage.local.get);
    localGet.mockRejectedValueOnce(new Error('SW 回收期'));
    const result = await limits.readCapacityLimits();
    expect(result).toEqual(limits.DEFAULT_CAPACITY_LIMITS);
  });
});

describe('writeCapacityLimits（写入口：与手改 storage 到达同一形状）', () => {
  it('写入成功返回 true，后续读取（含本上下文缓存）拿到新值', async () => {
    const ok = await limits.writeCapacityLimits({ maxRules: 300, maxLogEntries: 800, maxConfigHistory: 8 });
    expect(ok).toBe(true);
    expect(store[STORAGE_KEYS.CAPACITY_LIMITS]).toEqual({ maxRules: 300, maxLogEntries: 800, maxConfigHistory: 8 });
    const after = await limits.readCapacityLimits();
    expect(after.maxRules).toBe(300);
  });

  it('写入的内容同样过 sanitize：越界值落盘前先收进区间', async () => {
    await limits.writeCapacityLimits({ maxRules: 99999, maxLogEntries: 800, maxConfigHistory: 8 });
    expect((store[STORAGE_KEYS.CAPACITY_LIMITS] as Record<string, number>).maxRules).toBe(
      limits.LIMIT_BOUNDS.maxRules.max,
    );
  });

  it('写入抛错返回 false（调用方据此回滚显示值），不抛出', async () => {
    const localSet = vi.mocked(chrome.storage.local.set);
    localSet.mockRejectedValueOnce(new Error('QUOTA_BYTES'));
    const ok = await limits.writeCapacityLimits({ maxRules: 300, maxLogEntries: 800, maxConfigHistory: 8 });
    expect(ok).toBe(false);
  });
});
