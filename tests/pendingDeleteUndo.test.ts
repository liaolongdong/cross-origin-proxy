import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageType } from '@/utils/types';
import type { ProxyConfig, ProxyRule } from '@/utils/types';

// 可变存储快照：撤销窗口内删除尚未落库，因此快照里始终带着「已被 UI 移除」的规则，
// 这正是重复行 bug 的成因，测试靠它复现竞态。
let snapshot: ProxyConfig = { enabled: true, rules: [] };

vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: vi.fn(async (message: { type: MessageType }) => {
      if (message.type === MessageType.GET_PROXY_CONFIG) return snapshot;
      return { success: true };
    }),
  },
  storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
});

// 本测试在组件实例外调用 composable（生命周期只负责首轮 fetchConfig 与 storage 监听，
// 而这两件事由测试手动驱动），因此 Vue 必然抱怨 onMounted/onUnmounted。
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

const idsOf = (rules: ProxyRule[]) => rules.map(r => r.id);

describe('pendingDeleteIds — 删除撤销窗口内的 fetchConfig 不把已删行捞回来', () => {
  beforeEach(() => {
    snapshot = { enabled: true, rules: [makeRule('a'), makeRule('b'), makeRule('c')] };
  });

  it('登记后刷新仍保持移除，注销后恢复显示', async () => {
    const mgmt = useRuleManagement();
    await mgmt.fetchConfig();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b', 'c']);

    mgmt.beginPendingDelete('a');
    mgmt.rules.value = mgmt.rules.value.filter(r => r.id !== 'a');
    // 模拟其他标签页改动 / 导入 / 加载环境配置触发的刷新：存储里 'a' 还在
    await mgmt.fetchConfig();
    expect(idsOf(mgmt.rules.value)).toEqual(['b', 'c']);

    mgmt.endPendingDelete('a');
    await mgmt.fetchConfig();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b', 'c']);
  });

  it('连续删除多条时互不影响，只屏蔽登记过的那几条', async () => {
    const mgmt = useRuleManagement();
    await mgmt.fetchConfig();

    mgmt.beginPendingDelete('a');
    mgmt.rules.value = mgmt.rules.value.filter(r => r.id !== 'a');
    mgmt.beginPendingDelete('c');
    mgmt.rules.value = mgmt.rules.value.filter(r => r.id !== 'c');

    await mgmt.fetchConfig();
    expect(idsOf(mgmt.rules.value)).toEqual(['b']);

    // 撤销 'a'：只恢复 'a'，'c' 仍在窗口内
    mgmt.endPendingDelete('a');
    await mgmt.fetchConfig();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b']);
  });
});
