/**
 * 自检那五笔读数按运行时测：部分失败时屏幕是什么形状
 *
 * 判据本身在 `tests/selfCheck.test.ts` 按「输入 → 答案」钉；这里钉的是**读数的装配**，
 * 而那一半只有跑起来才看得见：
 * 1. 一条消息抛错只该让那一行落到「没读到」，其余四行照常——整屏消失或全都画成正常，
 *    比少一行糟得多（面板存在的意义就是「哪一条不对」）。
 * 2. 回收期那封 `{ success: false }` 信封与抛错同档：形状不对就是没读到，不猜。
 * 3. 那一页读不到（标签页已关、`chrome://`）时不去问规则——「这一页没命中规则」是一句
 *    没被问过的问题。
 * 4. 迟到的那一轮不许盖掉最新那一轮。
 *
 * 本环境测不到的那半：弹窗与抽屉里的渲染与点击（无 jsdom），由真机探针补。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageType } from '@/utils/types';

// 桩就地写：`vi.mock` 会被提到文件最顶端，工厂里引用外层 const 会撞在初始化之前
vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sendMessage = vi.fn();
const tabsGet = vi.fn();
vi.stubGlobal('chrome', {
  runtime: { sendMessage },
  tabs: { get: tabsGet },
  // 这一层引 `utils/storage`（`configRules` 在那儿），它在模块加载时注册监听器
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
});

// 必须是**桩打完之后**的动态 import：静态 import 会被提到文件最顶端，
// 于是 `utils/storage` 那句模块级 `chrome.storage.onChanged.addListener` 撞在 stub 之前，
// 整个文件在跑第一条用例之前就 `ReferenceError: chrome is not defined`（与 `storageLockCache` 同一处理）。
const { useSelfCheck } = await import('@/composables/useSelfCheck');

const GOOD = {
  [MessageType.GET_PROXY_STATUS]: { enabled: true, activeRuleCount: 2, requestsViaExtension: 0 },
  [MessageType.GET_SITE_STATE]: { mode: 'all', hosts: [] },
  [MessageType.GET_DNR_INSTALL_STATE]: { readable: true, syncing: false, installed: 3, expected: 3 },
  [MessageType.GET_PROXY_CONFIG]: { enabled: true, rules: [] },
  [MessageType.GET_CONFIG_SYNC]: { synced: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockImplementation(async (message: { type: string }) => GOOD[message.type as keyof typeof GOOD] ?? null);
  tabsGet.mockResolvedValue({ url: 'https://fat.example.com/a' });
});

describe('一次完整的自检', () => {
  it('五笔各归各的位，网页标签页的地址也读回来了', async () => {
    const { readout, refresh } = useSelfCheck();
    await refresh(7);
    expect(readout.value).toMatchObject({
      reading: false,
      status: { enabled: true },
      siteState: { mode: 'all' },
      install: { readable: true, installed: 3 },
      configSynced: true,
      probeUrl: 'https://fat.example.com/a',
      host: 'fat.example.com',
    });
    expect(readout.value.rules).toEqual([]);
  });

  it('没有对应网页时不去问送达账、也不读任何标签页（那三行会是「不知道」，不是「正常」）', async () => {
    const { readout, refresh } = useSelfCheck();
    await refresh(null);
    expect(sendMessage.mock.calls.map(c => (c[0] as { type: string }).type)).not.toContain(MessageType.GET_CONFIG_SYNC);
    expect(tabsGet).not.toHaveBeenCalled();
    expect(readout.value.configSynced).toBeNull();
    expect(readout.value.probeUrl).toBe('');
  });
});

describe('部分失败', () => {
  it('一条消息抛错只让那一行没读到，其余四行照读', async () => {
    sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === MessageType.GET_SITE_STATE) throw new Error('recycled');
      return GOOD[message.type as keyof typeof GOOD] ?? null;
    });
    const { readout, refresh } = useSelfCheck();
    await refresh(7);
    expect(readout.value.siteState).toBeNull();
    expect(readout.value.status?.enabled).toBe(true);
    expect(readout.value.install?.expected).toBe(3);
    expect(readout.value.configSynced).toBe(true);
    expect(readout.value.reading).toBe(false);
  });

  it('回收期那种「不是答案的信封」与抛错同档：那一格算没读到，别的内容照常', async () => {
    sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === MessageType.GET_DNR_INSTALL_STATE) return { success: false, error: 'nope' };
      return GOOD[message.type as keyof typeof GOOD] ?? null;
    });
    const { readout, refresh } = useSelfCheck();
    await refresh(7);
    expect(readout.value.install).toBeNull();
    expect(readout.value.status).not.toBeNull();
  });

  it('规则集那一笔回了个没有 rules 的东西，整格算没读到（`[]` 与「没读到」是两句话）', async () => {
    sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === MessageType.GET_PROXY_CONFIG
        ? { enabled: true }
        : (GOOD[message.type as keyof typeof GOOD] ?? null),
    );
    const { readout, refresh } = useSelfCheck();
    await refresh(7);
    expect(readout.value.rules).toBeNull();
  });

  it('状态回包少了那条规则数时整格不算读到，不然开关那一行会说「启用规则 0 条」', async () => {
    sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === MessageType.GET_PROXY_STATUS
        ? { enabled: true }
        : (GOOD[message.type as keyof typeof GOOD] ?? null),
    );
    const { readout, refresh } = useSelfCheck();
    await refresh(7);
    expect(readout.value.status).toBeNull();
    // 其余四行不受牵连：这一格变成「不知道」不等于这一屏没读过
    expect(readout.value.install?.expected).toBe(3);
  });

  it('装载状态少了那两个数就不算读到：不然那一格会用 0 补出一句「0 对 0，一切正常」', async () => {
    sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === MessageType.GET_DNR_INSTALL_STATE
        ? { readable: true, syncing: false }
        : (GOOD[message.type as keyof typeof GOOD] ?? null),
    );
    const { readout, refresh } = useSelfCheck();
    await refresh(7);
    expect(readout.value.install).toBeNull();
    // 承重的是「只废那一格」：其余四行照常（这条与 `isStatus` 那一格是同一族判据）
    expect(readout.value.status?.activeRuleCount).toBe(2);
  });

  it('那一页读不到（标签页刚被关）时不猜地址，也不去问那笔问不出来的账', async () => {
    tabsGet.mockRejectedValue(new Error('No tab with id: 7'));
    const { readout, refresh } = useSelfCheck();
    await refresh(7);
    expect(readout.value.probeUrl).toBe('');
    expect(readout.value.host).toBe('');
    expect(readout.value.configSynced).toBeNull();
    expect(sendMessage.mock.calls.map(c => (c[0] as { type: string }).type)).not.toContain(MessageType.GET_CONFIG_SYNC);
  });

  it('那一页是扩展页 / `chrome://` 时同样不问送达账——那笔账从来没为它记过', async () => {
    tabsGet.mockResolvedValue({ url: `chrome-extension://abc/options.html` });
    const { readout, refresh } = useSelfCheck();
    await refresh(7);
    expect(readout.value.configSynced).toBeNull();
    expect(sendMessage.mock.calls.map(c => (c[0] as { type: string }).type)).not.toContain(MessageType.GET_CONFIG_SYNC);
    // 另四笔照常读到：这一格只是不能替一个不存在的页面说话
    expect(readout.value.status?.enabled).toBe(true);
  });

  it('那一页不是网页（`chrome://`、扩展页）时同样不问规则', async () => {
    tabsGet.mockResolvedValue({ url: 'chrome://extensions' });
    const { readout, refresh } = useSelfCheck();
    await refresh(7);
    expect(readout.value.probeUrl).toBe('');
    expect(readout.value.host).toBe('');
  });
});

describe('迟到那一轮不算数', () => {
  it('两轮同时在途时，屏幕上留的是后发起那一轮的读数', async () => {
    // 只挂起**第一笔** status：第二轮必须能整轮落定，否则这里测的是「两轮都卡住」而不是「迟到」。
    // 摘掉轮次令牌的后果是屏幕上挂着 A——一轮属于旧 tabId 的读数，而它下一行配的是新 tabId 的地址。
    let statusCalls = 0;
    // 用盒子而不是裸 `let`：TS 的控制流分析看不见闭包里的赋值，会把外层变量一直收窄成 `null`，
    // 于是 `release?.(…)` 那一句在类型上是「never 不可调用」——`tsc` 与 `vue-tsc` 都红，跑起来却是好的
    const held: { release: ((value: unknown) => void) | null } = { release: null };
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === MessageType.GET_PROXY_STATUS) {
        statusCalls += 1;
        if (statusCalls === 1) {
          return new Promise(resolve => {
            held.release = resolve;
          });
        }
        return Promise.resolve({ enabled: false, activeRuleCount: 0 });
      }
      return Promise.resolve(GOOD[message.type as keyof typeof GOOD] ?? null);
    });
    const { readout, refresh } = useSelfCheck();
    const first = refresh(1);
    await refresh(2);
    // 第一轮那笔迟到的回包说的是「开着」，与第二轮的「关着」可区分——同值就断不出谁盖了谁
    held.release?.({ enabled: true, activeRuleCount: 99 });
    await first;

    expect(statusCalls).toBe(2);
    expect(readout.value.status?.enabled).toBe(false);
    expect(readout.value.status?.activeRuleCount).toBe(0);
    expect(tabsGet).toHaveBeenCalledTimes(2);
  });
});
