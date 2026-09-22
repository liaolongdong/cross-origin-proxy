import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isDnrSample, describeDnrSample, isDnrCountReadable } from '@/utils/dnrSample';
import type { DnrSample } from '@/utils/types';

/**
 * `DnrSample` 的可渲染状态判定（回归：三态在两个入口各写一份、且写歪了）
 *
 * 后台采样器已经用 `sampledAt === 0` 表示「没有读数」、用 `stale` 区分「没有生效的
 * 网络层规则」与「读不到（配额/退避）」，但 popup 把两者合并成一句「统计暂不可用」，
 * options 侧则完全不看 `sampledAt`，把「没读到」当成空数组渲染成「近 5 分钟无命中」。
 * 判据收在这一个纯函数里，两个入口只负责把 state 映射成文案。
 */
const sample = (over: Partial<DnrSample>): DnrSample => ({
  stats: [{ ruleId: 'r1', ruleName: 'R1', hitCount: 3 }],
  sampledAt: 1700000000000,
  stale: false,
  ...over,
});

describe('isDnrSample：只接受结构完整的采样响应', () => {
  it('完整结构通过，SW 异常载荷与非对象一律不通过', () => {
    expect(isDnrSample(sample({}))).toBe(true);
    expect(isDnrSample(sample({ tabId: 7 }))).toBe(true);
    for (const bad of [undefined, null, {}, false, 'stats', { success: false }, { stats: [] }, { sampledAt: 0 }]) {
      expect(isDnrSample(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('stats 必须是数组、sampledAt 必须是数字', () => {
    expect(isDnrSample({ stats: 'x', sampledAt: 1, stale: false })).toBe(false);
    expect(isDnrSample({ stats: [], sampledAt: '1', stale: false })).toBe(false);
  });
});

describe('describeDnrSample：五态与读数', () => {
  it('有读数且新鲜 → fresh，读数即各规则命中之和', () => {
    const view = describeDnrSample(
      sample({
        stats: [
          { ruleId: 'a', ruleName: 'A', hitCount: 2 },
          { ruleId: 'b', ruleName: 'B', hitCount: 5 },
        ],
      }),
    );
    expect(view).toEqual({ state: 'fresh', hits: 7 });
  });

  it('采到了但确实没人命中 → fresh + 0，不能被当成「不知道」', () => {
    expect(describeDnrSample(sample({ stats: [] }))).toEqual({ state: 'fresh', hits: 0 });
  });

  it('旧值 + 新鲜度存疑 → stale，但仍保留上一次的读数', () => {
    expect(describeDnrSample(sample({ stale: true }))).toEqual({ state: 'stale', hits: 3 });
  });

  it('没有生效的网络层规则（sampledAt=0 且非 stale）→ notApplicable，不得混成读不到', () => {
    expect(describeDnrSample(sample({ stats: [], sampledAt: 0, stale: false }))).toEqual({
      state: 'notApplicable',
      hits: null,
    });
  });

  it('配额/退避中且没有缓存 → unavailable；两种「没有读数」必须落在不同 state 上', () => {
    const unknown = sample({ stats: [], sampledAt: 0 });
    expect(describeDnrSample({ ...unknown, stale: true }).state).toBe('unavailable');
    expect(describeDnrSample({ ...unknown, stale: false }).state).toBe('notApplicable');
  });

  it('还没拿到过任何响应（含 SW 的 { success:false }）→ pending，读数为 null', () => {
    for (const raw of [null, undefined, { success: false }, { stats: [] }, 'nope']) {
      expect(describeDnrSample(raw)).toEqual({ state: 'pending', hits: null });
    }
  });

  it('hits 为 null 的三种状态是 UI 画「—」的唯一依据', () => {
    const nullish = [
      sample({ stats: [], sampledAt: 0, stale: false }),
      sample({ stats: [], sampledAt: 0, stale: true }),
      null,
    ];
    for (const raw of nullish) expect(describeDnrSample(raw).hits, JSON.stringify(raw)).toBeNull();
  });
});

describe('isDnrCountReadable：只有真读到过数才允许画成数字', () => {
  it('fresh / stale 可读数；其余三态下的 0 都是「不知道」', () => {
    expect(isDnrCountReadable('fresh')).toBe(true);
    expect(isDnrCountReadable('stale')).toBe(true);
    for (const state of ['notApplicable', 'unavailable', 'pending'] as const) {
      expect(isDnrCountReadable(state), state).toBe(false);
    }
  });

  it('与 describeDnrSample 的 hits: null 判据同源（两条 UI 路径不得各说各话）', () => {
    for (const raw of [sample({}), sample({ stale: true }), sample({ stats: [], sampledAt: 0 }), null] as const) {
      const { state, hits } = describeDnrSample(raw);
      expect(isDnrCountReadable(state)).toBe(hits !== null);
    }
  });
});

describe('规则列表命中列：分通道显示，不相加（源码契约）', () => {
  const tableSrc = readFileSync('components/options/RuleTable.vue', 'utf-8');

  it('表格按五态判据决定网络层那一格，而不是直接把两个数相加', () => {
    expect(tableSrc).toContain('isDnrCountReadable(state)');
    expect(tableSrc).toContain('dnrStatsState: DnrSampleState');
    expect(tableSrc).not.toContain('net + ');
    expect(tableSrc).not.toContain('combineHitStats');
  });

  it('每格只画属于自己那条通道的数：不适用的那一格是「—」而不是 0', () => {
    // 走网络层的规则在后台通道上恒为 0，反向同理——把「不适用」画成 0 就是本轮要消灭的谎报
    expect(tableSrc).toContain(
      'const channelById = new Map(props.rules.map(rule => [rule.id, isSimpleRule(rule)] as const));',
    );
    expect(tableSrc).toContain('const netUnknown = !onNet || !readable;');
    expect(tableSrc).toContain('const extUnknown = onNet;');
    expect(tableSrc).toContain("net: netUnknown ? '—' : String(stat.net)");
    expect(tableSrc).toContain("ext: extUnknown ? '—' : String(stat.ext)");
  });

  it('两格都是「—」时整列折叠成「-」，而不是并排画两个破折号', () => {
    // 判据是「这一行说得出话吗」（两格各自 unknown），不是「后台计数为零」——
    // 网络层规则在采样读不到、而后台那一格恰好非零时，旧判据会放行出 `— —`
    expect(tableSrc).toContain('if (netUnknown && extUnknown) continue;');
  });

  it('读不到时画「—」，并且提示语区分「没有这类规则」与「统计暂不可用」', () => {
    expect(tableSrc).toContain("t('statsNotApplicable')");
    expect(tableSrc).toContain("t('statsUnavailable')");
    // 两格各自的「不适用」必须有独立话术，否则悬停会解释成另一件事
    expect(tableSrc).toContain("t('hitStatsNetNotApplicable')");
    expect(tableSrc).toContain("t('hitStatsExtNotApplicable')");
  });
});

describe('日志抽屉空态：四态四句，退避期不与「无命中」共用一句（源码契约）', () => {
  const drawerSrc = readFileSync('components/options/LogDrawer.vue', 'utf-8');

  it('notApplicable / unavailable / pending / stale 各自有判据，stale 额外带上「可能滞后」', () => {
    expect(drawerSrc).toContain("props.dnrStatsState === 'notApplicable'");
    expect(drawerSrc).toContain("props.dnrStatsState === 'pending'");
    expect(drawerSrc).toContain("props.dnrStatsState === 'unavailable'");
    expect(drawerSrc).toContain("props.dnrStatsState === 'stale'");
    // 「近 5 分钟」只能出现一次：`dnrStatsEmpty` 自带窗口，拼的那半句不得再带
    expect(drawerSrc).toContain("t('statsMayLag')");
    expect(drawerSrc).not.toContain("${t('dnrStatsEmpty')} · ${t('hitStatsStale')}");
  });
});

describe('popup 第三格注释：总开关关闭不得说成「没有网络层规则」（源码契约）', () => {
  const popupSrc = readFileSync('entrypoints/popup/App.vue', 'utf-8');

  it('notApplicable 按总开关二次分因，pending / unavailable 不得留下空注释', () => {
    expect(popupSrc).toContain("return enabled.value ? t('statsNotApplicable') : t('statsProxyOff')");
    expect(popupSrc).toContain("if (state === 'unavailable' || state === 'pending') return t('statsUnavailable')");
  });
});
