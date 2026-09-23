/**
 * 「这一页在调哪些接口」——从页面自己的资源计时里挑出候选来源
 *
 * 为什么需要它：popup 那个「为本页创建规则」按**页面文档地址**预填通配符规则，可用户要代理的
 * 常常不是文档本身，而是这一页发出去的那些接口请求（报 CORS 的也正是它们）。预填错了 origin，
 * 用户得先把草稿删对再填对，而「这一页在调谁」这件事页面自己知道，本该由工具来说。
 *
 * 判据与 IO 分开：`entrypoints/content.ts` 只负责在页面里读一次
 * `performance.getEntriesByType('resource')` 并把本函数的结果同步回给 popup；本模块不碰
 * `chrome.*`、不读全局，所以排序、过滤与回包校验都能脱离浏览器单测。
 *
 * 两条刻意的收窄：
 * 1. **只回 origin 与条数**。路径与查询串常带着 id、token，而一条 origin 通配符规则用不到它们。
 * 2. **只认 fetch / XHR 两类发起类型**。图片、脚本、字体不是要代理的对象，列进来只会挤掉那一条。
 *
 * 它给出的只是候选，不是结论：资源计时有浏览器自己的容量上限（超出后丢最早的条目），
 * 也看不见被页面自己拦下、压根没发出的请求，所以「没列出来」永远不等于「没在调」。
 */

/** 一条资源计时条目里本模块用到的部分（`PerformanceEntry` 结构上即可赋值） */
export interface ResourceTimingLike {
  /** 资源地址 */
  name: string;
  /** 发起类型；`fetch()` 与 `XMLHttpRequest` 分别报 `fetch` / `xmlhttprequest`（旧版本 Chrome 把 fetch 也报成后者） */
  initiatorType?: string;
}

/** 一个候选接口来源：origin 与这一页对它的请求条数 */
export interface PageApiOrigin {
  origin: string;
  count: number;
}

/** 只把这两类发起类型当「接口调用」 */
const API_INITIATOR_TYPES: readonly string[] = ['fetch', 'xmlhttprequest'];

/**
 * 默认列出的来源数上限
 *
 * popup 宽 320px，一屏放得下的候选才有点击价值；同页真实接口常常只有 1~3 个 origin，
 * 这个数只是挡住「一个埋点密集的页面把卡片撑成一列」。
 */
export const PAGE_API_ORIGIN_LIMIT = 6;

/**
 * 把页面的资源计时条目收成「origin → 请求条数」的候选清单
 *
 * 排序是条数降序、同源并列时按 origin 升序：后者保证同一份输入永远得到同一个列表
 * （`Map` 的插入序随页面加载顺序变化，不稳定排序会把换序画成界面在抖动）。
 *
 * @param entries 页面自己的资源计时条目
 * @param limit 最多列出几个来源
 */
export function summarizeApiOrigins(
  entries: readonly ResourceTimingLike[],
  limit: number = PAGE_API_ORIGIN_LIMIT,
): PageApiOrigin[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!API_INITIATOR_TYPES.includes(entry?.initiatorType ?? '')) continue;
    const origin = apiOriginOf(entry.name);
    if (!origin) continue;
    counts.set(origin, (counts.get(origin) ?? 0) + 1);
  }
  return [...counts]
    .map(([origin, count]) => ({ origin, count }))
    .sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin))
    .slice(0, limit);
}

/**
 * 校验 popup 收到的回包，只留下结构合法的条目
 *
 * 与 `isDnrSample` / `isConfigSyncStatus` 同一类边界判定：界面永远不给一条画不出来的数据。
 * 这里的粒度是**逐条**而不是整包——一行候选彼此无关，丢掉一条非法项不会让其余说错话
 * （拦截器自报那四个数必须整包丢弃，是因为它们要彼此自洽才讲得通）。
 * 长度同样收口：越界的多出来的条目直接不要。
 */
export function parsePageApiOrigins(value: unknown): PageApiOrigin[] {
  const raw = (value as { origins?: unknown } | null | undefined)?.origins;
  if (!Array.isArray(raw)) return [];
  const parsed: PageApiOrigin[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { origin, count } = item as Partial<PageApiOrigin>;
    // 收进来的是**归一化后**的 origin：一条带路径或查询串的回包不该把那些内容画到界面上，
    // 更不该跟着下一次点击进 Options。
    const normalized = typeof origin === 'string' ? apiOriginOf(origin) : '';
    if (!normalized) continue;
    if (!Number.isInteger(count) || (count as number) < 1) continue;
    parsed.push({ origin: normalized, count: count as number });
    if (parsed.length >= PAGE_API_ORIGIN_LIMIT) break;
  }
  return parsed;
}

/**
 * 取一个地址的 http(s) origin，不合法或非 http(s)（含 `null` 这种不透明 origin）一律返回空串
 *
 * 判据只有这一处：条目侧与回包侧都走它，于是「popup 能列出来的地址」与
 * 「Options 能快速建规则的地址」（`handleCreateRuleFromUrl` 同样只认 http/https）是同一件事。
 */
function apiOriginOf(address: string): string {
  if (typeof address !== 'string' || !address) return '';
  try {
    const url = new URL(address);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}
