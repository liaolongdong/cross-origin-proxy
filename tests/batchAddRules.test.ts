import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProxyRule } from '@/utils/types';
import { MAX_RULES, STORAGE_KEYS } from '@/utils/constants';

// 内存版 chrome.storage.local mock（在导入被测模块前安装）
let store: Record<string, unknown> = {};
const setSpy = vi.fn(async (items: Record<string, unknown>) => {
  Object.assign(store, items);
});

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async () => store),
      set: setSpy,
    },
    onChanged: { addListener: vi.fn() },
  },
});

const { batchAddRules, addRule, getProxyConfig, invalidateConfigCache } = await import('@/utils/storage');

function makeRule(id: string, overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: 'https://api.example.com/*',
    targetUrl: 'https://target.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('batchAddRules — 批量新增（HAR 导入性能优化）', () => {
  beforeEach(() => {
    store = {};
    setSpy.mockClear();
    // mock 的 onChanged 不会触发，需手动失效模块内配置缓存，避免跨用例串数据
    invalidateConfigCache();
  });

  it('一次写入多条规则（仅一次 storage.set）', async () => {
    const rules = [makeRule('a'), makeRule('b'), makeRule('c')];
    await batchAddRules(rules);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const config = await getProxyConfig();
    expect(config.rules.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('空列表不产生写入', async () => {
    await batchAddRules([]);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('追加到已有规则之后', async () => {
    store = { [STORAGE_KEYS.PROXY_CONFIG]: { enabled: true, rules: [makeRule('existing')] } };
    await batchAddRules([makeRule('new1'), makeRule('new2')]);

    const config = await getProxyConfig();
    expect(config.rules.map(r => r.id)).toEqual(['existing', 'new1', 'new2']);
  });

  it(`超过 MAX_RULES(${MAX_RULES}) 上限时整体拒绝，不写入任何规则`, async () => {
    const existing = Array.from({ length: MAX_RULES - 1 }, (_, i) => makeRule(`e${i}`));
    store = { [STORAGE_KEYS.PROXY_CONFIG]: { enabled: true, rules: existing } };

    await expect(batchAddRules([makeRule('n1'), makeRule('n2')])).rejects.toThrow('MAX_RULES_EXCEEDED');
    expect(setSpy).not.toHaveBeenCalled();

    const config = await getProxyConfig();
    expect(config.rules).toHaveLength(MAX_RULES - 1);
  });

  it('恰好补满上限时允许写入', async () => {
    const existing = Array.from({ length: MAX_RULES - 2 }, (_, i) => makeRule(`e${i}`));
    store = { [STORAGE_KEYS.PROXY_CONFIG]: { enabled: true, rules: existing } };

    await batchAddRules([makeRule('n1'), makeRule('n2')]);
    const config = await getProxyConfig();
    expect(config.rules).toHaveLength(MAX_RULES);
  });

  it('与单条 addRule 的上限语义一致（边界不重叠）', async () => {
    const existing = Array.from({ length: MAX_RULES }, (_, i) => makeRule(`e${i}`));
    store = { [STORAGE_KEYS.PROXY_CONFIG]: { enabled: true, rules: existing } };

    await expect(addRule(makeRule('overflow'))).rejects.toThrow('MAX_RULES_EXCEEDED');
    await expect(batchAddRules([makeRule('overflow')])).rejects.toThrow('MAX_RULES_EXCEEDED');
  });
});
