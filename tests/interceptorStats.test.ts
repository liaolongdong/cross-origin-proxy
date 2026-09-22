/**
 * 批次 C：拦截器自报计数（「这一页到底有没有被拦」）
 *
 * 三件事各自最容易坏在别处，所以分开钉：
 * 1. **SW 侧落脚点**（`entrypoints/background/interceptorStats.ts`）——交叉校验、整包丢弃、
 *    生命周期清理与缓存上限。这里的关键是「自相矛盾的假包盖不掉真读数」：四个数页面可伪造，
 *    唯一不受页面影响的基准是 SW 自己数到的 `PROXY_REQUEST`，所以校验只有两道：包内必须自洽
 *    （`intercepted` 是另外三个数的父集、全 0 没有信息量），且不得低于那条基线。
 * 2. **界面判据**（`utils/interceptorStats.ts` 与 popup 那一行）——五种状态必须各有各的说法。
 *    把它们合并成一句「无数据」就是本批次要消灭的那类谎报（与 `describeDnrSample` 同一教训）。
 * 3. **MAIN world 计数点**——那个 world 自包含、无法 import，只能用源码契约守住：
 *    计数必须紧邻既有回退分支，且绝不参与控制流（计数坏了也不能影响用户的请求）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { INTERCEPTOR_TAB_CACHE_SIZE } from '@/utils/constants';
import { describeInterceptorStats, isInterceptorStatsEntry } from '@/utils/interceptorStats';
import type { InterceptorStatsEntry } from '@/utils/types';

type Mod = typeof import('@/entrypoints/background/interceptorStats');

const START = new Date(2026, 8, 20, 12, 0, 0).getTime();

let mod: Mod;
let removedHandlers: Array<(tabId: number) => void>;
let updatedHandlers: Array<(tabId: number, changeInfo: { status?: string }) => void>;

/** 一条「与基准不矛盾」的自报读数，按需覆盖单个字段即可 */
function reported(overrides: Partial<InterceptorStatsEntry> = {}) {
  return { intercepted: 5, proxied: 3, fellBack: 0, timedOut: 0, ...overrides };
}

beforeEach(async () => {
  removedHandlers = [];
  updatedHandlers = [];
  // 假时钟只为了钉住 `updatedAt`：本模块自己不起定时器
  vi.useFakeTimers();
  vi.setSystemTime(START);
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

  vi.resetModules();
  mod = await import('@/entrypoints/background/interceptorStats');
  mod.setupInterceptorStats();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('采信与丢弃', () => {
  it('合法读数被采信，并记下 SW 收到它的时刻', () => {
    expect(mod.recordInterceptorStats(1, reported())).toBe(true);
    expect(mod.getInterceptorStats(1)).toEqual({ ...reported(), updatedAt: START, swProxied: 0 });
  });

  it('无数据的标签页读回 null，而不是全 0 的假读数', () => {
    expect(mod.getInterceptorStats(99)).toBeNull();
  });

  it('没有 tabId（非内容脚本来源）时不记录', () => {
    expect(mod.recordInterceptorStats(undefined, reported())).toBe(false);
    expect(mod.getInterceptorStats(1)).toBeNull();
  });

  const badPayloads: Array<[string, unknown]> = [
    ['null', null],
    ['字符串', '5'],
    ['数组', [1, 2, 3, 4]],
    ['缺字段', { intercepted: 1, proxied: 1, fellBack: 0 }],
    ['负数', reported({ fellBack: -1 })],
    ['NaN', reported({ timedOut: Number.NaN })],
    ['Infinity', reported({ intercepted: Number.POSITIVE_INFINITY })],
    ['字符串数字', reported({ proxied: '3' as unknown as number })],
  ];

  for (const [label, payload] of badPayloads) {
    it(`载荷${label}：整包丢弃，不写出半成品`, () => {
      expect(mod.recordInterceptorStats(1, payload)).toBe(false);
      expect(mod.getInterceptorStats(1)).toBeNull();
    });
  }

  it('非法包不得盖掉已有的真读数', () => {
    mod.recordInterceptorStats(1, reported());
    expect(mod.recordInterceptorStats(1, reported({ proxied: -9 }))).toBe(false);
    expect(mod.getInterceptorStats(1)?.proxied).toBe(3);
  });

  it('小数向下取整（页面写 2.7 就记 2，不因此整包作废）', () => {
    mod.recordInterceptorStats(1, reported({ intercepted: 5.7 }));
    expect(mod.getInterceptorStats(1)?.intercepted).toBe(5);
  });
});

describe('与 SW 侧代发数交叉校验', () => {
  it('自报的代发数小于 SW 数到的基准 → 丢弃整包', () => {
    mod.countProxyRequestForTab(1);
    mod.countProxyRequestForTab(1);
    expect(mod.recordInterceptorStats(1, reported({ proxied: 1, intercepted: 5 }))).toBe(false);
    expect(mod.getInterceptorStats(1)).toEqual({
      intercepted: 0,
      proxied: 0,
      fellBack: 0,
      timedOut: 0,
      updatedAt: 0,
      swProxied: 2,
    });
  });

  it('等于基准即采信（页面可以先代发、后上报）', () => {
    mod.countProxyRequestForTab(1);
    mod.countProxyRequestForTab(1);
    expect(mod.recordInterceptorStats(1, reported({ proxied: 2, intercepted: 2 }))).toBe(true);
    expect(mod.getInterceptorStats(1)?.swProxied).toBe(2);
  });

  it('拦到数小于基准也丢（只违反基线、包内自洽的包）', () => {
    mod.countProxyRequestForTab(1);
    mod.countProxyRequestForTab(1);
    expect(mod.recordInterceptorStats(1, reported({ intercepted: 1, proxied: 1 }))).toBe(false);
  });

  it('包内自相矛盾的包整包拒收，基线为 0 也拒', () => {
    // 诚实路径发不出这些包（`bump('intercepted')` 在命中处，另外三个数都在其后），
    // 所以能发出来的只有同页脚本——而画出的句子本身就是一句谎话。
    expect(mod.recordInterceptorStats(1, reported({ intercepted: 0, proxied: 9, fellBack: 0 }))).toBe(false);
    expect(mod.recordInterceptorStats(1, reported({ intercepted: 2, proxied: 2, fellBack: 5 }))).toBe(false);
    expect(mod.recordInterceptorStats(1, reported({ intercepted: 3, proxied: 1, timedOut: 4 }))).toBe(false);
    expect(mod.getInterceptorStats(1)).toBeNull();
  });

  it('四个数全 0 的包不采信，也盖不掉上一条真读数', () => {
    mod.recordInterceptorStats(1, reported({ intercepted: 3, proxied: 2, fellBack: 1 }));
    expect(mod.recordInterceptorStats(1, { intercepted: 0, proxied: 0, fellBack: 0, timedOut: 0 })).toBe(false);
    const kept = mod.getInterceptorStats(1);
    expect(kept?.fellBack).toBe(1);
    // 全 0 包若被采信，界面会画成绿色的「拦到 0 个请求」——那正是「把不知道当没有」的谎报
    expect(describeInterceptorStats({ ...kept!, updatedAt: START, swProxied: 0 }).state).toBe('fellBack');
  });

  it('采信之后基准数继续累加，供下一次校验', () => {
    mod.countProxyRequestForTab(1);
    mod.recordInterceptorStats(1, reported({ proxied: 1, intercepted: 1 }));
    mod.countProxyRequestForTab(1);
    expect(mod.recordInterceptorStats(1, reported({ proxied: 1, intercepted: 9 }))).toBe(false);
    expect(mod.recordInterceptorStats(1, reported({ proxied: 2, intercepted: 9 }))).toBe(true);
    expect(mod.getInterceptorStats(1)?.swProxied).toBe(2);
  });

  it('没有 tabId 的代发请求不建状态（popup 自己发的消息不该变成基准）', () => {
    mod.countProxyRequestForTab(undefined);
    expect(mod.getInterceptorStats(1)).toBeNull();
  });
});

describe('生命周期与容量', () => {
  it('标签页关闭即丢读数', () => {
    mod.recordInterceptorStats(1, reported());
    removedHandlers.forEach(fn => fn(1));
    expect(mod.getInterceptorStats(1)).toBeNull();
  });

  it('导航中的标签页读数清零（新文档的计数从 0 起，基准也必须跟着起）', () => {
    mod.countProxyRequestForTab(1);
    mod.recordInterceptorStats(1, reported({ proxied: 1, intercepted: 1 }));
    updatedHandlers.forEach(fn => fn(1, { status: 'loading' }));
    expect(mod.getInterceptorStats(1)).toBeNull();
    // 基准一并复位：不清就会把新文档第一次上报全部判成矛盾
    expect(mod.recordInterceptorStats(1, reported({ proxied: 1, intercepted: 1 }))).toBe(true);
  });

  it('非 loading 的变更不得清读数（favIconUrl / title 之类同样会回调）', () => {
    mod.recordInterceptorStats(1, reported());
    updatedHandlers.forEach(fn => fn(1, { status: 'complete' }));
    updatedHandlers.forEach(fn => fn(1, {}));
    expect(mod.getInterceptorStats(1)?.intercepted).toBe(5);
  });

  it(`超过 ${INTERCEPTOR_TAB_CACHE_SIZE} 个标签页时丢弃最旧`, () => {
    for (let tabId = 1; tabId <= INTERCEPTOR_TAB_CACHE_SIZE; tabId++) mod.recordInterceptorStats(tabId, reported());
    expect(mod.getInterceptorStats(1)?.intercepted).toBe(5);

    mod.recordInterceptorStats(INTERCEPTOR_TAB_CACHE_SIZE + 1, reported());
    expect(mod.getInterceptorStats(1)).toBeNull();
    expect(mod.getInterceptorStats(2)?.intercepted).toBe(5);
  });

  it('再次写入即刷新位置（逐出的是最久没动静的那个，不是最早建的那个）', () => {
    for (let tabId = 1; tabId <= INTERCEPTOR_TAB_CACHE_SIZE; tabId++) mod.recordInterceptorStats(tabId, reported());
    mod.recordInterceptorStats(1, reported({ intercepted: 6 }));
    mod.recordInterceptorStats(INTERCEPTOR_TAB_CACHE_SIZE + 1, reported());
    expect(mod.getInterceptorStats(1)?.intercepted).toBe(6);
    expect(mod.getInterceptorStats(2)).toBeNull();
  });

  it('clearInterceptorStats 只清指定标签页', () => {
    mod.recordInterceptorStats(1, reported());
    mod.recordInterceptorStats(2, reported());
    mod.clearInterceptorStats(1);
    expect(mod.getInterceptorStats(1)).toBeNull();
    expect(mod.getInterceptorStats(2)?.intercepted).toBe(5);
  });

  it('SW 回收后的干净状态可以被显式重建（模块级 Map，不藏持久化）', () => {
    mod.recordInterceptorStats(1, reported());
    mod.clearAllInterceptorStats();
    expect(mod.getInterceptorStats(1)).toBeNull();
  });
});

describe('界面判据：五种状态不得共用语义', () => {
  it('非结构载荷 → noData（SW 回了 { success:false } 也不算读数）', () => {
    expect(describeInterceptorStats(null)).toEqual({ state: 'noData', stats: null });
    expect(describeInterceptorStats({ success: false })).toEqual({ state: 'noData', stats: null });
    expect(isInterceptorStatsEntry({ intercepted: 1 })).toBe(false);
  });

  it('既没被上报过、也没代发过 → noData', () => {
    const entry: InterceptorStatsEntry = {
      intercepted: 0,
      proxied: 0,
      fellBack: 0,
      timedOut: 0,
      updatedAt: 0,
      swProxied: 0,
    };
    expect(describeInterceptorStats(entry).state).toBe('noData');
  });

  it('后台代发过但没有被采信的自报 → noReport（它不是「没生效」）', () => {
    const entry: InterceptorStatsEntry = {
      intercepted: 0,
      proxied: 0,
      fellBack: 0,
      timedOut: 0,
      updatedAt: 0,
      swProxied: 4,
    };
    const view = describeInterceptorStats(entry);
    expect(view.state).toBe('noReport');
    expect(view.stats?.swProxied).toBe(4);
  });

  it('有回退即最高优先：这一页有请求没走代理', () => {
    const entry: InterceptorStatsEntry = {
      intercepted: 6,
      proxied: 4,
      fellBack: 2,
      timedOut: 0,
      updatedAt: START,
      swProxied: 4,
    };
    expect(describeInterceptorStats(entry).state).toBe('fellBack');
  });

  it('超时不是回退，但也不能画成「一切正常」', () => {
    const entry: InterceptorStatsEntry = {
      intercepted: 6,
      proxied: 6,
      fellBack: 0,
      timedOut: 2,
      updatedAt: START,
      swProxied: 6,
    };
    // 请求确实交给了后台，只是没等到响应；说成「都交给扩展代发了」等于把失败画成绿色
    expect(describeInterceptorStats(entry).state).toBe('timedOut');
  });

  it('回退优先于超时（两件事同时发生时，先说「有请求没走代理」）', () => {
    const entry: InterceptorStatsEntry = {
      intercepted: 6,
      proxied: 4,
      fellBack: 2,
      timedOut: 1,
      updatedAt: START,
      swProxied: 4,
    };
    expect(describeInterceptorStats(entry).state).toBe('fellBack');
  });

  it('超时为 0 才是「一切正常」那一句', () => {
    const entry: InterceptorStatsEntry = {
      intercepted: 6,
      proxied: 6,
      fellBack: 0,
      timedOut: 0,
      updatedAt: START,
      swProxied: 6,
    };
    expect(describeInterceptorStats(entry).state).toBe('active');
  });
});

/** MAIN world 与桥接层无法 import，只能按源码契约守 */
const interceptorSrc = readFileSync('entrypoints/main-interceptor.content.ts', 'utf-8');
const bridgeSrc = readFileSync('entrypoints/content.ts', 'utf-8');
const swStatsSrc = readFileSync('entrypoints/background/interceptorStats.ts', 'utf-8');

describe('[MAIN world] 计数点紧邻既有回退分支，且不参与控制流', () => {
  it('四个回退点各有且只有一次 fellBack 计数', () => {
    expect(interceptorSrc.match(/bump\('fellBack'\)/g)).toHaveLength(4);
  });

  it('每一次回退计数都紧挨着"回退原生"那行（顺序反了就会把没回退的请求算成回退）', () => {
    const at = interceptorSrc.indexOf('XMLHttpRequest.prototype.open');
    expect(interceptorSrc.slice(0, at).match(/bump\('fellBack'\)/g)).toHaveLength(2); // fetch 两处
    const xhrSegment = interceptorSrc.slice(at, interceptorSrc.indexOf('// ---- Intercept WebSocket'));
    expect(xhrSegment.match(/bump\('fellBack'\)/g)).toHaveLength(2);
    // fetch 的 catch 分支里，回退计数必须落在「阻断规则一律不得回退」的判定之后
    const catchAt = interceptorSrc.indexOf(
      'if (rule?.blocked || (error as { __proxyBlocked?: boolean })?.__proxyBlocked)',
    );
    const bumpAt = interceptorSrc.indexOf("bump('fellBack');", catchAt);
    expect(catchAt).toBeGreaterThan(-1);
    expect(bumpAt).toBeGreaterThan(catchAt);
    expect(interceptorSrc.slice(catchAt, bumpAt)).toContain('throw new TypeError');
  });

  it('拦到与代发各有一处计数，超时在 reject 之前', () => {
    expect(interceptorSrc.match(/bump\('intercepted'\)/g)).toHaveLength(2); // fetch + XHR
    expect(interceptorSrc.match(/bump\('proxied'\)/g)).toHaveLength(1); // 两条通道都经 proxyFetch
    const timeoutAt = interceptorSrc.indexOf("bump('timedOut');");
    expect(timeoutAt).toBeGreaterThan(-1);
    expect(interceptorSrc.slice(timeoutAt, timeoutAt + 160)).toContain("reject(new Error('Proxy request timeout'))");
  });

  it('超时计数住在两条通道共用的 proxyFetch 里，页面自设的 xhr.timeout 到期不计数', () => {
    // 口径是「扩展侧代发等待回包到期」：fetch 与 XHR 都经 proxyFetch 交给后台，
    // 所以那一笔必须落在共用函数内；页面自己设的等待超时是页面行为，算进来就变成替页面报错。
    const proxyFetchAt = interceptorSrc.indexOf('function proxyFetch(');
    const fetchAt = interceptorSrc.indexOf('const originalFetch = window.fetch');
    const timeoutAt = interceptorSrc.indexOf("bump('timedOut');");
    expect(proxyFetchAt).toBeGreaterThan(-1);
    expect(timeoutAt).toBeGreaterThan(proxyFetchAt);
    expect(timeoutAt).toBeLessThan(fetchAt);
    const pageTimeoutAt = interceptorSrc.indexOf('尊重页面设置的 xhr.timeout');
    const pageTimeoutBlock = interceptorSrc.slice(
      pageTimeoutAt,
      interceptorSrc.indexOf('proxyFetch(url, rule', pageTimeoutAt),
    );
    expect(pageTimeoutAt).toBeGreaterThan(-1);
    expect(pageTimeoutBlock).not.toContain('bump(');
  });

  it('bump 内部没有 try/catch、也不返回任何东西（计数不得影响请求路径）', () => {
    const start = interceptorSrc.indexOf('function bump(kind: keyof typeof stats)');
    const body = interceptorSrc.slice(start, interceptorSrc.indexOf('\n    }', start + 40) + 5);
    expect(body).not.toContain('try {');
    expect(body).not.toContain('catch');
    expect(body).not.toContain('return true');
    expect(start).toBeGreaterThan(-1);
  });

  it('节流三档触发条件都在，尾差由兜底定时器补报', () => {
    // 节流跑在 MAIN world，import 进来就会执行 DOM 改写，所以这里守的是「分支还在」而不是数值行为；
    // 真正的时序验证只能靠浏览器实测（见交付说明里的未验证项）。
    expect(interceptorSrc).toContain('statsLastReportAt === 0 ||');
    expect(interceptorSrc).toContain('total - statsReportedTotal >= STATS_REPORT_EVERY ||');
    expect(interceptorSrc).toContain('sinceLast >= STATS_REPORT_MIN_INTERVAL_MS');
    expect(interceptorSrc).toContain('if (statsTimer === null) {');
    expect(interceptorSrc).toContain('setTimeout(reportStats,');
  });

  it('上报只走既有 channel 与 origin 受限的 postMessage，不新增网络请求', () => {
    const start = interceptorSrc.indexOf('function reportStats()');
    const body = interceptorSrc.slice(start, interceptorSrc.indexOf('\n    }', start + 40));
    expect(body).toContain('type: INTERCEPTOR_STATS');
    expect(body).toContain('window.location.origin');
    expect(body).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon/);
  });
});

describe('[桥接层与 SW] 自报路径不写存储、不改状态', () => {
  it('桥接层转发时把载荷收窄成四个键，不整包透传', () => {
    const at = bridgeSrc.indexOf('if (event.data?.type === MessageType.INTERCEPTOR_STATS)');
    // 结束边界取下一条分支的判据行：块内本来就有几处 `return;`，按它切只会切到守卫那行
    const end = bridgeSrc.indexOf('if (event.data?.type !== MessageType.PROXY_REQUEST)', at);
    const block = bridgeSrc.slice(at, end);
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    expect(block).toContain('intercepted: raw.intercepted');
    expect(block).toContain('proxied: raw.proxied');
    expect(block).toContain('fellBack: raw.fellBack');
    expect(block).toContain('timedOut: raw.timedOut');
    expect(block).not.toContain('...raw');
    expect(block).toContain('chrome.runtime');
    // 送不出去就丢掉：不重试、不落盘、不打成 error（SW 回收期本来就发不出去）
    expect(block).toContain('.catch(() => {})');
  });

  it('SW 侧模块不碰 storage、不碰配置', () => {
    expect(swStatsSrc).not.toContain('chrome.storage');
    expect(swStatsSrc).not.toContain('STORAGE_KEYS');
    expect(swStatsSrc).not.toContain('saveProxyConfig');
  });

  it('两个新类型都不得进 gate 清单（一条是页面发来的展示数据，一条是 popup 的只读）', () => {
    const routerSrc = readFileSync('entrypoints/background/messageRouter.ts', 'utf-8');
    const mutatingAt = routerSrc.indexOf('const STATE_MUTATING_TYPES');
    const readingAt = routerSrc.indexOf('const CREDENTIAL_READING_TYPES');
    const respondAt = routerSrc.indexOf('function respondAsync');
    // 锚点先守住：否则 slice 会切出空串或越界片段，下面两条 not.toContain 就变成永真
    expect(mutatingAt).toBeGreaterThan(-1);
    expect(readingAt).toBeGreaterThan(mutatingAt);
    expect(respondAt).toBeGreaterThan(readingAt);
    const mutating = routerSrc.slice(mutatingAt, readingAt);
    const reading = routerSrc.slice(readingAt, respondAt);
    expect(mutating).toContain('MessageType.');
    expect(reading).toContain('MessageType.');
    expect(mutating).not.toContain('INTERCEPTOR_STATS');
    expect(reading).not.toContain('INTERCEPTOR_STATS');
  });
});

const popupSrc = readFileSync('entrypoints/popup/App.vue', 'utf-8');

describe('[popup] 那一行的显示闸门与状态映射', () => {
  /** 取某个 `computed` / 函数的源码片段（到它在列 0 的收尾 `});` / `}` 为止） */
  function sourceOf(anchor: string, closer: string): string {
    const start = popupSrc.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    const end = popupSrc.indexOf(closer, start);
    expect(end).toBeGreaterThan(start);
    return popupSrc.slice(start, end);
  }

  it('整行按需出现：首帧未回不渲染，`noData` 只在后台通道命中时才有位置', () => {
    const body = sourceOf('const interceptorStripVisible = computed(', '\n});');
    expect(body).toContain('!enabled.value');
    expect(body).toContain('!pageHitProxiable.value');
    // 首次读取没回来之前整条不画，否则挂载瞬间会闪一句「还没回报」
    expect(body).toContain('!interceptorFetched.value');
    // 「不知道」与「没有」不合并：有读数一律显示，noData 还要再过两道闸
    expect(body).toContain("state !== 'noData'");
    expect(body).toContain('!!pageHitRuleId.value && !pageHitChannelDnr.value');
  });

  it('五种状态各走自己的 key，且第二格填的数与句子语义一致', () => {
    const body = sourceOf('const interceptorText = computed(', '\n});');
    // 有回退时第二个数必须是 fellBack——把它换成 proxied 就是「把没走代理的说成走了代理」
    expect(body).toMatch(
      /'fellBack'[\s\S]*?t\('interceptorFellBack', \[String\(stats\.intercepted\), String\(stats\.fellBack\)\]\)/,
    );
    // 有代发超时就必须点名「没等到响应」，不能退回绿色的「已交给扩展代发」
    expect(body).toMatch(
      /'timedOut'[\s\S]*?t\('interceptorTimedOut', \[String\(stats\.intercepted\), String\(stats\.timedOut\)\]\)/,
    );
    expect(body).toMatch(
      /'active'[\s\S]*?t\('interceptorActive', \[String\(stats\.intercepted\), String\(stats\.proxied\)\]\)/,
    );
    // noReport 那一句的数是后台自己数的基线，不是页面给的四个数
    expect(body).toMatch(/'noReport'[\s\S]*?t\('interceptorNoReport', String\(stats\.swProxied\)\)/);
    expect(body).toContain("return t('interceptorNoData')");
  });

  it('悬停只在有可信读数时展开，五个占位按「时刻 + 四个数」的顺序喂', () => {
    const body = sourceOf('const interceptorDetailText = computed(', '\n});');
    // noData / noReport 没有可展开的东西，给空串比给一句假话好
    expect(body).toContain("state === 'noData' || state === 'noReport'");
    expect(body).toContain("t('interceptorDetail', [");
    expect(body).toContain('formatClock(stats.updatedAt),');
    // 顺序就是文案里的顺序：换错一个数，用户读到的账就对不上
    expect(body.match(/String\(stats\.\w+\)/g)).toEqual([
      'String(stats.intercepted)',
      'String(stats.proxied)',
      'String(stats.fellBack)',
      'String(stats.timedOut)',
    ]);
  });

  it('只接受结构完整的读数：SW 的失败信封不得覆盖已有数字，但要让闸门知道已经回过', () => {
    const body = sourceOf('async function fetchTabInterceptorStats', '\n}');
    expect(body).toContain('isInterceptorStatsEntry(entry)');
    expect(body).toContain('interceptorFetched.value = true');
    expect(body).not.toContain('interceptorRaw.value = null');
  });
});
