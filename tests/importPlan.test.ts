import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import type { ImportPlan, ProxyRule } from '@/utils/types';
import { MAX_RULES } from '@/utils/constants';
import { planImport } from '@/utils/importPlan';

// 内存版 chrome.storage.local mock（在存储被测模块前安装）。
// 写入按 JSON 往返，模拟真实 storage 的序列化边界——否则快照与活配置共享对象，测不出别名问题。
let store: Record<string, unknown> = {};
const setSpy = vi.fn(async (items: Record<string, unknown>) => {
  Object.assign(store, JSON.parse(JSON.stringify(items)));
});

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(async () => store),
      set: setSpy,
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { sendMessage: vi.fn() },
});

const { importProxyConfig, getProxyConfig, invalidateConfigCache } = await import('@/utils/storage');

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

function fillCurrent(rules: ProxyRule[]): void {
  store = { proxy_config: { enabled: true, rules } };
  invalidateConfigCache();
}

function reset(): void {
  store = {};
  setSpy.mockClear();
  invalidateConfigCache();
}

describe('planImport — 合并模式', () => {
  it('同键（name + matchPattern）不同目标地址算跳过，并把两边目标地址都摆出来', () => {
    const current = [makeRule('c1', { name: 'order', matchPattern: 'https://a/*', targetUrl: 'https://fat/a' })];
    const incoming = [makeRule('i1', { name: 'order', matchPattern: 'https://a/*', targetUrl: 'https://uat/a' })];

    expect(planImport(current, incoming, 'merge')).toMatchObject({
      mode: 'merge',
      added: 0,
      skipped: 1,
      duplicatesWithinFile: 0,
      replaces: 0,
      exceedsLimit: false,
    });
  });

  it('被跳过的条目给出「现网仍是它」与「文件里这条不会生效」两个目标地址', () => {
    const current = [makeRule('c1', { name: 'order', matchPattern: 'https://a/*', targetUrl: 'https://fat/a' })];
    const incoming = [makeRule('i1', { name: 'order', matchPattern: 'https://a/*', targetUrl: 'https://uat/a' })];

    const { conflicts } = planImport(current, incoming, 'merge');
    expect(conflicts).toEqual([
      {
        name: 'order',
        matchPattern: 'https://a/*',
        currentTargetUrl: 'https://fat/a',
        incomingTargetUrl: 'https://uat/a',
      },
    ]);
  });

  it('仅名称相同或仅模式相同都不算重复（键是两个字段一起构成的）', () => {
    const current = [makeRule('c1', { name: 'order', matchPattern: 'https://a/*' })];
    const incoming = [
      makeRule('i1', { name: 'order', matchPattern: 'https://b/*' }),
      makeRule('i2', { name: 'pay', matchPattern: 'https://a/*' }),
    ];

    expect(planImport(current, incoming, 'merge')).toMatchObject({ added: 2, skipped: 0, conflicts: [] });
  });

  it('文件内部自重复不剔除（既有语义），但如实报出多带的条数', () => {
    const incoming = [
      makeRule('i1', { name: 'order', matchPattern: 'https://a/*' }),
      makeRule('i2', { name: 'order', matchPattern: 'https://a/*' }),
      makeRule('i3', { name: 'pay', matchPattern: 'https://b/*' }),
    ];

    expect(planImport([], incoming, 'merge')).toMatchObject({
      added: 3,
      skipped: 0,
      duplicatesWithinFile: 1,
      conflicts: [],
    });
  });

  it('现网存在多份同键规则时跳过判据不变，冲突只列一条', () => {
    const current = [
      makeRule('c1', { name: 'order', matchPattern: 'https://a/*', targetUrl: 'https://first' }),
      makeRule('c2', { name: 'order', matchPattern: 'https://a/*', targetUrl: 'https://second' }),
    ];
    const incoming = [makeRule('i1', { name: 'order', matchPattern: 'https://a/*', targetUrl: 'https://incoming' })];

    const plan = planImport(current, incoming, 'merge');
    expect(plan).toMatchObject({ added: 0, skipped: 1 });
    expect(plan.conflicts).toHaveLength(1);
    // 取第一条现网规则作「现网值」：键存在即可，取哪一份都不影响「会被跳过」这个结论
    expect(plan.conflicts[0].currentTargetUrl).toBe('https://first');
  });
});

describe('planImport — 替换模式', () => {
  it('不去重、不列冲突，只报「将被整包换掉多少条」', () => {
    const current = [makeRule('c1'), makeRule('c2'), makeRule('c3')];
    // 与现网完全同键的条目在替换模式下依然是「新增」，因为旧的那批整体作废
    const incoming = [makeRule('i1', { name: 'rule-c1', matchPattern: 'https://api-c1.example.com/*' })];

    expect(planImport(current, incoming, 'replace')).toEqual({
      mode: 'replace',
      added: 1,
      skipped: 0,
      conflicts: [],
      duplicatesWithinFile: 0,
      replaces: 3,
      exceedsLimit: false,
    });
  });
});

describe('planImport — 上限判定', () => {
  it(`替换模式：文件本身超 ${MAX_RULES} 条时 exceedsLimit 为真`, () => {
    const incoming = Array.from({ length: MAX_RULES + 1 }, (_, i) => makeRule(`n${i}`));
    expect(planImport([makeRule('c1')], incoming, 'replace').exceedsLimit).toBe(true);
  });

  it(`替换模式：恰好等于上限合法（与写入侧同边界）`, () => {
    const incoming = Array.from({ length: MAX_RULES }, (_, i) => makeRule(`n${i}`));
    expect(planImport([], incoming, 'replace').exceedsLimit).toBe(false);
  });

  it(`合并模式按去重后的数量判定：文件超长但全是重复项时仍可导入`, () => {
    const current = Array.from({ length: MAX_RULES }, (_, i) => makeRule(`c${i}`));
    const dupOnly = current.map(r => makeRule(`i-${r.id}`, { name: r.name, matchPattern: r.matchPattern }));

    expect(planImport(current, dupOnly, 'merge').exceedsLimit).toBe(false);
  });

  it('合并模式：现网 + 预计新增超一条即越界', () => {
    const current = Array.from({ length: MAX_RULES }, (_, i) => makeRule(`c${i}`));
    const incoming = [makeRule('i1', { name: 'extra', matchPattern: 'https://extra/*' })];

    expect(planImport(current, incoming, 'merge')).toMatchObject({ added: 1, exceedsLimit: true });
  });
});

describe('预览与真实写入同源（spec R1）', () => {
  beforeEach(reset);

  /** 同一份输入分别喂给预览与写入，两边报数必须一致 */
  async function assertPlanMatchesWrite(
    current: ProxyRule[],
    incoming: ProxyRule[],
    mode: 'merge' | 'replace',
  ): Promise<ImportPlan> {
    fillCurrent(current);
    const plan = planImport(current, incoming, mode);
    const result = await importProxyConfig(incoming, { mode });

    if (plan.exceedsLimit) {
      expect(result).toEqual({ success: false, error: 'MAX_RULES_EXCEEDED' });
      return plan;
    }
    expect(result.success).toBe(true);
    expect(result.added).toBe(plan.added);
    expect(result.skipped).toBe(plan.skipped);
    const after = await getProxyConfig();
    expect(after.rules).toHaveLength(mode === 'replace' ? plan.added : current.length + plan.added);
    return plan;
  }

  it('合并：改目标地址的条目预览说跳过、写入也确实跳过', async () => {
    const current = [makeRule('c1', { name: 'order', matchPattern: 'https://a/*' })];
    const incoming = [
      makeRule('i1', { name: 'order', matchPattern: 'https://a/*', targetUrl: 'https://changed' }),
      makeRule('i2', { name: 'pay', matchPattern: 'https://b/*' }),
    ];

    const plan = await assertPlanMatchesWrite(current, incoming, 'merge');
    expect(plan).toMatchObject({ added: 1, skipped: 1 });
    // 现网那条的目标地址原样保留——这正是「合并不是更新」这件事要演给用户看的部分
    const after = await getProxyConfig();
    expect(after.rules.find(r => r.name === 'order')?.targetUrl).toBe('https://target.example.com');
  });

  it('合并：文件内自重复两边都算两条', async () => {
    const incoming = [
      makeRule('i1', { name: 'dup', matchPattern: 'https://a/*' }),
      makeRule('i2', { name: 'dup', matchPattern: 'https://a/*' }),
    ];
    const plan = await assertPlanMatchesWrite([], incoming, 'merge');
    expect(plan).toMatchObject({ added: 2, duplicatesWithinFile: 1 });
  });

  it('替换：报几条就进几条，且现网那批被换掉', async () => {
    const current = [makeRule('c1'), makeRule('c2')];
    const plan = await assertPlanMatchesWrite(current, [makeRule('i1')], 'replace');
    expect(plan.replaces).toBe(2);
    const after = await getProxyConfig();
    expect(after.rules.map(r => r.id)).toEqual(['i1']);
  });

  it('越界时两边同一结论：预览亮超限、写入整包拒绝且不落盘', async () => {
    const current = Array.from({ length: MAX_RULES }, (_, i) => makeRule(`c${i}`));
    const incoming = [makeRule('i1', { name: 'extra', matchPattern: 'https://extra/*' })];

    await assertPlanMatchesWrite(current, incoming, 'merge');
    expect(setSpy).not.toHaveBeenCalled();
    expect((await getProxyConfig()).rules).toHaveLength(MAX_RULES);
  });
});

describe('键计算只有一个来源（防预览/写入分叉）', () => {
  const planSrc = fs.readFileSync('utils/importPlan.ts', 'utf-8');
  const storageSrc = fs.readFileSync('utils/storage.ts', 'utf-8');

  it('预览侧不自己写差集，直接调用存储层用的 deduplicateRules', () => {
    expect(planSrc).toContain('deduplicateRules(current, incoming)');
    expect(planSrc).toContain('ruleMergeKey');
    expect(planSrc).not.toMatch(/new Set\([^)]*\.map\(/);
  });

  it('存储层的合并也走同一个 deduplicateRules', () => {
    expect(storageSrc).toContain('deduplicateRules(config.rules, incoming)');
  });
});
