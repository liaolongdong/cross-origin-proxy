/**
 * 拖拽排序：`storage.reorderRules` 与 `useRuleManagement.reorderRules`
 *
 * 排序是把整份 `rules` 数组换掉的写入：少东西不是它的预期，所以「按名单重排」的名单一旦不全，
 * 差额去哪一侧就是数据丢失与幂等兜底的分界。
 * 存储层选了「补到末尾」，而 `useRuleManagement` 里那份本地同步是**同一段逻辑的第二份副本**
 * （SW 才是事实来源，本地那份只负责在 `storage.onChanged` 回灌之前不闪回旧顺序）——
 * 两份各有一道兜底，方向必须一致，否则界面画一个顺序、DNR 按另一个顺序生效。
 * 这两件事都没有界面提示，坏了也不抛错。
 *
 * 存储桩与 `batchToggle.test.ts`、`storageLockCache.test.ts` 同一套语义：`get` 返回**深拷贝**
 * （真实 Chrome 给的是反序列化副本）。少了它，就地改的正是 `store` 里那一份，「有没有落盘」成了自证。
 * 界面侧走消息而不是存储，所以另有 `snapshot` 一份，两本账分开记。
 *
 * 刻意没断的两处：`updatedAt`（界面不读它，它跟着写走只是既有约定）；`orderedIds` 里
 * 那个 `typeof id === 'string'` 过滤（变异 R4 实测把它换成「原样接过名单」不改变任何可观察结果——
 * 非字符串 id 与陌生 id 走的是同一条路，`byId.get()` 认不出来就被跳过，剩下的规则由兜底接手，
 * 所以这里不写断言去假装它承重）。
 *
 * 有一条是**现状记录**，不是验收：名单里重复的 id 会把同一条规则写两遍，与「少了谁补谁」那侧
 * 恰好相反。今天从界面到不了这一步（`App.vue` 传的是 `newFull.map(r => r.id)`，每项来自不同的规则
 * 对象），要收口就在两处副本各加一次去重——那属于新增防御，先记不修。修的时候这条会红，
 * 请连同这段一起更新，别只删断言。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STORAGE_KEYS } from '@/utils/constants';
import { MessageType } from '@/utils/types';
import type { ProxyConfig, ProxyRule } from '@/utils/types';

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

let store: Record<string, unknown> = {};
const setSpy = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
  for (const [key, value] of Object.entries(items)) store[key] = clone(value);
});

/** 回给 `fetchConfig` 的那份配置（界面侧读存储只能经消息，这里给一份可摆的快照） */
let snapshot: ProxyConfig = { enabled: true, rules: [] };
/** `REORDER_RULES` 的回包，失败用例就地换成信封 */
let reorderReply: unknown = { success: true };
const sendMessage = vi.fn(async (message: { type: MessageType }): Promise<unknown> => {
  if (message.type === MessageType.GET_PROXY_CONFIG) return clone(snapshot);
  return reorderReply;
});

vi.stubGlobal('chrome', {
  runtime: { id: 'test-extension', sendMessage },
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[] | null) => {
        const names =
          keys === undefined || keys === null ? Object.keys(store) : typeof keys === 'string' ? [keys] : keys;
        const result: Record<string, unknown> = {};
        for (const name of names) if (name in store) result[name] = clone(store[name]);
        return result;
      }),
      set: setSpy,
    },
    onChanged: { addListener: vi.fn() },
  },
});

const { reorderRules, invalidateConfigCache } = await import('@/utils/storage');
const { useRuleManagement } = await import('@/composables/useRuleManagement');

function makeRule(id: string, overrides: Partial<ProxyRule> = {}): ProxyRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    matchPattern: `https://api.${id}.com/*`,
    targetUrl: 'https://target.example.com',
    matchType: 'wildcard',
    priority: 10,
    createdAt: 0,
    updatedAt: 111,
    ...overrides,
  };
}

/** 直接摆进「存储」，不经门面，免得写入顺带把我们要断的那份缓存换掉 */
function putConfig(config: ProxyConfig): void {
  store[STORAGE_KEYS.PROXY_CONFIG] = clone(config);
}

function storedRules(): ProxyRule[] {
  return (store[STORAGE_KEYS.PROXY_CONFIG] as ProxyConfig).rules;
}

beforeEach(() => {
  store = {};
  snapshot = { enabled: true, rules: [] };
  reorderReply = { success: true };
  setSpy.mockClear();
  sendMessage.mockClear();
  // 配置缓存在这份模块里是跨用例的：不失效就会读到上一条用例写进去的那份
  invalidateConfigCache();
});

describe('storage.reorderRules — 新顺序与 priority 一起落盘', () => {
  it('按 orderedIds 重排，priority 跟着新位置重写', async () => {
    putConfig({ enabled: true, rules: [makeRule('a'), makeRule('b'), makeRule('c')] });

    await reorderRules(['c', 'a', 'b']);

    const stored = storedRules();
    expect(stored.map(r => r.id)).toEqual(['c', 'a', 'b']);
    // 生效顺序看的是 `priority`，只换数组不换它就是拖了个寂寞
    expect(stored.map(r => r.priority)).toEqual([1, 2, 3]);
  });

  it('名单没提到的规则补在末尾，而不是被丢掉', async () => {
    putConfig({ enabled: true, rules: [makeRule('a'), makeRule('b'), makeRule('c')] });

    await reorderRules(['c']);

    expect(storedRules().map(r => r.id)).toEqual(['c', 'a', 'b']);
    expect(storedRules().map(r => r.priority)).toEqual([1, 2, 3]);
  });

  it('名单全是陌生 id：一条规则都不会少', async () => {
    putConfig({ enabled: true, rules: [makeRule('a'), makeRule('b')] });

    await reorderRules(['x', 'y']);

    expect(storedRules().map(r => r.id)).toEqual(['a', 'b']);
    expect(storedRules().map(r => r.priority)).toEqual([1, 2]);
  });

  it('一次拖拽只落一次盘（每次落盘都是一轮 DNR 重建与全标签页广播）', async () => {
    putConfig({ enabled: true, rules: [makeRule('a'), makeRule('b'), makeRule('c')] });

    await reorderRules(['c', 'b', 'a']);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(storedRules().map(r => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('现状记录：名单里重复的 id 会把同一条规则写两遍', async () => {
    putConfig({ enabled: true, rules: [makeRule('a'), makeRule('b')] });

    await reorderRules(['a', 'a']);

    // 「少了谁」有兜底，「重复点名」没有：同一个规则对象被 push 两次，所以那两行不是两份数据、
    // 而是同一个对象的两个位置——priority 取后一次的位置，画出来就是 2 与 2。
    // 今天界面到不了这一步（`App.vue` 传的是 `newFull.map(r => r.id)`，每项来自不同对象）。
    expect(storedRules().map(r => r.id)).toEqual(['a', 'a', 'b']);
    expect(storedRules().map(r => r.priority)).toEqual([2, 2, 3]);
  });
});

describe('useRuleManagement.reorderRules — 界面那一下拖拽', () => {
  // 本文件在组件实例外调用 composable，`onMounted` / `onUnmounted` 必然由 Vue 抱怨；
  // 只吞这两条，其余警告照常输出（与 `batchToggle.test.ts` 同一处理）。
  const nativeWarn = console.warn;
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const head = String(args[0]);
      if (head.startsWith('[Vue warn]: onMounted') || head.startsWith('[Vue warn]: onUnmounted')) return;
      nativeWarn.apply(console, args);
    });
  });

  const typesSent = () => sendMessage.mock.calls.map(call => (call[0] as { type: MessageType }).type);

  /** 摆快照 → 拉一次配置 → 清零消息流水：`fetchConfig` 自己也发一条，不清零就成了下面几条的噪声 */
  async function seed(mgmt: ReturnType<typeof useRuleManagement>, config: ProxyConfig) {
    snapshot = config;
    await mgmt.fetchConfig();
    sendMessage.mockClear();
  }

  it('一条消息，本地列表跟着新顺序与新的 priority 走', async () => {
    const mgmt = useRuleManagement();
    await seed(mgmt, { enabled: true, rules: [makeRule('a'), makeRule('b'), makeRule('c')] });

    await mgmt.reorderRules(['b', 'c', 'a']);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(typesSent()).toEqual([MessageType.REORDER_RULES]);
    expect(mgmt.rules.value.map(r => r.id)).toEqual(['b', 'c', 'a']);
    expect(mgmt.rules.value.map(r => r.priority)).toEqual([1, 2, 3]);
  });

  it('本地那份的兜底与存储那份同向：名单少了谁，谁排到末尾', async () => {
    const mgmt = useRuleManagement();
    await seed(mgmt, { enabled: true, rules: [makeRule('a'), makeRule('b'), makeRule('c')] });

    await mgmt.reorderRules(['c']);

    // 与上面存储层那组断的是同一个方向。两份副本只要有一侧改了顺序规则，
    // 界面就会画出存储层没有的那个顺序，直到下一次 `storage.onChanged` 回灌才被纠正。
    expect(mgmt.rules.value.map(r => r.id)).toEqual(['c', 'a', 'b']);
    expect(mgmt.rules.value.map(r => r.priority)).toEqual([1, 2, 3]);
  });

  it('后台回失败信封时本地顺序不动，并把错误抛给调用方', async () => {
    const mgmt = useRuleManagement();
    await seed(mgmt, { enabled: true, rules: [makeRule('a'), makeRule('b')] });
    reorderReply = { success: false, error: 'BOOM' };

    await expect(mgmt.reorderRules(['b', 'a'])).rejects.toThrow('BOOM');

    // 消息发了但存储没改：本地若跟着换序，表格画的就是一个被拒绝的顺序
    expect(typesSent()).toEqual([MessageType.REORDER_RULES]);
    expect(mgmt.rules.value.map(r => r.id)).toEqual(['a', 'b']);
    expect(mgmt.rules.value.map(r => r.priority)).toEqual([10, 10]);
  });
});
