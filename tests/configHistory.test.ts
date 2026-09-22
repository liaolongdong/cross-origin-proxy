import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfigHistoryEntry, ProxyRule } from '@/utils/types';
import { MAX_CONFIG_HISTORY, MAX_CONFIG_HISTORY_TOTAL_SIZE, MAX_RULES, STORAGE_KEYS } from '@/utils/constants';

// 内存版 chrome.storage.local mock（在存储被测模块前安装），写入按 JSON 往返模拟真实序列化。
// `failHistoryWrite` 单独让恢复点写入失败，用来验证「安全网写失败不阻断主流程」；
// `failHistoryRead` 同理管读取侧（SW 回收/存储异常时 get 也会抛）。
let store: Record<string, unknown> = {};
let failHistoryWrite = false;
let failHistoryRead = false;
const setSpy = vi.fn(async (items: Record<string, unknown>) => {
  if (failHistoryWrite && Object.prototype.hasOwnProperty.call(items, STORAGE_KEYS.CONFIG_HISTORY)) {
    throw new TypeError('QUOTA_EXCEEDED');
  }
  Object.assign(store, JSON.parse(JSON.stringify(items)));
});

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async (keys: unknown) => {
        if (failHistoryRead && keys === STORAGE_KEYS.CONFIG_HISTORY) throw new TypeError('STORAGE_UNAVAILABLE');
        return store;
      }),
      set: setSpy,
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { sendMessage: vi.fn() },
});

const {
  importProxyConfig,
  addRule,
  batchDeleteRules,
  loadProfile,
  getProxyConfig,
  invalidateConfigCache,
  capConfigHistory,
  sanitizeConfigHistory,
  getConfigHistory,
  restoreConfigHistory,
} = await import('@/utils/storage');

function makeRule(id: string, overrides: Partial<ProxyRule> = {}): ProxyRule {
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

/** 直接铺现场配置（绕过写入侧，避免把被测的那一步混进前置条件） */
function seedConfig(rules: ProxyRule[], enabled = true): void {
  store = { [STORAGE_KEYS.PROXY_CONFIG]: { enabled, rules } };
  invalidateConfigCache();
}

function seedHistory(entries: unknown[]): void {
  store[STORAGE_KEYS.CONFIG_HISTORY] = entries;
}

function storedHistory(): ConfigHistoryEntry[] {
  return (store[STORAGE_KEYS.CONFIG_HISTORY] ?? []) as ConfigHistoryEntry[];
}

function reset(): void {
  store = {};
  failHistoryWrite = false;
  failHistoryRead = false;
  setSpy.mockClear();
  invalidateConfigCache();
}

describe('恢复点何时落下 — 只有成套替换才记', () => {
  beforeEach(reset);

  it('替换式导入前记下「被换掉的那一份」', async () => {
    seedConfig([makeRule('old')]);
    await importProxyConfig([makeRule('new')], { mode: 'replace' });

    const history = storedHistory();
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('replace-import');
    expect(history[0].ruleCount).toBe(1);
    expect(history[0].config.rules.map(r => r.id)).toEqual(['old']);
    expect(history[0].id).toBeTruthy();
    expect(typeof history[0].savedAt).toBe('number');
  });

  it('合并式导入不留恢复点（没有整包被换掉）', async () => {
    seedConfig([makeRule('old')]);
    await importProxyConfig([makeRule('new')], { mode: 'merge' });
    expect(storedHistory()).toHaveLength(0);
  });

  it('替换式导入被上限拒绝时也不留恢复点（没有发生写入）', async () => {
    seedConfig([makeRule('old')]);
    const incoming = Array.from({ length: MAX_RULES + 1 }, (_, i) => makeRule(`n${i}`));
    const result = await importProxyConfig(incoming, { mode: 'replace' });

    expect(result).toEqual({ success: false, error: 'MAX_RULES_EXCEEDED' });
    expect(storedHistory()).toHaveLength(0);
    expect((await getProxyConfig()).rules.map(r => r.id)).toEqual(['old']);
  });

  it('加载快照记下加载前的配置', async () => {
    seedConfig([makeRule('old')]);
    store[STORAGE_KEYS.PROFILES] = [{ id: 'p1', name: 'P1', rules: [makeRule('from-profile')], createdAt: 0 }];

    await loadProfile('p1');
    const history = storedHistory();
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('load-profile');
    expect(history[0].config.rules.map(r => r.id)).toEqual(['old']);
  });

  it('快照不存在时不落恢复点（失败的操作不该污染历史）', async () => {
    seedConfig([makeRule('old')]);
    const result = await loadProfile('nope');

    expect(result.success).toBe(false);
    expect(storedHistory()).toHaveLength(0);
  });

  it('批量删除真删掉了东西才记，快照是删除前的完整规则集', async () => {
    seedConfig([makeRule('a'), makeRule('b'), makeRule('c')]);
    await batchDeleteRules(['a', 'b']);

    const history = storedHistory();
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('batch-delete');
    expect(history[0].config.rules.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('批量删除空操作（选中的 id 早已被删）不落恢复点', async () => {
    seedConfig([makeRule('a')]);
    await batchDeleteRules(['gone']);
    expect(storedHistory()).toHaveLength(0);
  });

  it('单条新增不进历史（恢复点只兜「成套换掉」这种事故）', async () => {
    seedConfig([]);
    await addRule(makeRule('new'));
    expect(storedHistory()).toHaveLength(0);
  });

  it('恢复点写入失败只告警，不阻断主写入', async () => {
    seedConfig([makeRule('old')]);
    failHistoryWrite = true;

    const result = await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(result.success).toBe(true);
    expect((await getProxyConfig()).rules.map(r => r.id)).toEqual(['new']);
    expect(storedHistory()).toHaveLength(0);
  });

  it('读旧账失败同样不阻断主写入（安全网不能反过来咬主流程一口）', async () => {
    seedConfig([makeRule('old')]);
    failHistoryRead = true;

    const result = await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(result.success).toBe(true);
    expect((await getProxyConfig()).rules.map(r => r.id)).toEqual(['new']);
    expect(storedHistory()).toHaveLength(0);
  });
});

describe('capConfigHistory — 份数与字符预算都从最新往旧留', () => {
  function entry(id: string, padSize = 0): ConfigHistoryEntry {
    return {
      id,
      savedAt: Number(id.replace(/\D/g, '')) || 0,
      reason: 'replace-import',
      ruleCount: 1,
      config: { enabled: true, rules: [makeRule('r', { matchPattern: 'x'.repeat(padSize) || 'https://a/*' })] },
    };
  }

  it(`超过 ${MAX_CONFIG_HISTORY} 份时丢掉最旧的`, () => {
    const many = Array.from({ length: MAX_CONFIG_HISTORY + 2 }, (_, i) => entry(`e${i}`));
    expect(capConfigHistory(many).map(e => e.id)).toEqual(
      Array.from({ length: MAX_CONFIG_HISTORY }, (_, i) => `e${i}`),
    );
  });

  it('按整包字符预算截断，保留的是最新那几份', () => {
    const one = historySize(entry('e0'));
    const many = Array.from({ length: 4 }, (_, i) => entry(`e${i}`));
    const kept = capConfigHistory(many, MAX_CONFIG_HISTORY, one * 2 + 1);

    expect(kept.map(e => e.id)).toEqual(['e0', 'e1']);
    expect(kept.length).toBe(2);
  });

  it('单份就超预算时宁可不给恢复点（与日志「至少留一条」的语义刻意相反）', () => {
    const huge = entry('e0', 64);
    expect(capConfigHistory([huge], MAX_CONFIG_HISTORY, historySize(huge) - 1)).toEqual([]);
  });

  it(`存储层写入侧同样收口：单份快照超 ${MAX_CONFIG_HISTORY_TOTAL_SIZE} 字符时不落恢复点，导入仍成功`, async () => {
    reset();
    seedConfig([makeRule('huge', { matchPattern: 'x'.repeat(MAX_CONFIG_HISTORY_TOTAL_SIZE + 10) })]);

    const result = await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(result.success).toBe(true);
    expect(storedHistory()).toHaveLength(0);
  });

  it('新快照单份越预算时，预算内的旧恢复点原样留着（换掉规则集不该顺手抹掉退路）', async () => {
    reset();
    seedConfig([makeRule('huge', { matchPattern: 'x'.repeat(MAX_CONFIG_HISTORY_TOTAL_SIZE + 10) })]);
    seedHistory([entry('e-keep')]);

    const result = await importProxyConfig([makeRule('new')], { mode: 'replace' });
    expect(result.success).toBe(true);
    expect(storedHistory().map(e => e.id)).toEqual(['e-keep']);
  });
});

describe('sanitizeConfigHistory — 存储里的历史是可被手改的数据', () => {
  it('整包不是数组时按「没有恢复点」处理，不半解析', () => {
    expect(sanitizeConfigHistory(undefined)).toEqual([]);
    expect(sanitizeConfigHistory({})).toEqual([]);
    expect(sanitizeConfigHistory('nope')).toEqual([]);
  });

  it('缺 id 的条目直接丢弃（界面上没有可回退的句柄）', () => {
    const noId = { ...validEntry('h1') } as Record<string, unknown>;
    delete noId.id;
    expect(sanitizeConfigHistory([noId, validEntry('h2')]).map(e => e.id)).toEqual(['h2']);
  });

  it('config 缺失或 rules 不是数组的条目丢弃', () => {
    expect(sanitizeConfigHistory([{ id: 'a', savedAt: 1, reason: 'unknown', ruleCount: 0 }])).toEqual([]);
    expect(
      sanitizeConfigHistory([{ id: 'a', savedAt: 1, reason: 'load-profile', ruleCount: 1, config: { rules: 'x' } }]),
    ).toEqual([]);
  });

  it('非法规则逐条过滤，ruleCount 重算成「点回退能拿回几条」的真实数字', () => {
    const dirty = validEntry('h1');
    dirty.config.rules = [makeRule('ok'), { id: 'x', name: 'no-pattern' } as unknown as ProxyRule];
    dirty.ruleCount = 99;

    const [clean] = sanitizeConfigHistory([dirty]);
    expect(clean.ruleCount).toBe(1);
    expect(clean.config.rules.map(r => r.id)).toEqual(['ok']);
  });

  it('认不出的成因标成 unknown，而不是丢掉快照或硬塞进已知成因', () => {
    const future = validEntry('h1');
    future.reason = 'from-a-newer-version' as ConfigHistoryEntry['reason'];

    expect(sanitizeConfigHistory([future])[0].reason).toBe('unknown');
  });

  it('savedAt 非有限数按 0 处理（界面显示为未知时间而不是 Invalid Date）', () => {
    const bad = validEntry('h1');
    bad.savedAt = '昨天' as unknown as number;
    expect(sanitizeConfigHistory([bad])[0].savedAt).toBe(0);
  });

  it('enabled 只认真正的 true，其余一律 false', () => {
    const entry = validEntry('h1');
    entry.config.enabled = 'yes' as unknown as boolean;
    expect(sanitizeConfigHistory([entry])[0].config.enabled).toBe(false);
  });

  it('读取侧每次都从 storage 取（没有内存缓存可陈旧）', async () => {
    reset();
    seedHistory([validEntry('h1')]);
    expect((await getConfigHistory()).map(e => e.id)).toEqual(['h1']);

    seedHistory([validEntry('h2')]);
    expect((await getConfigHistory()).map(e => e.id)).toEqual(['h2']);
  });

  it(`手改进 storage 的几百条历史，读取侧最多给 ${MAX_CONFIG_HISTORY} 份（界面不无界渲染）`, async () => {
    reset();
    seedHistory(Array.from({ length: MAX_CONFIG_HISTORY + 20 }, (_, i) => validEntry(`h${i}`)));
    expect(await getConfigHistory()).toHaveLength(MAX_CONFIG_HISTORY);
  });
});

describe('restoreConfigHistory — 回退本身必须是可逆的', () => {
  beforeEach(reset);

  it('回退规则集但维持当前总开关，并先把现状记一份 before-restore', async () => {
    seedConfig([makeRule('current')], false);
    seedHistory([
      {
        id: 'h1',
        savedAt: 1,
        reason: 'replace-import',
        ruleCount: 1,
        config: { enabled: true, rules: [makeRule('old')] },
      },
    ]);

    const result = await restoreConfigHistory('h1');
    expect(result).toEqual({ success: true, restored: 1 });

    const config = await getProxyConfig();
    expect(config.rules.map(r => r.id)).toEqual(['old']);
    // 快照里那份 enabled=true 只是记录：点「找回规则」不该顺手把代理打开
    expect(config.enabled).toBe(false);

    const history = storedHistory();
    expect(history).toHaveLength(2);
    expect(history[0].reason).toBe('before-restore');
    expect(history[0].config.rules.map(r => r.id)).toEqual(['current']);
  });

  it('未知 id 明确失败，不写任何配置', async () => {
    seedConfig([makeRule('current')]);
    seedHistory([validEntry('h1')]);
    const before = JSON.stringify(store[STORAGE_KEYS.PROXY_CONFIG]);

    expect(await restoreConfigHistory('nope')).toEqual({ success: false, error: 'HISTORY_ENTRY_NOT_FOUND' });
    expect(JSON.stringify(store[STORAGE_KEYS.PROXY_CONFIG])).toBe(before);
    expect(storedHistory()).toHaveLength(1);
  });

  it(`手改过的超限快照拒绝回退（照写会让 DNR 整批被拒）`, async () => {
    seedConfig([makeRule('current')]);
    seedHistory([
      {
        id: 'big',
        savedAt: 1,
        reason: 'replace-import',
        ruleCount: MAX_RULES + 1,
        config: { enabled: true, rules: Array.from({ length: MAX_RULES + 1 }, (_, i) => makeRule(`r${i}`)) },
      },
    ]);

    expect(await restoreConfigHistory('big')).toEqual({ success: false, error: 'MAX_RULES_EXCEEDED' });
    expect((await getProxyConfig()).rules.map(r => r.id)).toEqual(['current']);
    expect(storedHistory()).toHaveLength(1);
  });

  it('回退到空规则集是合法操作（用户可能就是要清空）', async () => {
    seedConfig([makeRule('current')]);
    seedHistory([
      { id: 'empty', savedAt: 1, reason: 'batch-delete', ruleCount: 0, config: { enabled: false, rules: [] } },
    ]);

    expect(await restoreConfigHistory('empty')).toEqual({ success: true, restored: 0 });
    expect((await getProxyConfig()).rules).toHaveLength(0);
  });
});

function validEntry(id: string): ConfigHistoryEntry {
  return {
    id,
    savedAt: 2,
    reason: 'replace-import',
    ruleCount: 1,
    config: { enabled: true, rules: [makeRule('r1')] },
  };
}

function historySize(entry: ConfigHistoryEntry): number {
  return JSON.stringify(entry).length;
}
