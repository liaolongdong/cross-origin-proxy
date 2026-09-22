import type { InterceptorStatsEntry } from '@/utils/types';

/**
 * 拦截器自报计数的可渲染状态（界面侧唯一的判据入口）
 *
 * 收在一个纯函数里的理由与 `describeDnrSample` 同一条教训：**「不知道」和「没有」不能共用一句**。
 * 五种状态各说各的话：`noData` 是这个标签页既没上报过、后台也没替它发过请求（**不等于**「代理没生效」），
 * `noReport` 是代发过但还没有任何一份自报被采信（SW 回收后重新代发、页面只来得及发请求没来得及上报，
 * 或上报包全被判矛盾拒收），`fellBack` / `timedOut` / `active` 是三条不同的结论——
 * 有请求没走代理时说成「都走了代理」是谎报，一个都没等到响应时说成「一切正常」也是谎报。
 * 说错任何一句都会把用户引向错误的排查方向。
 */
export type InterceptorViewState =
  /** SW 对这个标签页一无所知（既没收到自报，也没代发过请求） */
  | 'noData'
  /** 后台确实代发过请求，但还没有任何一份自报读数被采信 */
  | 'noReport'
  /** 有读数，且有请求回退成了原生请求——这一页有请求**没走**代理 */
  | 'fellBack'
  /** 有读数，且有请求交给后台后代发超时（没等到响应） */
  | 'timedOut'
  /** 有读数，且拦到的请求都交给了后台、也没有代发超时 */
  | 'active';

export interface InterceptorStatsView {
  state: InterceptorViewState;
  /** `null` = 没有可信读数，UI 不得把 0 当成「一个都没拦到」画出来 */
  stats: InterceptorStatsEntry | null;
}

/**
 * 结构完整性判定：六个字段必须都是数字。
 *
 * SW 异常时回的是 `{ success: false }` 之类的非标载荷——缺字段就返回 false，
 * 于是界面落到 `noData`（整行按需不显示），绝不能把「读不到」当成「四个 0」画出来。
 */
export function isInterceptorStatsEntry(value: unknown): value is InterceptorStatsEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<InterceptorStatsEntry>;
  return (
    typeof entry.intercepted === 'number' &&
    typeof entry.proxied === 'number' &&
    typeof entry.fellBack === 'number' &&
    typeof entry.timedOut === 'number' &&
    typeof entry.updatedAt === 'number' &&
    typeof entry.swProxied === 'number'
  );
}

/**
 * 把一次读取回答成 UI 能直接用的形态。
 * @param value `GET_INTERCEPTOR_STATS` 的原始响应（可能为 null / 非标载荷），故内部先做结构判定
 */
export function describeInterceptorStats(value: unknown): InterceptorStatsView {
  if (!isInterceptorStatsEntry(value)) return { state: 'noData', stats: null };
  if (value.updatedAt === 0) return { state: value.swProxied > 0 ? 'noReport' : 'noData', stats: value };
  if (value.fellBack > 0) return { state: 'fellBack', stats: value };
  // 回退优先：一条规则既不把请求交给代理、又没等到响应时，「没走代理」是更该先说的那一件
  if (value.timedOut > 0) return { state: 'timedOut', stats: value };
  return { state: 'active', stats: value };
}
