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
 * 记账粒度是 `(tabId, frameId)`，读取粒度是 `tabId`：内容脚本注入到子 frame 之后，
 * 每个 frame 的拦截器只数得到自己那四个数，而 `PROXY_REQUEST` 是跨 frame 汇到同一个标签页的。
 * 若基准也按标签页汇，iframe 那份诚实的 `proxied: 1` 会被顶层已代发的 3 笔判成谎话而整包丢弃，
 * popup 那一行从此冻结在顶层的旧读数上。所以基线各 frame 各记一本，读端再把它们加起来——
 * 界面说的仍是「这一页」，交叉校验守的却是「这个 frame 有没有少报自己代发的数」。
 *
 * 可信度只有三档防护，都不指望根治（详见 spec 的 R1）：
 * 1. 这条消息不写 storage、不进 `STATE_MUTATING_TYPES`、不参与规则匹配；
 * 2. 进 SW 后三道判据，任一不过整包丢弃：字段合法性、包内自洽（含「全 0 不采信」）、
 *    与本 frame 代发数基准的交叉校验；
 * 3. 界面措辞始终是「页面自报」——与基线自洽的假数这三道都拦不住。
 */

/** 单个 frame 的状态：最近一次被采信的自报值 + SW 侧数到的该 frame 代发数（交叉校验的参照） */
interface FrameState {
  stats: InterceptorStats;
  /** SW 收到该包的本机时刻（epoch ms），`0` = 还没采信过任何自报 */
  updatedAt: number;
  /** SW 自己从这个 frame 收到的 `PROXY_REQUEST` 数 */
  swProxied: number;
}

/** 标签页 → (frame → 状态)。外层 Map 的插入序即「该页最近有没有动静」，容量与清理都按标签页计。 */
const tabStates = new Map<number, Map<number, FrameState>>();

/**
 * `sender.frameId` 由 Chrome 写入（顶层 frame 为 `0`），取不到时按顶层记账。
 * 刻意不与「真正的顶层」区分：多分一本账就是把基准拆薄，反而更容易误杀诚实的自报。
 */
function frameOf(frameId: number | undefined): number {
  return typeof frameId === 'number' ? frameId : 0;
}

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

function writeFrame(tabId: number, frameId: number, state: FrameState): void {
  const frames = tabStates.get(tabId) ?? new Map<number, FrameState>();
  frames.set(frameId, state);
  // 先删再设外层，让「插入序」等于「最近写入序」，逐出的是最久没动静的那个标签页；
  // 容量按标签页计——一个页面开三个 frame 也只占一个位置。
  tabStates.delete(tabId);
  tabStates.set(tabId, frames);
  while (tabStates.size > INTERCEPTOR_TAB_CACHE_SIZE) {
    const oldest = tabStates.keys().next().value;
    if (oldest === undefined) break;
    tabStates.delete(oldest);
  }
}

/**
 * 记下某个 frame 自报的计数
 *
 * @param tabId 来自 `sender.tab?.id`，即 Chrome 认定的发送者标签页；页面伪造不了它
 * @param frameId 来自 `sender.frameId`，同样由 Chrome 写入；取不到按顶层 frame 记账（见 `frameOf`）
 * @param payload 页面给的四个数（不可信）
 * @returns 是否被采信（false = 载荷非法、包内自相矛盾、或低于本 frame 的代发基准，界面会维持上一次的显示）
 */
export function recordInterceptorStats(
  tabId: number | undefined,
  frameId: number | undefined,
  payload: unknown,
): boolean {
  if (typeof tabId !== 'number') return false;
  const stats = readStats(payload);
  if (!stats) return false;

  const frame = frameOf(frameId);
  const previous = tabStates.get(tabId)?.get(frame);
  // 包内自洽性：`intercepted` 是另外三个数的父集，`timedOut` 只在交给后台之后才可能发生。
  // 真实的四个数天然满足（`bump('intercepted')` 在两条通道的命中处各一次，`proxied` 与
  // `timedOut` 都在其后的 `proxyFetch` 里），所以这条不会拒掉任何诚实的包，
  // 只挡住「拦到 0 个、其中 9 个交给后台」这种自相矛盾、画出来只会误导排查方向的句子。
  if (stats.proxied > stats.intercepted || stats.fellBack > stats.intercepted || stats.timedOut > stats.proxied) {
    logger.debug(`Interceptor stats dropped (self-contradictory) for tab ${tabId} frame ${frame}`);
    return false;
  }
  // 四个数全 0 的包没有信息量，而它会盖掉上一条真读数、把界面画成绿色的「拦到 0 个请求」——
  // 诚实路径永远发不出这种包（`reportStats` 只由 `bump` 触发），所以能发出来的只有同页脚本。
  if (stats.intercepted === 0) {
    logger.debug(`Interceptor stats dropped (all-zero) for tab ${tabId} frame ${frame}`);
    return false;
  }
  // 交叉校验：这个 frame 自报的「拦到 / 代发」不可能少于 SW 亲手数到、从同一个 frame 收到的代发数。
  // 低于基线即整包丢弃——这一类自相矛盾的假包盖不掉真读数；
  // 与基线自洽的假数仍会采信（详见 spec 的 R1），所以界面措辞永远是「页面自报」。
  const swProxied = previous?.swProxied ?? 0;
  if (stats.proxied < swProxied || stats.intercepted < swProxied) {
    logger.debug(`Interceptor stats dropped (below SW-proxied ${swProxied}) for tab ${tabId} frame ${frame}`);
    return false;
  }

  writeFrame(tabId, frame, { stats, updatedAt: Date.now(), swProxied });
  return true;
}

/**
 * 累加 SW 从某个 frame 实际收到的代发请求数（该 frame 交叉校验的基准）
 *
 * 刻意只数「过桥到 SW 的请求」：它是本模块唯一不受页面影响的计数，才有资格当基准。
 */
export function countProxyRequestForTab(tabId: number | undefined, frameId: number | undefined): void {
  if (typeof tabId !== 'number') return;
  const frame = frameOf(frameId);
  const previous = tabStates.get(tabId)?.get(frame);
  if (previous) {
    writeFrame(tabId, frame, { ...previous, swProxied: previous.swProxied + 1 });
    return;
  }
  // 还没有任何自报计数（例如 SW 刚回收，或页面只发了请求没来得及上报）：
  // 先建一条「全 0 但还没被上报过」的壳，只用于累加基准，读端会把它当没有数据
  writeFrame(tabId, frame, {
    stats: { intercepted: 0, proxied: 0, fellBack: 0, timedOut: 0 },
    updatedAt: 0,
    swProxied: 1,
  });
}

/**
 * 读某个标签页（含其全部 frame）最近一次被采信的自报计数
 *
 * 各 frame 的四个数相加、`swProxied` 相加、`updatedAt` 取最近一次被采信的时刻：界面那一行说的是
 * 「这一页」，所以合账；分账只用于交叉校验。还没被采信过的 frame 只贡献基准数、不贡献四个数。
 *
 * @returns 完全没有这个标签页的任何信息时返回 null；只有代发数基准（`updatedAt === 0`）时
 * 返回全 0 的 `stats` 加上真实的 `swProxied`，让界面能说清「后台代发过、拦截器还没回报」
 */
export function getInterceptorStats(tabId: number): InterceptorStatsEntry | null {
  const frames = tabStates.get(tabId);
  if (!frames) return null;
  const merged: InterceptorStatsEntry = {
    intercepted: 0,
    proxied: 0,
    fellBack: 0,
    timedOut: 0,
    updatedAt: 0,
    swProxied: 0,
  };
  frames.forEach(state => {
    merged.intercepted += state.stats.intercepted;
    merged.proxied += state.stats.proxied;
    merged.fellBack += state.stats.fellBack;
    merged.timedOut += state.stats.timedOut;
    merged.swProxied += state.swProxied;
    merged.updatedAt = Math.max(merged.updatedAt, state.updatedAt);
  });
  return merged;
}

/** 丢掉某个标签页全部 frame 的读数（关闭标签页、或文档被替换） */
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
 *
 * 已知边界：`tabs.onUpdated` 只跟主框架的导航，**iframe 单独换文档**时那本 frame 账不会复位，
 * 它第一次上报会被自己的旧基准判成矛盾而丢弃，界面因此维持上一次被采信的读数（陈旧，但不是假数），
 * 直到整页导航或标签页关闭才收回。刻意不为此加 `webNavigation` 权限，也不加「小于基准即复位」的
 * 启发式——后者等于让伪造者先发包小数字就能清掉基准。
 */
export function setupInterceptorStats(): void {
  chrome.tabs.onRemoved.addListener(tabId => clearInterceptorStats(tabId));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') clearInterceptorStats(tabId);
  });
}
