import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageType } from '@/utils/types';
import type { ProxyConfig, ProxyRule } from '@/utils/types';
import { DELETE_UNDO_WINDOW_MS } from '@/utils/constants';

/**
 * 删除撤销窗口（`composables/useDeleteUndo.ts`）按外部可观察面测：
 * 「列表里还剩哪几条」「`send` 被调用了几次、什么时候被调用」「两条界面回调收到什么」，
 * 而不是去读内部标志位。它与 `useRuleManagement` 的 `pendingDeleteIds` 是**真集成**——
 * 那份登记的作用只有在窗口期内跑一次真的 `fetchConfig` 才量得出来，所以这里用真 composable，
 * 只把 `chrome` 换成按可变快照应答的桩。
 *
 * 提示的渲染（`ElMessage` + 那颗原生按钮）在 node 环境没有对应物，仍由
 * `tests/keyboardA11y.test.ts` 与 `tests/full-verification.test.ts` 按源码契约钉。
 */

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

// 组件实例外调用 composable 必然抱怨 onMounted/onUnmounted，只吞这两条，其余警告照常输出。
const nativeWarn = console.warn;
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  const head = String(args[0]);
  if (head.startsWith('[Vue warn]: onMounted') || head.startsWith('[Vue warn]: onUnmounted')) return;
  nativeWarn.apply(console, args);
});

const { useRuleManagement } = await import('@/composables/useRuleManagement');
const { useDeleteUndo } = await import('@/composables/useDeleteUndo');

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

const idsOf = (rules: ProxyRule[]): string[] => rules.map(r => r.id);

/** 每轮都新建一套：窗口状态、登记集合与快照，避免上一轮的定时器漏进这一轮。 */
function setUp(ids: string[]) {
  snapshot = { enabled: true, rules: ids.map(makeRule) };
  const mgmt = useRuleManagement();
  const { openDeleteUndo } = useDeleteUndo({
    rules: mgmt.rules,
    beginPendingDelete: mgmt.beginPendingDelete,
    endPendingDelete: mgmt.endPendingDelete,
  });
  return { mgmt, openDeleteUndo };
}

describe('[撤销窗口] 乐观移除与到期提交', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('开窗口即从列表移除，但窗口期内一次删除消息都不发', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b', 'c']);
    await mgmt.fetchConfig();
    const send = vi.fn(async () => ({ success: true }));

    const win = openDeleteUndo(['b'], { send, close: vi.fn(), failed: vi.fn() });

    expect(win, '列表里明明有 b，窗口却没开起来').not.toBeNull();
    expect(win!.count).toBe(1);
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'c']);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS - 1);
    expect(send).not.toHaveBeenCalled();
  });

  it('窗口到期才落库：先收起撤销入口，再发出删除', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b', 'c']);
    await mgmt.fetchConfig();
    const order: string[] = [];

    openDeleteUndo(['b'], {
      send: async () => {
        order.push('send');
        return { success: true };
      },
      close: () => order.push('close'),
      failed: () => order.push('failed'),
    });

    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS);
    expect(order).toEqual(['close', 'send']);
  });

  it('窗口期内刷新一整遍配置也不会把已删行捞回来，提交后才注销登记', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b', 'c']);
    await mgmt.fetchConfig();
    // 假的 `send` 按后台那样真的把行从快照里带走，否则「提交之后」这一段量的是不存在的世界
    const send = vi.fn(async () => {
      snapshot = { ...snapshot, rules: snapshot.rules.filter(r => r.id !== 'b') };
      return { success: true };
    });

    openDeleteUndo(['b'], { send, close: vi.fn(), failed: vi.fn() });

    // 其他标签页改动 / 导入 / 加载环境配置触发的刷新：存储里 'b' 还在
    await mgmt.fetchConfig();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'c']);

    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS);
    await mgmt.fetchConfig();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'c']);

    // 登记若没随提交注销，这一行从此再也显示不出来
    snapshot = { enabled: true, rules: ['a', 'b', 'c'].map(makeRule) };
    await mgmt.fetchConfig();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b', 'c']);
  });

  it('提交失败时行放回列表并报告，登记一起注销', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b', 'c']);
    await mgmt.fetchConfig();
    const failed = vi.fn();

    openDeleteUndo(['b', 'c'], {
      send: async () => {
        throw new Error('SW unavailable');
      },
      close: vi.fn(),
      failed,
    });
    expect(idsOf(mgmt.rules.value)).toEqual(['a']);

    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS);
    expect(failed).toHaveBeenCalledWith(2);
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b', 'c']);

    // 放回的行不能因为残留登记而再次隐形
    await mgmt.fetchConfig();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b', 'c']);
  });

  it('后台回 success:false 同样算失败，不能把「没删成」报成成功', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b']);
    await mgmt.fetchConfig();
    const failed = vi.fn();

    openDeleteUndo(['b'], { send: async () => ({ success: false }), close: vi.fn(), failed });

    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS);
    expect(failed).toHaveBeenCalledWith(1);
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b']);
  });
});

describe('[撤销窗口] 点撤销的那条路', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('撤销把多条按原位置放回，且一次删除消息都不发', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b', 'c', 'd', 'e']);
    await mgmt.fetchConfig();
    const send = vi.fn(async () => ({ success: true }));

    const win = openDeleteUndo(['b', 'd'], { send, close: vi.fn(), failed: vi.fn() });
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'c', 'e']);

    expect(win!.undo()).toBe(true);
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(send).not.toHaveBeenCalled();

    // 撤销之后定时器不能再起跑：窗口期内刷新一次，行也不该被提交掉
    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS + 10);
    expect(send).not.toHaveBeenCalled();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('提交之后再点撤销只得到「窗口已结束」，绝不本地插回假恢复', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b']);
    await mgmt.fetchConfig();
    snapshot = { enabled: true, rules: ['a'].map(makeRule) };

    const win = openDeleteUndo(['b'], { send: async () => ({ success: true }), close: vi.fn(), failed: vi.fn() });
    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS);

    expect(win!.undo()).toBe(false);
    expect(idsOf(mgmt.rules.value)).toEqual(['a']);
  });

  it('一个 id 都没抓到时不开窗口：不提交、不提示、也不清空登记', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a']);
    await mgmt.fetchConfig();
    const send = vi.fn(async () => ({ success: true }));
    const failed = vi.fn();

    const win = openDeleteUndo(['zzz'], { send, close: vi.fn(), failed });

    expect(win).toBeNull();
    expect(idsOf(mgmt.rules.value)).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS + 10);
    expect(send).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('快照是深拷贝：撤销回来的不是那个已被改过的响应式对象', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b']);
    await mgmt.fetchConfig();
    const original = mgmt.rules.value[1];

    const win = openDeleteUndo(['b'], { send: async () => ({ success: true }), close: vi.fn(), failed: vi.fn() });
    // 窗口期内原对象若被别处就地改动（例如另一条链路上的赋值），撤销回来的那份不该跟着变
    original.name = '改过的名字';

    win!.undo();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b']);
    expect(mgmt.rules.value[1].name).toBe('rule-b');
    expect(mgmt.rules.value[1]).not.toBe(original);
  });

  it('窗口期内列表被改短，放回时钳到末尾而不越界', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b', 'c']);
    await mgmt.fetchConfig();

    const win = openDeleteUndo(['c'], { send: async () => ({ success: true }), close: vi.fn(), failed: vi.fn() });
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b']);
    // 另一条已提交的删除把 'b' 也带走了（索引基准从此比列表长）
    mgmt.rules.value = mgmt.rules.value.filter(r => r.id !== 'b');

    win!.undo();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'c']);
  });
});

describe('[撤销窗口] 交错进行的多次删除', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('单条与批量各开各的窗口：撤销其中一个不影响另一个的提交', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b', 'c', 'd']);
    await mgmt.fetchConfig();
    const singleSend = vi.fn(async () => ({ success: true }));
    const batchSend = vi.fn(async () => ({ success: true }));

    const single = openDeleteUndo(['a'], { send: singleSend, close: vi.fn(), failed: vi.fn() });
    const batch = openDeleteUndo(['c', 'd'], { send: batchSend, close: vi.fn(), failed: vi.fn() });
    expect(idsOf(mgmt.rules.value)).toEqual(['b']);

    single!.undo();
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b']);
    expect(singleSend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS);
    expect(batchSend).toHaveBeenCalledTimes(1);
    expect(singleSend).not.toHaveBeenCalled();
    // 批量那条真的落库了，撤销它只会得到「窗口已结束」
    expect(batch!.undo()).toBe(false);
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b']);
  });

  it('两个批量窗口叠着提交时各自注销自己的登记', async () => {
    const { mgmt, openDeleteUndo } = setUp(['a', 'b', 'c', 'd']);
    await mgmt.fetchConfig();

    openDeleteUndo(['a'], { send: async () => ({ success: true }), close: vi.fn(), failed: vi.fn() });
    openDeleteUndo(['c'], { send: async () => ({ success: true }), close: vi.fn(), failed: vi.fn() });
    expect(idsOf(mgmt.rules.value)).toEqual(['b', 'd']);

    await vi.advanceTimersByTimeAsync(DELETE_UNDO_WINDOW_MS);
    snapshot = { enabled: true, rules: ['a', 'b', 'c', 'd'].map(makeRule) };
    await mgmt.fetchConfig();
    // 两笔都已落库，登记若没注销就会永远看不见 'a' 与 'c'
    expect(idsOf(mgmt.rules.value)).toEqual(['a', 'b', 'c', 'd']);
  });
});
