/**
 * 界面读数层按运行时测：日志抽屉的那把表与弹窗的那一屏状态
 *
 * `composables/useRequestLog.ts` 与 `composables/useProxyStatus.ts` 此前从未被**跑起来**过。
 * 已有的覆盖全在别处：`full-verification.test.ts` 钉的是预设值清单（`[5000, 15000, ...]`）
 * 与「不许自己写一遍 `sampledAt === 0`」这类源码契约，`autoOff` / `badgeManager` 钉的是后台侧，
 * 组件层则因为需要 DOM 而整层空缺。于是有一类断言谁都够不着：**回包形状 → 界面读数**这一步。
 * 这一步漏了的后果不是报错，是画出来说不出哪来的数——「近 5 分钟无命中」（其实是读不到）、
 * 「倒计时 NaN」（其实是字段没给）、上一轮的日志（其实这一轮已经失败）。
 *
 * 这一层真正只有自己才能钉的东西分三堆：
 * 1. **失败的那一轮不许改写上一轮的读数，但一定把 `loading` 放下来**（`finally` 那一句）。
 *    两个 composable 各有一份「非标载荷整轮不采纳」，判据不同：日志看的是「是不是数组」，
 *    状态看的是「`enabled` 是不是布尔」——前者错了只是少一格数据，后者错了整屏都在说谎。
 * 2. **那把表**：`setInterval` 只有 `startTimer` 一个入口，而它开头就 `stopTimer()`。
 *    重复打开、改频率、关掉开关三条路径各自都必须只剩一块表，否则抽屉开着就在按秒级
 *    打 SW（预设最小 5s，叠加两块就是 2.5s，且永远不会自己停下）。
 * 3. **五种采样状态不许塌成两句**：`describeDnrSample` 已经把判据收成纯函数，
 *    这里钉的是「读端有没有把 `hits: null` 和 `stats` 弄反」——`stale` 那一格最微妙，
 *    它是「有读数、只是旧的」，计数必须留下并另立一个陈旧标记，清成空数组就成了「没有命中」。
 *
 * 夹具只有两处形状是承重的：① `localStorage` 每个用例前重新装一份（`loadStoredInterval`
 * 在**创建实例那一刻**读它，不是模块加载时读的，所以「换个存储值再 new 一次」这条路径测得动，
 * 而「改了存储但实例还是旧的」这种伪断言测不动）；② 定时器一律走 `vi.useFakeTimers()`，
 * 计数按 `sendMessage` 的调用次数读——不去断言时间本身。
 *
 * **本环境测不到的那半**：两个 composable 都靠 Vue 的生命周期钩子接第一笔拉取与停表，
 * 而组件实例外调用时钩子永不触发（这正是下面只吞那两条 `[Vue warn]` 的原因，见
 * `tests/pendingDeleteUndo.test.ts` 的同款处理）。那两句接线单独按源码契约钉住——
 * 它们没有运行时对应物，删掉 `onMounted(fetchLogs)` 时这里必须是红的。
 *
 * 承重与否是**量出来的**，不是推出来的。第一轮（`.test-tmp/mutate-composables-readouts.py`）：
 * 39 个锚点各改一处 → 跑本文件 → 37 条咬住、2 条刻意存活、0 条锚点失效，跑完两个源文件
 * `git status` 干净。两条存活各有说法，别当冗余删掉判据：
 * - `L17`：`fetchDnrStats` 里 `view.hits === null || !isDnrSample(sample)` 的后半被前半**完全
 *   覆盖**（非采样结构的 `hits` 必然是 `null`），构造不出能区分两者的输入。它是防御性冗余，
 *   不是失败面——真要简化属于生产代码改动，本轮零改动，只做记录。
 * - `P15`：`rules.value = status.rules ?? []` 不判数组。这一格从 SW 侧已经不可达
 *   （`getProxyStatus` 的 `rules` 出自 `configRules()`，非数组当空，见批次 F），
 *   所以这里**刻意不把它钉成期望行为**——钉住等于替未来的收口预先判负。
 *
 * 另一处是量出来之后回头修夹具的：`toggleProxy(false)` 对着初值 `false` 断言「本地已置位」
 * 是一句空话（改与不改都过），锚点 `P6` 当场存活暴露了它。开关方向的用例一律从 `false` 拨到
 * `true`，这一条对 `enabled` 之外的字段同样成立——断言的值必须与「这一轮什么都没发生」可区分。
 *
 * 第二轮量的是本批新加的这两格旗标怎么被界面用（`.test-tmp/mutate-readouts2.py`，14 个锚点跨
 * `useRequestLog` / `useProxyStatus` / popup / 抽屉 / options 装配层）：14 条全咬住、0 条存活。
 * 其中 `L4` 在第一轮活了下来，暴露的是 `P6` 同一类空话：`clearLogs` 那句「摘掉没读到」原先写在一份
 * **本来就是 `false`** 的读数之后（`fetchLogs` 成功 → 直接清空），摘掉它断言照样过。现在那一格
 * 先从失败的回包进 `true`，再让清空把它收回 `false`——方向才真的被钉住。
 *
 * 拦截器自包含、不 import 枚举；这里不是，所以消息类型一律经 `utils/types.ts` 取值。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { MessageType } from '@/utils/types';
import type { DnrSample, ProxyStatus, RequestLogEntry } from '@/utils/types';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/utils/logger', () => ({ logger }));

const sendMessage = vi.fn();
const openOptionsPage = vi.fn();
vi.stubGlobal('chrome', {
  runtime: { sendMessage, openOptionsPage },
  // i18n 在未设置过语言偏好时按浏览器 UI 语言推断；给个确定值，免得断言随环境漂移
  i18n: { getUILanguage: () => 'zh-CN' },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
});

// 组件实例外的 onMounted/onUnmounted 必然抱怨，而这两件事正是本环境测不到的那半。
// 只吞这两条，其余警告照常输出，避免把真实告警一起静音。
const nativeWarn = console.warn;
vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  const head = String(args[0]);
  if (head.startsWith('[Vue warn]: onMounted') || head.startsWith('[Vue warn]: onUnmounted')) return;
  nativeWarn.apply(console, args);
});

const { useRequestLog } = await import('@/composables/useRequestLog');
const { useProxyStatus } = await import('@/composables/useProxyStatus');
const { t } = await import('@/utils/i18n');

/** 持久化键：与被测模块的 `REFRESH_INTERVAL_STORAGE_KEY` 同值，按字面量说话 */
const INTERVAL_KEY = 'cop_log_refresh_interval';

interface FakeStorage {
  data: Record<string, string>;
  throwOnRead: boolean;
  throwOnWrite: boolean;
}

let local: FakeStorage;

function installLocalStorage(initial: Record<string, string> = {}) {
  local = { data: { ...initial }, throwOnRead: false, throwOnWrite: false };
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      if (local.throwOnRead) throw new Error('SecurityError: storage blocked');
      return key in local.data ? local.data[key] : null;
    },
    setItem: (key: string, value: string) => {
      if (local.throwOnWrite) throw new Error('QuotaExceededError');
      local.data[key] = value;
    },
  });
}

/**
 * 按消息类型回包。给一个会抛的函数就是「SW 回收期 / 上下文失效」那条分支，
 * 显式登记 `undefined` 就是「sendMessage 直接 resolve 了个空」；
 * 没登记过的类型直接抛——它意味着用例读到了本不该由这条路径发出的消息。
 */
function respond(map: Partial<Record<MessageType, unknown | (() => unknown)>>) {
  sendMessage.mockImplementation(async (message: { type: MessageType }) => {
    if (!(message.type in map)) throw new Error(`用例未登记这条消息：${message.type}`);
    const entry = map[message.type];
    return typeof entry === 'function' ? (entry as () => unknown)() : entry;
  });
}

const typesSent = () => sendMessage.mock.calls.map(call => (call[0] as { type: MessageType }).type);

function makeLog(id: string): RequestLogEntry {
  return {
    id,
    timestamp: 1_700_000_000_000,
    ruleId: 'r1',
    ruleName: 'fat→uat',
    originalUrl: `https://fat.example.com/${id}`,
    proxiedUrl: `https://api.uat.example.com/${id}`,
    method: 'GET',
    proxyType: 'sw',
  };
}

function makeStatus(overrides: Partial<ProxyStatus> = {}): ProxyStatus {
  return {
    enabled: true,
    activeRuleCount: 3,
    swRequestCount: 7,
    recentLogs: [makeLog('a')],
    rules: [{ id: 'r1', name: 'fat→uat', enabled: true }],
    autoOffAt: 1_700_000_060_000,
    ...overrides,
  };
}

/** 一次采样的五种状态各造一份原始载荷，读端拿到的是「未经判据」的它们 */
function sample(stats: DnrSample['stats'], sampledAt: number, stale: boolean): DnrSample {
  return { stats, sampledAt, stale };
}

const HIT = [{ ruleId: 'r1', ruleName: 'fat→uat', hitCount: 12 }];

beforeEach(() => {
  installLocalStorage();
  logger.error.mockReset();
  logger.warn.mockReset();
  sendMessage.mockReset();
  openOptionsPage.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRequestLog — 回包形状决定界面读数', () => {
  it('开局是「在加载」而不是「有零条」：loading 初值为 true', () => {
    const log = useRequestLog();
    expect(log.loading.value).toBe(true);
    expect(log.logs.value).toEqual([]);
  });

  it('拉到日志：原样收下，并把 loading 放下来', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [makeLog('a'), makeLog('b')] });
    const log = useRequestLog();
    await log.fetchLogs();
    expect(log.logs.value.map(entry => entry.id)).toEqual(['a', 'b']);
    expect(log.loading.value).toBe(false);
  });

  it('SW 回了非标对象：这一轮当「没读到」——维持上一轮读数并置位，不再画成一条都没有', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [makeLog('a')], [MessageType.CLEAR_REQUEST_LOG]: { success: true } });
    const log = useRequestLog();
    await log.fetchLogs();
    expect(log.logsReadFailed.value).toBe(false);

    respond({ [MessageType.GET_REQUEST_LOG]: { success: false } });
    await log.fetchLogs();
    // 非标回包与抛错是同一件事：这一轮没有答案。旧行为把它当「读到 0 条」清掉列表，
    // 于是抽屉里出现「暂无请求记录」——用户读到的是「我的记录被清了」这句假话
    expect(log.logs.value.map(entry => entry.id)).toEqual(['a']);
    expect(log.logsReadFailed.value).toBe(true);
    expect(log.loading.value).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('非标结构里那份对象不许塞进界面：logs 仍是上一轮那份数组', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [makeLog('a')] });
    const log = useRequestLog();
    await log.fetchLogs();
    respond({ [MessageType.GET_REQUEST_LOG]: { success: false, error: 'BOOM' } });
    await log.fetchLogs();
    expect(log.logs.value).toEqual([makeLog('a')]);
  });

  it('读到一次就摘掉「没读到」：这一格不许粘住', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: { success: false } });
    const log = useRequestLog();
    await log.fetchLogs();
    expect(log.logsReadFailed.value).toBe(true);

    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    await log.fetchLogs();
    // 空数组是**真读数**：此后界面说的「暂无请求记录」有据可依，与上一轮的「没读到」必须分开
    expect(log.logsReadFailed.value).toBe(false);
    expect(log.logs.value).toEqual([]);
  });

  it('拉取抛错同样记「没读到」：两条失败路径在界面上必须是同一句话', async () => {
    respond({
      [MessageType.GET_REQUEST_LOG]: () => {
        throw new Error('Extension context invalidated');
      },
    });
    const log = useRequestLog();
    await log.fetchLogs();
    expect(log.logsReadFailed.value).toBe(true);
  });

  it('清除成功才清空本地列表，并把「没读到」一并摘掉', async () => {
    respond({
      [MessageType.GET_REQUEST_LOG]: { success: false },
      [MessageType.CLEAR_REQUEST_LOG]: { success: true },
    });
    const log = useRequestLog();
    await log.fetchLogs();
    // 先进「没读到」：清空那句断言只有从这一格出发才量得出方向
    expect(log.logsReadFailed.value).toBe(true);
    await log.clearLogs();
    // 后台确认清空成功，这份「空」就是真读数，不是读不到
    expect(log.logs.value).toEqual([]);
    expect(log.logsReadFailed.value).toBe(false);
  });

  it('拉取抛错：维持上一轮的读数，但 loading 一定落回来', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [makeLog('a')] });
    const log = useRequestLog();
    await log.fetchLogs();
    expect(log.logs.value).toHaveLength(1);

    respond({
      [MessageType.GET_REQUEST_LOG]: () => {
        throw new Error('Extension context invalidated');
      },
    });
    await log.fetchLogs();
    expect(log.logs.value.map(entry => entry.id)).toEqual(['a']);
    expect(log.loading.value).toBe(false);
    // 失败不许静默：这一轮至少要在日志里留一笔
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('清除成功才清空本地列表', async () => {
    respond({
      [MessageType.GET_REQUEST_LOG]: [makeLog('a')],
      [MessageType.CLEAR_REQUEST_LOG]: { success: true },
    });
    const log = useRequestLog();
    await log.fetchLogs();
    await log.clearLogs();
    expect(log.logs.value).toEqual([]);
  });

  it('清除被后台拒绝：抛的是回包里那句话，列表原样留着', async () => {
    respond({
      [MessageType.GET_REQUEST_LOG]: [makeLog('a')],
      [MessageType.CLEAR_REQUEST_LOG]: { success: false, error: 'CLEAR_DENIED' },
    });
    const log = useRequestLog();
    await log.fetchLogs();
    await expect(log.clearLogs()).rejects.toThrow('CLEAR_DENIED');
    expect(log.logs.value.map(entry => entry.id)).toEqual(['a']);
  });

  it('清除遇到 undefined 回包（SW 刚被回收）：落成稳定码，不是 TypeError', async () => {
    respond({
      [MessageType.GET_REQUEST_LOG]: [makeLog('a')],
      [MessageType.CLEAR_REQUEST_LOG]: undefined,
    });
    const log = useRequestLog();
    await log.fetchLogs();
    await expect(log.clearLogs()).rejects.toThrow('CLEAR_LOGS_FAILED');
    expect(log.logs.value).toHaveLength(1);
  });
});

describe('useRequestLog — 自动刷新那把表', () => {
  it('打开开关：一个周期恰好打一次，不多不少', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const log = useRequestLog();
    log.toggleAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(typesSent()).toEqual([MessageType.GET_REQUEST_LOG]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(typesSent()).toHaveLength(2);
  });

  it('重复打开不叠加：第二次调用先把上一块表停掉', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const log = useRequestLog();
    log.toggleAutoRefresh(true);
    log.toggleAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(typesSent()).toHaveLength(1);
  });

  it('关闭开关立即停表：之后再走十个周期一次也不打', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const log = useRequestLog();
    log.toggleAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(5000);
    const sentWhileOn = typesSent().length;
    log.toggleAutoRefresh(false);
    await vi.advanceTimersByTimeAsync(50000);
    expect(typesSent()).toHaveLength(sentWhileOn);
  });

  it('改频率时旧周期作废：按新值打，而不是新旧各一套', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const log = useRequestLog();
    log.toggleAutoRefresh(true);
    log.setRefreshInterval(15000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(typesSent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(typesSent()).toHaveLength(1);
  });

  it('非预设值整个拒掉：值不变、不写存储、表也不重开', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const log = useRequestLog();
    log.toggleAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(5000);
    const sentBefore = typesSent().length;

    log.setRefreshInterval(7000);
    expect(log.refreshInterval.value).toBe(5000);
    expect(local.data[INTERVAL_KEY]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    // 如果它「顺手」重开了表，这里会多出一笔
    expect(typesSent()).toHaveLength(sentBefore + 1);
  });

  it('自动刷新关着时改频率：只记值，不许顺手把表打开', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const log = useRequestLog();
    log.setRefreshInterval(30000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(typesSent()).toEqual([]);
    expect(log.refreshInterval.value).toBe(30000);
  });

  it('选中的频率写进 localStorage，下一个实例开局就是它', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const first = useRequestLog();
    first.setRefreshInterval(60000);
    expect(local.data[INTERVAL_KEY]).toBe('60000');

    const second = useRequestLog();
    expect(second.refreshInterval.value).toBe(60000);
  });

  it.each([
    ['越界值 7000', '7000'],
    ['不是数字的 abc', 'abc'],
    ['空串', ''],
  ])('存储里是%s：回默认 5s，不把怪值透传给界面', (_label, raw) => {
    installLocalStorage({ [INTERVAL_KEY]: raw });
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    expect(useRequestLog().refreshInterval.value).toBe(5000);
  });

  it('localStorage 整个不可用（隐私模式）：开局回默认，且不外抛', () => {
    installLocalStorage();
    local.throwOnRead = true;
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    expect(useRequestLog().refreshInterval.value).toBe(5000);
  });

  it('写存储失败不影响本次生效：值改了、表也按新周期开着', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const log = useRequestLog();
    local.throwOnWrite = true;
    log.toggleAutoRefresh(true);
    log.setRefreshInterval(15000);
    expect(log.refreshInterval.value).toBe(15000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(typesSent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(typesSent()).toHaveLength(1);
  });

  /**
   * 抽屉开合暂停/恢复那把表（M-8）
   *
   * 配置页能开上一整天，而抽屉里那张表是 `v-show` 藏起来不是卸载——不停表就是每 5s 为一张
   * 看不见的表格整份回读日志（满表 500 条就是 MB 级的一次序列化）并重算派生表。与「关掉自动刷新」的**区别**
   * 是开关本身原样留着：暂停是界面可见性决定的，不是用户改的主意，重新打开抽屉时它必须接着跑。
   * 谁把 `pauseAutoRefresh` 写成 `toggleAutoRefresh(false)`，第二格（恢复后还要能打）当场红。
   */
  it('暂停不动开关、恢复接着跑：抽屉关着期间一笔也不打', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const log = useRequestLog();
    log.toggleAutoRefresh(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(typesSent()).toHaveLength(1);

    log.pauseAutoRefresh();
    await vi.advanceTimersByTimeAsync(60000);
    expect(typesSent()).toHaveLength(1);
    expect(log.autoRefresh.value).toBe(true);

    log.resumeAutoRefresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(typesSent()).toHaveLength(2);
  });

  it('用户没开自动刷新时，恢复不许顺手把表起起来', async () => {
    respond({ [MessageType.GET_REQUEST_LOG]: [] });
    const log = useRequestLog();
    log.resumeAutoRefresh();
    await vi.advanceTimersByTimeAsync(60000);
    expect(typesSent()).toEqual([]);
    expect(log.autoRefresh.value).toBe(false);
  });
});

describe('useRequestLog — 网络层命中数的五种状态不许塌成两句', () => {
  it('fresh 有读数：计数留下、不标陈旧、状态是可画数的那一档', async () => {
    respond({ [MessageType.GET_DNR_STATS]: sample(HIT, 1_700_000_000_000, false) });
    const log = useRequestLog();
    await log.fetchDnrStats();
    expect(log.dnrStats.value).toEqual(HIT);
    expect(log.dnrStatsState.value).toBe('fresh');
    expect(log.dnrStatsStale.value).toBe(false);
  });

  it('stale：计数留着并标成陈旧——陈旧是「有读数、只是旧的」，不是「没有命中」', async () => {
    respond({ [MessageType.GET_DNR_STATS]: sample(HIT, 1_700_000_000_000, true) });
    const log = useRequestLog();
    await log.fetchDnrStats();
    expect(log.dnrStats.value).toEqual(HIT);
    expect(log.dnrStatsState.value).toBe('stale');
    expect(log.dnrStatsStale.value).toBe(true);
  });

  it('读到 0 次就是真的 0 次：空数组配上 fresh，与「没有读数」分开', async () => {
    respond({ [MessageType.GET_DNR_STATS]: sample([], 1_700_000_000_000, false) });
    const log = useRequestLog();
    await log.fetchDnrStats();
    expect(log.dnrStats.value).toEqual([]);
    expect(log.dnrStatsState.value).toBe('fresh');
  });

  it('从未采到样（sampledAt 0）：清空计数，但状态记的是「没有生效的网络层规则」', async () => {
    respond({ [MessageType.GET_DNR_STATS]: sample(HIT, 0, false) });
    const log = useRequestLog();
    await log.fetchDnrStats();
    expect(log.dnrStats.value).toEqual([]);
    expect(log.dnrStatsState.value).toBe('notApplicable');
    expect(log.dnrStatsStale.value).toBe(false);
  });

  it('配额退避且无缓存（sampledAt 0 + stale）：换成 unavailable 那一句', async () => {
    respond({ [MessageType.GET_DNR_STATS]: sample(HIT, 0, true) });
    const log = useRequestLog();
    await log.fetchDnrStats();
    expect(log.dnrStats.value).toEqual([]);
    expect(log.dnrStatsState.value).toBe('unavailable');
  });

  it('SW 回的是失败信封：判成 pending，把上一轮的计数一起交回去而不是假装读到过', async () => {
    respond({ [MessageType.GET_DNR_STATS]: sample(HIT, 1_700_000_000_000, false) });
    const log = useRequestLog();
    await log.fetchDnrStats();
    expect(log.dnrStats.value).toEqual(HIT);

    respond({ [MessageType.GET_DNR_STATS]: { success: false } });
    await log.fetchDnrStats();
    expect(log.dnrStatsState.value).toBe('pending');
    expect(log.dnrStats.value).toEqual([]);
  });

  it('采样抛错：状态与原读数都不动（这一轮根本没有答案）', async () => {
    respond({ [MessageType.GET_DNR_STATS]: sample(HIT, 1_700_000_000_000, false) });
    const log = useRequestLog();
    await log.fetchDnrStats();

    respond({
      [MessageType.GET_DNR_STATS]: () => {
        throw new Error('quota');
      },
    });
    await log.fetchDnrStats();
    expect(log.dnrStatsState.value).toBe('fresh');
    expect(log.dnrStats.value).toEqual(HIT);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('后台通道那一格：非数组当空，抛错时维持上一轮', async () => {
    respond({ [MessageType.GET_SW_STATS]: HIT });
    const log = useRequestLog();
    await log.fetchSwStats();
    expect(log.swStats.value).toEqual(HIT);

    respond({ [MessageType.GET_SW_STATS]: { success: false } });
    await log.fetchSwStats();
    expect(log.swStats.value).toEqual([]);

    respond({
      [MessageType.GET_SW_STATS]: () => {
        throw new Error('gone');
      },
    });
    await log.fetchSwStats();
    expect(log.swStats.value).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('useProxyStatus — 读不出来的那一轮，界面维持上一次的话', () => {
  it('成功一轮：六个字段各就各位，loading 落回 false', async () => {
    respond({ [MessageType.GET_PROXY_STATUS]: makeStatus() });
    const status = useProxyStatus();
    await status.fetchStatus();
    expect(status.enabled.value).toBe(true);
    expect(status.activeRuleCount.value).toBe(3);
    expect(status.swRequestCount.value).toBe(7);
    expect(status.recentLogs.value.map(entry => entry.id)).toEqual(['a']);
    expect(status.rules.value).toEqual([{ id: 'r1', name: 'fat→uat', enabled: true }]);
    expect(status.autoOffAt.value).toBe(1_700_000_060_000);
    expect(status.loading.value).toBe(false);
  });

  it('回包不是状态结构（enabled 缺布尔）：整轮不采纳，一个字段都不覆盖', async () => {
    respond({ [MessageType.GET_PROXY_STATUS]: makeStatus() });
    const status = useProxyStatus();
    await status.fetchStatus();

    respond({ [MessageType.GET_PROXY_STATUS]: { success: false } });
    await status.fetchStatus();
    expect(status.enabled.value).toBe(true);
    expect(status.activeRuleCount.value).toBe(3);
    expect(status.swRequestCount.value).toBe(7);
    expect(status.autoOffAt.value).toBe(1_700_000_060_000);
    // 但 loading 必须落回来，否则弹窗永远停在骨架屏
    expect(status.loading.value).toBe(false);
  });

  it('undefined 回包（SW 回收期）同样不采纳，且不当成错误抛出', async () => {
    respond({ [MessageType.GET_PROXY_STATUS]: makeStatus() });
    const status = useProxyStatus();
    await status.fetchStatus();

    respond({ [MessageType.GET_PROXY_STATUS]: undefined });
    await status.fetchStatus();
    expect(status.activeRuleCount.value).toBe(3);
    expect(status.loading.value).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('recentLogs 非数组只影响它自己：其余字段照常采纳', async () => {
    respond({
      [MessageType.GET_PROXY_STATUS]: makeStatus({ recentLogs: 'not-an-array' as unknown as RequestLogEntry[] }),
    });
    const status = useProxyStatus();
    await status.fetchStatus();
    expect(status.recentLogs.value).toEqual([]);
    expect(status.activeRuleCount.value).toBe(3);
  });

  /**
   * `NaN` 刻意不列在这里：这一格的闸门是 `typeof === 'number'`，而 `typeof NaN` 正是
   * `'number'`，它过得去。不写成断言是因为那条回包路径不存在——SW 侧只会交回
   * `chrome.alarms.get(...).scheduledTime`（`proxyHandler.ts` 的 `getProxyStatus`），
   * 拿不到时是 `undefined`，不是 NaN。把「界面画出 NaN」钉成期望行为等于替未来的
   * `Number.isFinite` 收口预先判负，而现在的实现根本没有那个失败面。
   */
  it.each([
    ['字符串形式的时间点', '1700000060000'],
    ['null', null],
  ])('autoOffAt 是%s：当没配置，而不是把怪值交给倒计时去渲染', async (_label, raw) => {
    respond({ [MessageType.GET_PROXY_STATUS]: makeStatus({ autoOffAt: raw as unknown as number | undefined }) });
    const status = useProxyStatus();
    await status.fetchStatus();
    expect(status.loading.value).toBe(false);
    expect(status.autoOffAt.value).toBeUndefined();
  });

  it('拉取抛错：维持上一轮读数并留一笔日志', async () => {
    respond({ [MessageType.GET_PROXY_STATUS]: makeStatus() });
    const status = useProxyStatus();
    await status.fetchStatus();

    respond({
      [MessageType.GET_PROXY_STATUS]: () => {
        throw new Error('context invalidated');
      },
    });
    await status.fetchStatus();
    expect(status.swRequestCount.value).toBe(7);
    expect(status.loading.value).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  /**
   * 首屏那三个数（开关位置、活跃规则、经扩展请求）在第一次读取回话之前全是初值，
   * 而初值画出来是一句「已关闭 · 0 · 0」的结论。`statusEverRead` 是界面唯一能分清
   * 「从来没有过读数」与「读到过、这一轮没读到」的那一格：前者画 `—`／「未知」，
   * 后者维持上一份采纳过的读数（那是最近一次的事实）。
   */
  it('从没读到过与读到过是两件事：初值 false，成功一轮才推开', async () => {
    respond({ [MessageType.GET_PROXY_STATUS]: makeStatus() });
    const status = useProxyStatus();
    expect(status.statusEverRead.value).toBe(false);
    await status.fetchStatus();
    expect(status.statusEverRead.value).toBe(true);
  });

  it('三条「这一轮没答案」的路径都不许推开它：首屏失败时那一屏仍然只能画 —', async () => {
    const noAnswer: unknown[] = [
      { success: false },
      undefined,
      () => {
        throw new Error('context invalidated');
      },
    ];
    for (const raw of noAnswer) {
      respond({ [MessageType.GET_PROXY_STATUS]: raw });
      const status = useProxyStatus();
      await status.fetchStatus();
      expect(status.statusEverRead.value).toBe(false);
      expect(status.loading.value).toBe(false);
    }
  });

  it('读到过之后失败不再回落：那份读数仍是这一屏该说的话', async () => {
    respond({ [MessageType.GET_PROXY_STATUS]: makeStatus() });
    const status = useProxyStatus();
    await status.fetchStatus();
    respond({ [MessageType.GET_PROXY_STATUS]: { success: false } });
    await status.fetchStatus();
    expect(status.statusEverRead.value).toBe(true);
    expect(status.activeRuleCount.value).toBe(3);
  });
});

describe('useProxyStatus — 开关的乐观更新只在成功之后', () => {
  it('总开关成功：先落 TOGGLE_PROXY，再重拉一次让倒计时跟着对齐', async () => {
    respond({
      [MessageType.TOGGLE_PROXY]: { success: true },
      [MessageType.GET_PROXY_STATUS]: makeStatus({ enabled: false, autoOffAt: undefined }),
    });
    const status = useProxyStatus();
    await status.toggleProxy(false);
    expect(typesSent()).toEqual([MessageType.TOGGLE_PROXY, MessageType.GET_PROXY_STATUS]);
    expect(status.enabled.value).toBe(false);
    // 关掉自动关闭后 alarm 已清，重拉回来的 autoOffAt 必须把旧的倒计时抹掉
    expect(status.autoOffAt.value).toBeUndefined();
  });

  it('总开关成功但重拉失败：本地那次写入留着，弹窗不许翻回旧状态', async () => {
    respond({
      [MessageType.TOGGLE_PROXY]: { success: true },
      [MessageType.GET_PROXY_STATUS]: () => {
        throw new Error('context invalidated');
      },
    });
    const status = useProxyStatus();
    // 开→关与关→开都必须钉：初值就是 false，只测「关掉」等于什么都没断言
    await status.toggleProxy(true);
    expect(status.enabled.value).toBe(true);
    expect(status.loading.value).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('总开关被拒：抛错、本地不改、也不去重拉', async () => {
    respond({
      [MessageType.GET_PROXY_STATUS]: makeStatus({ enabled: true }),
      [MessageType.TOGGLE_PROXY]: { success: false, error: 'TOGGLE_DENIED' },
    });
    const status = useProxyStatus();
    await status.fetchStatus();
    sendMessage.mockClear();

    await expect(status.toggleProxy(false)).rejects.toThrow('TOGGLE_DENIED');
    expect(status.enabled.value).toBe(true);
    expect(typesSent()).toEqual([MessageType.TOGGLE_PROXY]);
  });

  it('总开关遇到 undefined 回包：抛的是稳定码，不是读 undefined.enabled', async () => {
    respond({ [MessageType.TOGGLE_PROXY]: undefined });
    const status = useProxyStatus();
    await expect(status.toggleProxy(true)).rejects.toThrow('TOGGLE_PROXY_FAILED');
    expect(status.enabled.value).toBe(false);
  });

  it('单条规则：本地不就地改，成败之后各走各的', async () => {
    respond({
      [MessageType.GET_PROXY_STATUS]: makeStatus({ rules: [{ id: 'r1', name: 'fat→uat', enabled: false }] }),
      [MessageType.TOGGLE_RULE]: { success: true },
    });
    const status = useProxyStatus();
    await status.fetchStatus();
    expect(status.rules.value[0].enabled).toBe(false);
    sendMessage.mockClear();

    await status.toggleRule('r1', true);
    expect(typesSent()).toEqual([MessageType.TOGGLE_RULE, MessageType.GET_PROXY_STATUS]);
    // 重拉是唯一事实来源：这里仍是后台答回来的那一份，而不是刚传给 sendMessage 的 true
    expect(status.rules.value[0].enabled).toBe(false);
    expect(sendMessage.mock.calls[0][0]).toEqual({
      type: MessageType.TOGGLE_RULE,
      data: { ruleId: 'r1', enabled: true },
    });
  });

  it('单条规则被拒：抛错且不重拉，界面维持后台上一轮的答案', async () => {
    respond({
      [MessageType.GET_PROXY_STATUS]: makeStatus(),
      [MessageType.TOGGLE_RULE]: { success: false, error: 'RULE_DENIED' },
    });
    const status = useProxyStatus();
    await status.fetchStatus();
    sendMessage.mockClear();

    await expect(status.toggleRule('r1', false)).rejects.toThrow('RULE_DENIED');
    expect(typesSent()).toEqual([MessageType.TOGGLE_RULE]);
  });

  it('单条规则遇到 undefined 回包：抛的是稳定码，不是读 undefined.success', async () => {
    respond({ [MessageType.TOGGLE_RULE]: undefined });
    const status = useProxyStatus();
    await expect(status.toggleRule('r1', false)).rejects.toThrow('TOGGLE_RULE_FAILED');
    expect(typesSent()).toEqual([MessageType.TOGGLE_RULE]);
  });
});

describe('useProxyStatus — 「多久之前」用的是当前语言的文案', () => {
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  // `vi.useFakeTimers()` 把 `Date` 一起冻住了，所以这几个差值落在哪个档位是确定的。
  // 第四元是被查的 key：`t()` 未命中时返回 key 本身，那样两边会「相等而通过」，所以各
  // 档都另断言一句「字典真的答了话」（key 是否存在另有 `tests/i18n.test.ts` 扫源码守着）
  const cases: Array<[string, number, string, string]> = [
    ['刚才', 0, t('justNow'), 'justNow'],
    ['五分钟前', 5 * MINUTE, t('minutesAgo', '5'), 'minutesAgo'],
    ['三小时前', 3 * HOUR, t('hoursAgo', '3'), 'hoursAgo'],
    ['两天前', 2 * DAY, t('daysAgo', '2'), 'daysAgo'],
  ];

  it.each(cases)('%s：取的是 i18n 字典里那一句，不是 formatters 的 key 名', (_label, ago, expected, key) => {
    const status = useProxyStatus();
    expect(expected).not.toBe(key);
    expect(status.formatTimeAgo(Date.now() - ago)).toBe(expected);
  });
});

describe('两个 composable 与 Vue 生命周期的接线（本环境测不到的那半）', () => {
  const logSrc = readFileSync('composables/useRequestLog.ts', 'utf-8');
  const statusSrc = readFileSync('composables/useProxyStatus.ts', 'utf-8');

  it('日志：挂载即拉一次，卸载即停表', () => {
    expect(logSrc).toContain('onMounted(fetchLogs)');
    expect(logSrc).toContain('onUnmounted(stopTimer)');
  });

  it('状态：挂载即拉一次', () => {
    expect(statusSrc).toContain('onMounted(fetchStatus)');
  });
});

/**
 * 「没读到」这一格怎么被界面用（组件层没有 DOM，只能按源码契约钉）
 *
 * 两个 composable 交出来的旗标若在消费端没人读，就什么也没修好：首屏照旧把初值画成结论，
 * 日志照旧把非标回包念成「暂无请求记录」。这几条按源码钉住消费点，同时钉住「同一件事在
 * 这一屏说的是同一句话」——`—` 与 `statusUnknown` 是本仓既有的口径（`dnrTabHitsText`、
 * 自动关闭档位条），新读出的那几处不许各造一套说法。
 */
describe('两个旗标怎么被界面用（本环境测不到的那半）', () => {
  const popupSrc = readFileSync('entrypoints/popup/App.vue', 'utf-8');
  const drawerSrc = readFileSync('components/options/LogDrawer.vue', 'utf-8');
  const optionsSrc = readFileSync('components/options/App.vue', 'utf-8');

  it('弹窗：开关位置与规则数在没有读数时改口，不再画「已关闭 / 0 / 还没有规则」', () => {
    expect(popupSrc).toContain(
      "{{ statusEverRead ? (enabled ? t('statusEnabled') : t('statusDisabled')) : t('statusUnknown') }}",
    );
    expect(popupSrc).toContain("{{ statusEverRead ? rules.length : '—' }}");
    expect(popupSrc).toContain("{{ statusEverRead ? t('noRulesInPopup') : t('statusUnknown') }}");
    expect(popupSrc).toContain("{{ statusEverRead ? t('noRecentRequests') : t('statusUnknown') }}");
    // 「代理未开启，规则未生效」那句是结论：没有读数时整句不出现（不是换个说法）
    expect(popupSrc).toContain('v-if="!enabled && statusEverRead"');
  });

  it('弹窗：那两个数字各有一个只认「读到过」的出口，模板里没有裸读 `activeRuleCount`', () => {
    expect(popupSrc).toContain(
      "const activeRulesText = computed(() => (statusEverRead.value ? String(activeRuleCount.value) : '—'));",
    );
    expect(popupSrc).toContain(
      "const swRequestsText = computed(() => (statusEverRead.value ? String(swRequestCount.value) : '—'));",
    );
    // 渲染的是这两个 computed；`{{ activeRuleCount }}` 若被改回去，`—` 那一档当场消失
    expect(popupSrc).toContain('{{ activeRulesText }}');
    expect(popupSrc).toContain('{{ swRequestsText }}');
    expect(popupSrc).not.toMatch(/\{\{\s*activeRuleCount\s*\}\}/);
    expect(popupSrc).not.toMatch(/\{\{\s*swRequestCount\s*\}\}/);
  });

  it('日志抽屉：空表与非空表各说各的那一句，而两个布尔都从父组件接进来', () => {
    expect(drawerSrc).toContain('logsReadFailed: boolean;');
    expect(drawerSrc).toContain("{{ logsReadFailed ? t('logsReadFailed') : t('noLogs') }}");
    // 非空时那一行必须同时说出「没读到」和「下面是上一次的记录」——只说前者，读者仍会拿旧账当现状
    expect(drawerSrc).toMatch(
      /props\.logs\.length > 0 \? `\$\{t\('logsReadFailed'\)\} · \$\{t\('logsReadStale'\)\}` : t\('logsReadFailed'\)/,
    );
    expect(drawerSrc).toContain('v-if="logsReadFailedText"');
    expect(optionsSrc).toContain(':logs-read-failed="logsReadFailed"');
  });
});
