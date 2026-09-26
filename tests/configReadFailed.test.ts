import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import type { ProxyConfig, ProxyRule } from '@/utils/types';

/**
 * `configReadFailed` —— 读取失败不许被画成「还没有规则」（评审 M-11）
 *
 * 界面侧读配置只有一个出口（`GET_PROXY_CONFIG`），而失败有三种形状：消息抛错（SW 正在重启）、
 * 回包不是对象、回包有但没有可用的 `rules` 数组。旧实现在这三条上都是 `return`，于是
 * `rules` 停在初值 `[]`，`RuleTable` 的空态判据（`rules.length === 0 && !hasAnyRules`）成立，
 * 首屏直接给一张「新增规则 / 导入配置」的引导卡——用户可能本来有三十条规则，这张卡等于邀请他
 * 重复创建。同页 DNR 那一格早就定了口径：「不确定」绝不画成「没有」。
 *
 * 这里只测 composable 这一层（假 `chrome` ＋ 真实现，断言的是外部可观察的三件事：旗标、列表、
 * loading）。面板的**先后顺序**是另一件承重的东西——排在引导卡之后它就永远不出现——而 Vue 的渲染
 * 在本环境没有对应物（无 DOM），因此那半按源码契约钉在同文件末尾。
 */

// 本测试在组件实例外调用 composable（生命周期只负责首轮 fetchConfig 与 storage 监听，
// 这两件事由测试手动驱动），因此 Vue 必然抱怨 onMounted/onUnmounted。
// 只吞掉这两条，其余警告照常输出，避免把真实告警也一起静音。
const nativeWarn = console.warn;
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  const head = String(args[0]);
  if (head.startsWith('[Vue warn]: onMounted') || head.startsWith('[Vue warn]: onUnmounted')) return;
  nativeWarn.apply(console, args);
});

const { useRuleManagement } = await import('@/composables/useRuleManagement');

function makeRule(id: string): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: `https://api.${id}.com/*`,
    targetUrl: 'https://target.example.com',
    matchType: 'wildcard',
    priority: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 按队列依次回包；队列元素可以是值（含 `undefined`）或 Error（表示 sendMessage 抛出） */
function stubResponses(responses: unknown[]) {
  const queue = [...responses];
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: vi.fn(async () => {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
      }),
    },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
}

const okConfig = (ids: string[]): ProxyConfig => ({
  enabled: true,
  rules: ids.map(makeRule),
});

describe('configReadFailed — 三种失败形状都只置旗标，不清空列表', () => {
  it('消息抛错：旗标立起，loading 收口，列表停在空', async () => {
    stubResponses([new Error('Receiving end does not exist')]);
    const mgmt = useRuleManagement();
    await mgmt.fetchConfig();

    expect(mgmt.configReadFailed.value).toBe(true);
    expect(mgmt.loading.value).toBe(false);
    expect(mgmt.rules.value).toEqual([]);
  });

  it('回包为 undefined / 非对象 / rules 不是数组：同样算失败，且不算「读到空表」', async () => {
    for (const bad of [undefined, null, 'boom', {}, { enabled: true }, { enabled: true, rules: 'x' }]) {
      stubResponses([bad]);
      const mgmt = useRuleManagement();
      await mgmt.fetchConfig();
      expect(mgmt.configReadFailed.value, `回包 ${JSON.stringify(bad)} 应判为读取失败`).toBe(true);
      expect(mgmt.rules.value).toEqual([]);
    }
  });

  it('成功读过以后再次失败：留着上一次的三十条，只把旗标立起来', async () => {
    stubResponses([okConfig(['a', 'b']), undefined]);
    const mgmt = useRuleManagement();
    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(false);
    expect(mgmt.rules.value).toHaveLength(2);

    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(true);
    // 这一条是整个修复的正面：失败那一刻列表**不**被清空，界面继续显示已读到的规则
    expect(mgmt.rules.value.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('失败以后恢复：旗标落回 false，列表按新读数刷新', async () => {
    stubResponses([new Error('SW recycling'), okConfig(['a']), okConfig(['a', 'b'])]);
    const mgmt = useRuleManagement();

    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(true);
    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(false);
    expect(mgmt.rules.value.map(r => r.id)).toEqual(['a']);
    // 存疑期间的成功读数必须把旗标洗掉，否则那句提示会挂在界面上不走
    await mgmt.fetchConfig();
    expect(mgmt.configReadFailed.value).toBe(false);
    expect(mgmt.rules.value).toHaveLength(2);
  });

  it('确实读到空表：那是「没有规则」，不是失败', async () => {
    stubResponses([okConfig([])]);
    const mgmt = useRuleManagement();
    await mgmt.fetchConfig();

    expect(mgmt.configReadFailed.value).toBe(false);
    expect(mgmt.rules.value).toEqual([]);
  });
});

describe('读取失败面板排在空态引导之前（源码契约）', () => {
  // 与仓内其他源码契约同一读法（`tests/full-verification.test.ts` 用 `fs.readFileSync` 相对路径）：
  // 本环境无 DOM，`.vue` 只能按文本核对，不能 import。
  const table = fs.readFileSync('components/options/RuleTable.vue', 'utf8');
  const app = fs.readFileSync('components/options/App.vue', 'utf8');

  it('两块面板的 key 都在，且失败面板在前', () => {
    const failedAt = table.indexOf('key="read-failed"');
    const guideAt = table.indexOf('key="empty-guide"');

    expect(failedAt).toBeGreaterThan(-1);
    expect(guideAt).toBeGreaterThan(-1);
    // 顺序承重：引导卡在前时，首轮失败（rules 为空 **且** hasAnyRules 为 false）会先命中它，
    // 失败面板一次都画不出来——修了个寂寞。
    expect(failedAt).toBeLessThan(guideAt);
  });

  it('失败面板的判据是「列表为空且读取失败」，刷新按钮接回 fetchConfig', () => {
    const head = table.slice(0, table.indexOf('key="read-failed"'));
    const guard = head.match(/v-if="([^"]+)"/);

    expect(guard?.[1].replace(/\s+/g, ' ')).toBe('rules.length === 0 && readFailed');
    expect(table).toMatch(/@click="\$emit\('refresh'\)"/);
    expect(app).toMatch(/@refresh="fetchConfig"/);
  });

  it('引导卡仍是那句判据，App.vue 把旗标传下来', () => {
    expect(table).toMatch(/v-else-if="rules\.length === 0 && !hasAnyRules"/);
    expect(app).toMatch(/:read-failed="configReadFailed"/);
  });
});
