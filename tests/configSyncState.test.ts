/**
 * E-d：配置广播的成败必须留下痕迹 —— 回答「这一页拿到最新配置了吗」
 *
 * 复杂规则靠 `tabs.sendMessage` 推给已打开的页面，推不到的那些标签页此前被 `Promise.allSettled`
 * 静默丢掉（扩展重载后、站点被禁用、chrome:// 页都是这种），于是「改完规则这个页没反应」
 * 只剩两种解释：要么用户以为自己没改对，要么去猜哪条规则有问题。现在把**确实没收到的 http(s)
 * 标签页**记成一笔仅内存的账，弹窗据此说一句话。
 *
 * 三件事各自钉：
 * 1. **账本身**（`entrypoints/background/configSyncState.ts`）——只记「已知没收到」，
 *    没记过就是「已同步」；上限、`tabs.onRemoved` 与导航清账。
 * 2. **记账时机**（`dnrManager.broadcastConfigToTabs`）——逐标签页看回执：收到即清账，
 *    收不到才记。非 http(s) 与还在加载的页**不参与**：前者永远收不到、刷新也没用，
 *    后者正处于「新文档自己会拉配置」的窗口期，记了就是一句假警告。
 * 3. **回执可信的前提**（源码契约）——桥接层必须对 `UPDATE_PROXY_CONFIG` 同步回一句话，
 *    否则「监听器没应答」与「没有监听器」在 sendMessage 的 promise 上没法区分，
 *    整条警告会退化成随机噪声。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONFIG_SYNC_TAB_CACHE_SIZE } from '@/utils/constants';
import { MessageType } from '@/utils/types';
import { isConfigSyncStatus } from '@/utils/configSync';
import type { ProxyConfig } from '@/utils/types';

type SyncMod = typeof import('@/entrypoints/background/configSyncState');

let removedHandlers: Array<(tabId: number) => void>;
let updatedHandlers: Array<(tabId: number, changeInfo: { status?: string }) => void>;
let sync: SyncMod;

/** 只装 `tabs` 事件源的最小 chrome：本模块不碰任何其它 API */
function stubTabEvents() {
  vi.stubGlobal('chrome', {
    tabs: {
      onRemoved: {
        addListener: vi.fn((fn: (tabId: number) => void) => removedHandlers.push(fn)),
      },
      onUpdated: {
        addListener: vi.fn((fn: (tabId: number, changeInfo: { status?: string }) => void) => updatedHandlers.push(fn)),
      },
    },
  });
}

beforeEach(async () => {
  removedHandlers = [];
  updatedHandlers = [];
  vi.resetModules();
  stubTabEvents();
  sync = await import('@/entrypoints/background/configSyncState');
  sync.setupConfigSyncState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('仅内存的「这一页没收到配置」账', () => {
  it('没被记过的标签页一律算已同步：不知道不等于有问题', () => {
    expect(sync.isConfigUnsynced(1)).toBe(false);
  });

  it('记为未同步后读得到，重复记同一页不叠加', () => {
    sync.markConfigUnsynced(1);
    sync.markConfigUnsynced(1);
    expect(sync.isConfigUnsynced(1)).toBe(true);
  });

  it('该页后来收到了配置就清账', () => {
    sync.markConfigUnsynced(1);
    sync.clearConfigUnsynced(1);
    expect(sync.isConfigUnsynced(1)).toBe(false);
  });

  it('清账只认 loading（新文档会自己去拉配置），complete 不是新文档的信号', () => {
    sync.markConfigUnsynced(1);
    updatedHandlers.forEach(fn => fn(1, { status: 'complete' }));
    expect(sync.isConfigUnsynced(1)).toBe(true);

    updatedHandlers.forEach(fn => fn(1, { status: 'loading' }));
    expect(sync.isConfigUnsynced(1)).toBe(false);
  });

  it('关闭标签页清账', () => {
    sync.markConfigUnsynced(3);
    removedHandlers.forEach(fn => fn(3));
    expect(sync.isConfigUnsynced(3)).toBe(false);
  });

  it('超过上限逐出最早记下的那页：漏事件也不无界增长', () => {
    for (let tabId = 1; tabId <= CONFIG_SYNC_TAB_CACHE_SIZE; tabId++) sync.markConfigUnsynced(tabId);
    sync.markConfigUnsynced(CONFIG_SYNC_TAB_CACHE_SIZE + 1);

    expect(sync.isConfigUnsynced(1)).toBe(false);
    expect(sync.isConfigUnsynced(2)).toBe(true);
    expect(sync.isConfigUnsynced(CONFIG_SYNC_TAB_CACHE_SIZE + 1)).toBe(true);
  });

  it('这个模块不碰 storage、不碰配置写入', async () => {
    const src = readFileSync('entrypoints/background/configSyncState.ts', 'utf-8');
    expect(src).not.toContain('chrome.storage');
    expect(src).not.toContain('STORAGE_KEYS');
    expect(src).not.toContain('saveProxyConfig');
  });
});

// ─── 广播侧的记账 ───────────────────────────────────────────────────────────

const COMPLEX_RULE = {
  id: 'complex',
  name: 'complex',
  enabled: true,
  matchPattern: 'https://fat.example.com/api/*',
  targetUrl: 'https://uat.example.com/api',
  matchType: 'wildcard',
  headerOverrides: { Authorization: 'Bearer x' },
  priority: 10,
  createdAt: 0,
  updatedAt: 0,
};

const SIMPLE_RULE = {
  ...COMPLEX_RULE,
  id: 'simple',
  name: 'simple',
  headerOverrides: undefined,
  matchPattern: 'https://fat.example.com/other/*',
  targetUrl: 'https://uat.example.com/other',
};

const CONFIG = { enabled: true, rules: [COMPLEX_RULE, SIMPLE_RULE] } as unknown as ProxyConfig;

interface FakeTab {
  id: number;
  url: string;
  status: string;
}

let queryImpl: () => Promise<FakeTab[]>;
let sendMessageCalls: number[];
let rejectTabs: Set<number>;
let pendingTabs: Set<number>;
let releasePending: Array<() => void>;
let broadcastConfigToTabs: (config: ProxyConfig) => Promise<void>;
let broadcastSync: SyncMod;

beforeEach(async () => {
  queryImpl = async () => [];
  sendMessageCalls = [];
  rejectTabs = new Set();
  pendingTabs = new Set();
  releasePending = [];
  vi.resetModules();
  // 这一节只测记账，不测生命周期，因此 `setupConfigSyncState()` 刻意不调用
  broadcastSync = await import('@/entrypoints/background/configSyncState');
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(() => queryImpl()),
      sendMessage: vi.fn(async (tabId: number) => {
        sendMessageCalls.push(tabId);
        if (rejectTabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
        // 挂住的标签页模拟「别的页面还没回执」：allSettled 要等它，这段时间里
        // 已失败的那一页完全可能已经刷新完并自己拉过配置。
        if (pendingTabs.has(tabId)) await new Promise<void>(resolve => releasePending.push(resolve));
        return { received: true };
      }),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn() }, onChanged: { addListener: vi.fn() } },
    runtime: { getURL: () => 'chrome-extension://test/' },
  });
  const dnr = await import('@/entrypoints/background/dnrManager');
  broadcastConfigToTabs = dnr.broadcastConfigToTabs;
});

describe('广播逐标签页记账', () => {
  const httpTab = (id: number): FakeTab => ({ id, url: 'https://fat.example.com/app', status: 'complete' });

  it('页面接住了配置：清掉它之前的未同步标记', async () => {
    queryImpl = async () => [httpTab(1)];
    broadcastSync.markConfigUnsynced(1);
    await broadcastConfigToTabs(CONFIG);
    expect(broadcastSync.isConfigUnsynced(1)).toBe(false);
  });

  it('http 页收不到：记为未同步', async () => {
    queryImpl = async () => [httpTab(1)];
    rejectTabs = new Set([1]);
    await broadcastConfigToTabs(CONFIG);
    expect(broadcastSync.isConfigUnsynced(1)).toBe(true);
  });

  it('非 http(s) 页与还在加载的页不发消息、也不记账', async () => {
    queryImpl = async () => [
      { id: 2, url: 'chrome://extensions', status: 'complete' },
      { id: 3, url: 'https://fat.example.com/app', status: 'loading' },
      { id: 4, url: 'chrome-extension://other/ext.html', status: 'complete' },
    ];
    rejectTabs = new Set([2, 3, 4]);
    await broadcastConfigToTabs(CONFIG);
    expect(sendMessageCalls).toEqual([]);
    expect([2, 3, 4].map(id => broadcastSync.isConfigUnsynced(id))).toEqual([false, false, false]);
  });

  it('一页失败不连带其它页：各记各的账', async () => {
    queryImpl = async () => [httpTab(1), httpTab(5), httpTab(6)];
    rejectTabs = new Set([5]);
    await broadcastConfigToTabs(CONFIG);
    expect(sendMessageCalls).toEqual([1, 5, 6]);
    expect(broadcastSync.isConfigUnsynced(1)).toBe(false);
    expect(broadcastSync.isConfigUnsynced(5)).toBe(true);
    expect(broadcastSync.isConfigUnsynced(6)).toBe(false);
  });

  it('广播期间那一页刷新了：别把已经复位的新文档又记成「没送达」', async () => {
    // 真实时序是这样的：老文档被销毁 → 它的推送回执 reject → 新文档开始加载并清账 →
    // 最后才是「最慢的那个标签页」结算。如果记账等到 allSettled 全部落定才统一做，
    // 中间那步清账就会被后面的标记盖掉，于一句凭空多出来的假警告。
    // 钉住的是「先标记、后清账」这一支；reject 晚于清账的另一支没有兜底，
    // 已作为待确认点写在 dnrManager.broadcastConfigToTabs 的注释里，别把这条当成它也有覆盖。
    queryImpl = async () => [httpTab(1), httpTab(7)];
    rejectTabs = new Set([1]);
    pendingTabs = new Set([7]);

    const running = broadcastConfigToTabs(CONFIG);
    await new Promise(resolve => setTimeout(resolve, 0));
    broadcastSync.clearConfigUnsynced(1); // 新文档：导航复位 + 自己拉到了配置
    releasePending.forEach(release => release());
    await running;

    expect(broadcastSync.isConfigUnsynced(1)).toBe(false);
  });

  it('广播整体不抛：这条路径在 storage.onChanged 里没有接手的人', async () => {
    queryImpl = async () => {
      throw new Error('tabs unavailable');
    };
    await expect(broadcastConfigToTabs(CONFIG)).resolves.toBeUndefined();
  });
});

// ─── 源码契约 ───────────────────────────────────────────────────────────────

const bridgeSrc = readFileSync('entrypoints/content.ts', 'utf-8');
const popupSrc = readFileSync('entrypoints/popup/App.vue', 'utf-8');

describe('源码契约：回执、门禁与那一行的闸门', () => {
  it('桥接层对接到的配置同步要同步回执，否则 resolve/reject 说不清有没有送达', () => {
    const start = bridgeSrc.indexOf('chrome.runtime.onMessage.addListener', bridgeSrc.indexOf('postSyncRules(config)'));
    expect(start).toBeGreaterThan(-1);
    const block = bridgeSrc.slice(start, bridgeSrc.indexOf('// Initial sync', start));
    expect(block).toContain('MessageType.UPDATE_PROXY_CONFIG');
    expect(block).toContain('sendResponse');
    // 回执只说「收到了」，不回任何配置内容
    expect(block).not.toContain('data:');
  });

  it('GET_CONFIG_SYNC 不得进任何 gate 清单：它是 popup 的只读，加了就永远读不到', () => {
    const routerSrc = readFileSync('entrypoints/background/messageRouter.ts', 'utf-8');
    const mutatingAt = routerSrc.indexOf('const STATE_MUTATING_TYPES');
    const readingAt = routerSrc.indexOf('const CREDENTIAL_READING_TYPES');
    const respondAt = routerSrc.indexOf('function respondAsync');
    expect(mutatingAt).toBeGreaterThan(-1);
    expect(readingAt).toBeGreaterThan(mutatingAt);
    expect(respondAt).toBeGreaterThan(readingAt);
    expect(routerSrc.slice(mutatingAt, respondAt)).not.toContain('GET_CONFIG_SYNC');
  });

  it('那一行只在「确实读到过、且读到没同步」时出现', () => {
    const start = popupSrc.indexOf('const configSyncVisible = computed(');
    expect(start).toBeGreaterThan(-1);
    const body = popupSrc.slice(start, popupSrc.indexOf('\n);', start));
    // 四道闸门缺一不可，方向也钉死：把 `configUnsynced` 取反就是逢页必警告，
    // 漏掉 `configSyncFetched` 则每次打开弹窗先闪一句「没同步」再消失。
    expect(body).toContain(
      'enabled.value && pageHitProxiable.value && configSyncFetched.value && configUnsynced.value',
    );
  });

  it('读取只接受结构完整的回执，失败信封不得覆盖已有判断', () => {
    const start = popupSrc.indexOf('async function fetchTabConfigSync');
    expect(start).toBeGreaterThan(-1);
    const body = popupSrc.slice(start, popupSrc.indexOf('\n}', start));
    expect(body).toContain('isConfigSyncStatus(');
    // 闸门要的是「读到过一回有效的账」，不是「收到过任意一个回包」：
    // 判据排在闸门之前，形状不完整的回包连门都推不开。
    expect(body.indexOf('configSyncFetched.value = true')).toBeGreaterThan(body.indexOf('isConfigSyncStatus('));
    expect(body).not.toContain('configUnsynced.value = false');
  });
});

describe('读取端判据', () => {
  it('只认带布尔 synced 的回执', () => {
    expect(isConfigSyncStatus({ synced: true })).toBe(true);
    expect(isConfigSyncStatus({ synced: false })).toBe(true);
    for (const bad of [null, undefined, {}, { synced: 'false' }, { success: false }, 0, 'synced']) {
      expect(isConfigSyncStatus(bad)).toBe(false);
    }
  });

  it('消息类型有值且与枚举名一致（popup 与 SW 各自按字面量序列化）', () => {
    expect(MessageType.GET_CONFIG_SYNC).toBe('GET_CONFIG_SYNC');
  });
});

/**
 * 那句警告的修法入口（2026-10-20 补）：这一行本来就是全弹窗唯一一句
 * 「你现在做一件事就能解决」的话，所以它旁边必须真的有一个能按的东西。
 * 钉的是三件会静默坏掉的事：读不到标签页却画出一个必然失败的按钮；
 * 失败路径不出声；以及这个新入口悄悄长出别的副作用（写存储、发消息）。
 */
describe('[弹窗] 那句「刷新这一页」现在按得动', () => {
  const popup = readFileSync('entrypoints/popup/App.vue', 'utf8');
  const handler = popup.slice(popup.indexOf('async function reloadCurrentTab'));
  const body = handler.slice(0, handler.indexOf('\n}\n'));

  it('按钮是原生 button、带图标，且只在真的拿到标签页 id 时出现', () => {
    const row = popup.slice(popup.indexOf('class="config-sync-row"'));
    // 压平空白再比：prettier 会把属性折成一行一个，按原始行匹配等于把断言绑在格式上。
    // 属性也不按顺序断言——这一格要钉的是「有什么」，不是「谁写在谁前面」
    const block = row.slice(0, row.indexOf('</div>')).replace(/\s+/g, ' ');
    const btn = block.match(/<button[^>]*>/)?.[0] ?? '';
    expect(btn, '这一格要的是真按钮，不是又一个 div role=button').toContain('type="button"');
    expect(btn).toContain('class="config-sync-reload"');
    expect(btn, '读不到标签页就不该出现一个必然失败的按钮').toContain('v-if="activeTabId !== null"');
    expect(block).toContain('<el-icon><Refresh /></el-icon>');
    expect(block, '可见文案不许写死').toContain("t('configNotSyncedReload')");
  });

  it('没拿到 id 时不出静默按钮，而是明确说一句失败（两条失败面都出声）', () => {
    expect(body).toContain("typeof tabId !== 'number'");
    expect(body.match(/configNotSyncedReloadFailed/g)?.length, '早退与 catch 各要提示一次').toBe(2);
    expect(body).toContain('catch (error)');
  });

  it('这个入口只做一件事：调一次 tabs.reload，不写存储、不发 runtime 消息', () => {
    expect(body.match(/chrome\.tabs\.reload/g)?.length).toBe(1);
    expect(body).not.toContain('storage');
    expect(body).not.toContain('sendMessage');
  });

  it('热区按自己那几条声明算得回 24px 下限（不靠改口径的声明凑）', () => {
    const start = popup.indexOf('.config-sync-reload {');
    expect(start, '这条规则不在了').toBeGreaterThanOrEqual(0);
    const rule = popup.slice(start, popup.indexOf('}', start));
    // 与 tests/docs-consistency.test.ts 同一个前提：popup 的样式里那条「改口径」的声明一次都没有，
    // 所以高度只能由内容盒 + padding + 边框凑出来。凑不够就是热区塌到 24 以下——
    // 这一条是真机量出来之后补的：padding 收小一档（4 → 3）时它是 23.4px，而界面上什么都看不出来
    expect(rule, '这一格不许换口径').not.toMatch(/box-sizing/);
    expect(rule, '下限由 padding 凑，不许用 min-height 顶').not.toMatch(/min-height/);
    const numOf = (re: RegExp) => Number(re.exec(rule)?.[1]);
    const fontSize = numOf(/font-size:\s*(\d+(?:\.\d+)?)px/);
    const lineHeight = numOf(/line-height:\s*(\d+(?:\.\d+)?)(?!px)/);
    const paddingY = numOf(/padding:\s*(\d+(?:\.\d+)?)px/);
    const borderY = numOf(/border:\s*(\d+(?:\.\d+)?)px\s+solid/);
    expect([fontSize, lineHeight, paddingY, borderY], '那几条声明读不出来，本条算式要跟着改').not.toContain(NaN);
    expect(fontSize * lineHeight + paddingY * 2 + borderY * 2, '热区低于 24px 下限').toBeGreaterThanOrEqual(24);
  });
});
