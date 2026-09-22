import { INTERCEPTOR_TAB_CACHE_SIZE } from '@/utils/constants';
import { logger } from '@/utils/logger';
import type { InterceptorStats, InterceptorStatsEntry } from '@/utils/types';

/**
 * 拦截器自报计数的落脚点 —— 回答「这一页到底有没有被拦」
 *
 * 为什么需要它：复杂规则一次没拦到时，界面只有「后台计数 0」，而它与「这个页面本来没请求」
 * 完全同形；回退原生更是只有一条 `console.warn`。这四个数是拦截器自身成败的唯一出口
 * （日志只记过桥之后的请求，DNR 采样只覆盖网络层通道）。
 *
 * 全部状态都是模块级的，**SW 回收即清零**：窗口本来就是「该标签页本次文档」，
 * 而且把页面可伪造的数字持久化到 storage 毫无意义（还会让它看起来像事实）。
 *
 * 可信度只有三档防护，都不指望根治（详见 spec 的 R1）：
 * 1. 这条消息不写 storage、不进 `STATE_MUTATING_TYPES`、不参与规则匹配；
 * 2. 进 SW 后三道判据，任一不过整包丢弃：字段合法性、包内自洽（含「全 0 不采信」）、
 *    与 SW 自己数到的代发数交叉校验；
 * 3. 界面措辞始终是「页面自报」——与基线自洽的假数这三道都拦不住。
 */

/** 单个标签页的状态：最近一次被采信的自报值 + SW 侧数到的代发数（交叉校验的参照） */
interface TabState {
  stats: InterceptorStats;
  /** SW 收到该包的本机时刻（epoch ms） */
  updatedAt: number;
  /** SW 自己从这个标签页收到的 `PROXY_REQUEST` 数 */
  swProxied: number;
}

const tabStates = new Map<number, TabState>();

/** 非负有限数才要，小数向下取整；其余（NaN、字符串、负数）一律 null */
function countOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * 把任意载荷收成四个计数
 *
 * 任一字段非法即**整包丢弃**：画「3 个回退、代发数缺失」这种半成品比什么都不画更容易误导。
 */
function readStats(payload: unknown): InterceptorStats | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  const intercepted = countOf(raw.intercepted);
  const proxied = countOf(raw.proxied);
  const fellBack = countOf(raw.fellBack);
  const timedOut = countOf(raw.timedOut);
  if (intercepted === null || proxied === null || fellBack === null || timedOut === null) return null;
  return { intercepted, proxied, fellBack, timedOut };
}

function writeState(tabId: number, state: TabState): void {
  // 先删再设，让「插入序」等于「最近写入序」，逐出的是最久没动静的那个标签页
  tabStates.delete(tabId);
  tabStates.set(tabId, state);
  while (tabStates.size > INTERCEPTOR_TAB_CACHE_SIZE) {
    const oldest = tabStates.keys().next().value;
    if (oldest === undefined) break;
    tabStates.delete(oldest);
  }
}

/**
 * 记下某个标签页自报的计数
 *
 * @param tabId 来自 `sender.tab?.id`，即 Chrome 认定的发送者标签页；页面伪造不了它
 * @param payload 页面给的四个数（不可信）
 * @returns 是否被采信（false = 载荷非法、包内自相矛盾、或低于 SW 侧代发基准，界面会维持上一次的显示）
 */
export function recordInterceptorStats(tabId: number | undefined, payload: unknown): boolean {
  if (typeof tabId !== 'number') return false;
  const stats = readStats(payload);
  if (!stats) return false;

  const previous = tabStates.get(tabId);
  // 包内自洽性：`intercepted` 是另外三个数的父集，`timedOut` 只在交给后台之后才可能发生。
  // 真实的四个数天然满足（`bump('intercepted')` 在两条通道的命中处各一次，`proxied` 与
  // `timedOut` 都在其后的 `proxyFetch` 里），所以这条不会拒掉任何诚实的包，
  // 只挡住「拦到 0 个、其中 9 个交给后台」这种自相矛盾、画出来只会误导排查方向的句子。
  if (stats.proxied > stats.intercepted || stats.fellBack > stats.intercepted || stats.timedOut > stats.proxied) {
    logger.debug(`Interceptor stats dropped (self-contradictory) for tab ${tabId}`);
    return false;
  }
  // 四个数全 0 的包没有信息量，而它会盖掉上一条真读数、把界面画成绿色的「拦到 0 个请求」——
  // 诚实路径永远发不出这种包（`reportStats` 只由 `bump` 触发），所以能发出来的只有同页脚本。
  if (stats.intercepted === 0) {
    logger.debug(`Interceptor stats dropped (all-zero) for tab ${tabId}`);
    return false;
  }
  // 交叉校验：页面自报的「拦到 / 代发」不可能少于 SW 亲手数到的代发数。
  // 低于基线即整包丢弃——这一类自相矛盾的假包盖不掉真读数；
  // 与基线自洽的假数仍会采信（详见 spec 的 R1），所以界面措辞永远是「页面自报」。
  const swProxied = previous?.swProxied ?? 0;
  if (stats.proxied < swProxied || stats.intercepted < swProxied) {
    logger.debug(`Interceptor stats dropped (below SW-proxied ${swProxied}) for tab ${tabId}`);
    return false;
  }

  writeState(tabId, { stats, updatedAt: Date.now(), swProxied });
  return true;
}

/**
 * 累加 SW 从这个标签页实际收到的代发请求数（交叉校验的参照）
 *
 * 刻意只数「过桥到 SW 的请求」：它是本模块唯一不受页面影响的计数，才有资格当基准。
 */
export function countProxyRequestForTab(tabId: number | undefined): void {
  if (typeof tabId !== 'number') return;
  const previous = tabStates.get(tabId);
  if (previous) {
    writeState(tabId, { ...previous, swProxied: previous.swProxied + 1 });
    return;
  }
  // 还没有任何自报计数（例如 SW 刚回收，或页面只发了请求没来得及上报）：
  // 先建一条「全 0 但还没被上报过」的壳，只用于累加基准，读端会把它当没有数据
  writeState(tabId, { stats: { intercepted: 0, proxied: 0, fellBack: 0, timedOut: 0 }, updatedAt: 0, swProxied: 1 });
}

/**
 * 读某个标签页最近一次被采信的自报计数
 * @returns 完全没有这个标签页的任何信息时返回 null；只有代发数基准（`updatedAt === 0`）时
 * 返回全 0 的 `stats` 加上真实的 `swProxied`，让界面能说清「后台代发过、拦截器还没回报」
 */
export function getInterceptorStats(tabId: number): InterceptorStatsEntry | null {
  const state = tabStates.get(tabId);
  if (!state) return null;
  return { ...state.stats, updatedAt: state.updatedAt, swProxied: state.swProxied };
}

/** 丢掉某个标签页的读数（关闭标签页、或文档被替换） */
export function clearInterceptorStats(tabId: number): void {
  tabStates.delete(tabId);
}

/** 单测用：清掉全部状态 */
export function clearAllInterceptorStats(): void {
  tabStates.clear();
}

/**
 * 注册生命周期钩子
 *
 * 两个事件都不是可选的：
 * - `onRemoved`：不留住已关闭标签页的读数（缓存上限只是漏事件的兜底）；
 * - `onUpdated` 的 `loading`：页面导航会把这个文档的计数归零，而 SW 侧的基准数是跨导航累加的。
 *   不一起清掉，新文档第一次上报必然「小于基准」而被交叉校验丢弃，popup 会一直显示旧读数。
 */
export function setupInterceptorStats(): void {
  chrome.tabs.onRemoved.addListener(tabId => clearInterceptorStats(tabId));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') clearInterceptorStats(tabId);
  });
}
