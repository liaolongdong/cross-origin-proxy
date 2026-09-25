/**
 * 批量启停：`storage.batchToggleRules` 与 `useRuleManagement.toggleAllRules`
 *
 * 这段覆盖原先抄在 `tests/bugfixes-and-features.test.ts` 里，那一支断的是
 * `rules.map(r => r.id)` 算出来的**测试自己的**数组——实现怎么改都不会红，已随整支文件删掉。
 * 删得对，但删完这一格就空了：`batchToggleRules` 的「一次写入」是它存在的全部理由
 * （逐条 `updateRule` 会变成 N 次落盘 + N 次 DNR 重建与广播），而 `toggleAllRules` 的
 * 「全部」指的是**整份规则集**，不是筛选后可见的那些——规则列表上方正带着搜索与筛选条件。
 * 两件事都没有界面，坏了也不抛错。
 *
 * 存储桩与 `storageLockCache.test.ts` 同一套语义：`get` 返回**深拷贝**（真实 Chrome 给的是
 * 反序列化副本）。少了它，测试就地改的正是 `store` 里那一份，「有没有落盘」就成了自证。
 * 界面侧的 `fetchConfig` 走的是消息而不是存储，所以它另有 `snapshot` 一份，两本账分开记。
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
/** `BATCH_TOGGLE_RULES` 的回包，失败用例就地换成信封 */
let batchReply: unknown = { success: true };
const sendMessage = vi.fn(async (message: { type: MessageType }): Promise<unknown> => {
  if (message.type === MessageType.GET_PROXY_CONFIG) return clone(snapshot);
  return batchReply;
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

const { batchToggleRules, invalidateConfigCache } = await import('@/utils/storage');
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
  batchReply = { success: true };
  setSpy.mockClear();
  sendMessage.mockClear();
  // 配置缓存在这份模块里是跨用例的：不失效就会读到上一条用例写进去的那份
  invalidateConfigCache();
});

describe('storage.batchToggleRules — 名单内翻转、名单外不动、只写一次', () => {
  it('只有名单里的规则被改写，非命中项连 updatedAt 都不抖', async () => {
    putConfig({
      enabled: true,
      rules: [makeRule('a'), makeRule('b', { updatedAt: 222 }), makeRule('c')],
    });

    await batchToggleRules(['b'], false);

    const stored = storedRules();
    expect(stored.map(r => [r.id, r.enabled])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
    // `updatedAt` 只跟着真正改了的那条走：全表刷一遍会让每次批量启停都像整库被动过
    expect(stored.find(r => r.id === 'b')?.updatedAt).not.toBe(222);
    expect(stored.find(r => r.id === 'a')?.updatedAt).toBe(111);
    expect(stored.find(r => r.id === 'c')?.updatedAt).toBe(111);
  });

  it('三个 id 只落一次盘（这是它取代逐条 updateRule 的理由）', async () => {
    putConfig({ enabled: true, rules: [makeRule('a'), makeRule('b'), makeRule('c')] });

    await batchToggleRules(['a', 'b', 'c'], false);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(storedRules().every(r => !r.enabled)).toBe(true);
  });

  it('名单里的未知 id 不报错、也不凭空多出一条规则', async () => {
    putConfig({ enabled: true, rules: [makeRule('a')] });

    await batchToggleRules(['a', 'ghost'], false);

    expect(storedRules().map(r => r.id)).toEqual(['a']);
    expect(storedRules()[0].enabled).toBe(false);
  });
});

describe('useRuleManagement.toggleAllRules — 工具栏那一下「全部启用 / 全部停用」', () => {
  // 本文件在组件实例外调用 composable，`onMounted` / `onUnmounted` 必然由 Vue 抱怨；
  // 只吞这两条，其余警告照常输出（与 `pendingDeleteUndo.test.ts` 同一处理）。
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

  it('「全部」= 整份规则集，一条消息、一次点击之后全都停下', async () => {
    const mgmt = useRuleManagement();
    await seed(mgmt, {
      enabled: true,
      rules: [makeRule('a'), makeRule('b', { enabled: false }), makeRule('c')],
    });

    await mgmt.toggleAllRules(false);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message] = sendMessage.mock.calls[0] as [{ type: MessageType; data: { enabled: boolean } }];
    expect(message.type).toBe(MessageType.BATCH_TOGGLE_RULES);
    expect(message.data.enabled).toBe(false);
    // 断的是「落点」而不是 `ruleIds` 的具体内容：真正会出事的是把这份列表换成筛选后可见的
    // 或选中的那几条（'c' 就停不下来）；而「只发还没到目标状态的那些」结果等价，不该红。
    expect(mgmt.rules.value.map(r => r.enabled)).toEqual([false, false, false]);
  });

  it('一条规则都没有时零消息：不给一次无谓的落盘与 DNR 重建', async () => {
    const mgmt = useRuleManagement();
    await seed(mgmt, { enabled: true, rules: [] });

    await mgmt.toggleAllRules(false);

    // 上面那条「有规则时会发一条」是这条的正向对照：没有它，这里断的空话永远成立
    expect(typesSent()).toEqual([]);
  });

  it('后台回失败信封时本地列表维持原样，并把错误抛给调用方', async () => {
    const mgmt = useRuleManagement();
    await seed(mgmt, { enabled: true, rules: [makeRule('a'), makeRule('b')] });
    batchReply = { success: false, error: 'BOOM' };

    await expect(mgmt.toggleAllRules(false)).rejects.toThrow('BOOM');

    // 消息发出去了，但存储没改：本地若跟着翻转，界面就画出一份存储里不存在的状态
    expect(typesSent()).toEqual([MessageType.BATCH_TOGGLE_RULES]);
    expect(mgmt.rules.value.map(r => r.enabled)).toEqual([true, true]);
  });
});
