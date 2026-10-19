import { MAX_SITE_STATE_HOSTS } from '@/utils/constants';
import type { SiteScopeMode, SiteState } from '@/utils/types';

/**
 * 站点维度的生效范围：总开关之外，「这一台站点要不要代理」的唯一判据出口
 *
 * 今天用户只有两个档位——总开关，和逐条规则的启停。在同机既要 `fat.example.com` 走代理、又要
 * 生产页面完全不受影响时，只能来回翻弹窗开关，而规则本身没问题、被误伤的却是另一个站点。
 * 这一层就是那个缺失的中间档。
 *
 * **键是主机名，不是 origin**——这不是省事，是被两条通道的能力边界逼出来的：网络层
 * （`declarativeNetRequest`）的 initiator 条件只认域名（且按官方文档连子域一起算），既不看端口
 * 也不看协议。如果扩展侧按 `http://localhost:3000` 记，就会出现在同一台站点上 `:3000` 被关掉、
 * `:4000` 仍被网络层改写——正是本仓最贵的那类「两通道分叉」。所以判定两侧共用这一份主机口径：
 * 记 `localhost` 就是整台 localhost，记 `fat.example.com` 含它的子域。界面上那句话必须把
 * 「端口与协议不分家、含子域」说清，不能让用户以为能按端口分。
 *
 * 纯函数、不碰 `chrome`：判定要给 SW、DNR 规则构建与存储层共用一份。
 *
 * 类型定义在 `utils/types.ts`（`SiteScopeMode` / `SiteState`），这里只放判据。
 */

export const DEFAULT_SITE_STATE: SiteState = { mode: 'all', hosts: [] };

/** 一条主机名条目：只允许 ASCII、字母数字与 `.` `-` `_`，且至少有一个点或就是 `localhost` */
const HOST_RE = /^[a-z0-9._-]+$/;

function normalizeHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (!host || !HOST_RE.test(host)) return null;
  // 带协议或端口的串不是主机：宁可丢掉，也不「顺手」拆一遍——拆法与网络层不一致就是分叉的开始
  if (host.includes('://') || host.includes(':') || host.includes('/') || host.includes('*')) return null;
  if (host !== 'localhost' && !host.includes('.')) return null;
  return host;
}

/**
 * 从一个 URL 里取**网页**主机名（读不出、或根本不是 http(s) 页就回空串）
 *
 * 三处要用同一件东西：DNR 同步时从 tab.url、桥接拉配置时从 sender.tab.url、代发前从 sender.url。
 * 各写一份 `new URL()` 就会有一处忘了 try/catch。刻意不把 `chrome://extensions`（主机名解析得出
 * `chrome`）或扩展页当成一台站点——那一格开关只对网页有意义，把内部页画进去就是凭空多一个可点档位。
 */
export function hostnameOf(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

/** `hostname` 是否落在 `host` 这一档里（含子域，与 DNR 的 initiatorDomains 同口径） */
function hostMatches(host: string, hostname: string): boolean {
  return hostname === host || hostname.endsWith(`.${host}`);
}

/**
 * 把 storage 原文收成可用状态：读不出模式或整个名单不合法时一律回落默认值。
 *
 * 与 `configRules()` / `sanitizeRecentTargets()` 同一族口径——「读不出」当空处理，
 * 而不是抛出去把代理整个弄坏；也不修补成「看起来像」的值。
 */
export function sanitizeSiteState(raw: unknown): SiteState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { mode: 'all', hosts: [] };
  const value = raw as { mode?: unknown; hosts?: unknown };
  const mode: SiteScopeMode = value.mode === 'site-off' || value.mode === 'site-only' ? value.mode : 'all';
  const hosts: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value.hosts)) {
    for (const entry of value.hosts) {
      const host = normalizeHost(entry);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      hosts.push(host);
      if (hosts.length >= MAX_SITE_STATE_HOSTS) break;
    }
  }
  // 「仅此站点」却没有名单 = 一台都不代理：这不是用户意图，是坏数据，交回默认值更安全
  if (mode === 'site-only' && hosts.length === 0) return { mode: 'all', hosts: [] };
  return { mode, hosts };
}

/**
 * 这台主机要不要走代理（两条通道的 SW 侧、页面侧配置收窄共用这一句）
 *
 * @param state 已 sanitize 的状态
 * @param hostname 请求**发起页**的主机名（不是被请求 URL 的主机名）
 */
export function siteAllows(state: SiteState, hostname: string): boolean {
  if (state.mode === 'all') return true;
  const host = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
  if (!host) return state.mode === 'site-off'; // 读不出发起页：只认「没有站点被停用」这一侧，不做推断
  const hit = state.hosts.some(entry => hostMatches(entry, host));
  return state.mode === 'site-off' ? !hit : hit;
}

/**
 * 该状态在 DNR 规则条件上的体现；`all` 返回空对象，产出的规则与这层不存在时逐字节相同
 *
 * 只在这台清单非空时才写条件：`excludedInitiatorDomains: []` 按官方文档等价于「不排除」，
 * 但把它写进每一条规则会让规则原文与历史不一致，也让「未生效」标记那条判读多一个空档。
 */
export function dnrInitiatorCondition(state: SiteState): Record<string, string[]> {
  if (state.mode === 'all' || state.hosts.length === 0) return {};
  return state.mode === 'site-off'
    ? { excludedInitiatorDomains: [...state.hosts] }
    : { initiatorDomains: [...state.hosts] };
}

/**
 * 这条规则集在这台主机上还剩哪些（下发给某个标签页的配置按发起页主机收窄）
 *
 * 收窄而不是拒绝：复杂规则那条通道由页面侧拦截器决定要不要问后台，把不该生效的规则从它拿到的
 * 配置里摘掉，行为就是「这台站点上它不存在」，回退路径保持原生请求。
 */
export function rulesForSite<T>(rules: T[], state: SiteState, hostname: string): T[] {
  if (state.mode === 'all') return rules;
  if (siteAllows(state, hostname)) return rules;
  return [];
}

/**
 * 把「这台主机要不要走代理」这一句意图翻译成新的状态（弹窗那颗开关的唯一写法）
 *
 * 为什么不能只往名单里加/删：名单在两种模式里含义相反（`site-off` 里是「排除」、`site-only` 里是
 * 「白名单」）。界面说的是结果——「这一台站点走不走代理」——所以翻译必须由判据这一侧做，
 * 否则同一句「打开开关」在两种模式下会给出相反的结果，而界面只画了一个开关。
 *
 * 不改入参；`mode` 在用户没有明确换档意图时保持不变，包括从 `all` 变出去的那一步。
 */
export function withHostActive(state: SiteState, host: unknown, active: boolean): SiteState {
  const normalized = normalizeHost(host);
  if (!normalized) return sanitizeSiteState(state);
  const current = sanitizeSiteState(state);
  const without = current.hosts.filter(entry => entry !== normalized);
  if (current.mode === 'all') {
    // 这一层本来不参与：要让它不生效，只能把这台站点放进排除名单
    return active ? current : { mode: 'site-off', hosts: [normalized] };
  }
  if (current.mode === 'site-off') {
    const hosts = active ? without : [...without, normalized].sort();
    return hosts.length === 0
      ? { mode: 'all', hosts: [] }
      : { mode: 'site-off', hosts: hosts.slice(0, MAX_SITE_STATE_HOSTS) };
  }
  const hosts = active ? [...without, normalized].sort() : without;
  if (hosts.length === 0) {
    // 白名单被清空 = 一台都不代理，那不是用户点这一下的意思：交回「全部站点」这一档更安全
    return { mode: 'all', hosts: [] };
  }
  return { mode: 'site-only', hosts: hosts.slice(0, MAX_SITE_STATE_HOSTS) };
}

/** 从名单里删掉一台（设置页那颗删除）。删空时回到 `all`——留一个空的白名单不是任何人的意图 */
export function withoutHost(state: SiteState, host: unknown): SiteState {
  const normalized = normalizeHost(host);
  const current = sanitizeSiteState(state);
  if (!normalized) return current;
  const hosts = current.hosts.filter(entry => entry !== normalized);
  if (hosts.length === 0) return { mode: 'all', hosts: [] };
  return { mode: current.mode, hosts };
}
