import type { DnrSample } from '@/utils/types';

/**
 * `DnrSample` 的可渲染状态（UI 侧唯一的三态判据入口）
 *
 * 后台采样器已经把「没有读数」与「读数不可信」编码进 `sampledAt === 0` + `stale`
 * 两个字段，但这两个原始字段一旦散进各入口就会被读歪：popup 曾把「没有生效的网络层
 * 规则」和「配额用尽」合并成同一句「统计暂不可用」，options 侧则完全不看 `sampledAt`，
 * 把「没读到」当成空数组渲染成「近 5 分钟无命中」——把未知伪装成零，正是这批改动要
 * 消灭的那类谎报。判据收在这一个纯函数里，UI 只负责把 state 映射成文案。
 */
export type DnrSampleState =
  /** 还没拿到过结构完整的响应（首次采样在途，或 SW 回了非标载荷） */
  | 'pending'
  /** 没有生效的动态规则（代理总开关关闭，或规则全走后台通道）——不是读不到 */
  | 'notApplicable'
  /** 该读但读不到：配额用尽 / 退避中 / API 抛错，且没有任何缓存可退回 */
  | 'unavailable'
  /** 有读数，但只是上一次的结果 */
  | 'stale'
  /** 有读数且新鲜 */
  | 'fresh';

export interface DnrSampleView {
  state: DnrSampleState;
  /** `null` = 没有读数，UI 据此画「—」而不是 0；有读数时为各规则命中之和 */
  hits: number | null;
}

/** 结构完整性判定：SW 异常时回的是 `{ success: false }`，那种非标载荷不得覆盖已有读数 */
export function isDnrSample(value: unknown): value is DnrSample {
  if (!value || typeof value !== 'object') return false;
  const sample = value as Partial<DnrSample>;
  return Array.isArray(sample.stats) && typeof sample.sampledAt === 'number';
}

/**
 * 该状态下，网络层计数是否可以当作「命中次数」画成数字
 *
 * `notApplicable` / `unavailable` / `pending` 三种状态下的 0 都是「不知道」，画成 0 就是
 * 把未知伪装成零——与 `describeDnrSample` 用 `hits: null` 表达的是同一件事，
 * 供按规则渲染的视图（规则列表命中列）复用，避免各入口各写一份判据。
 */
export function isDnrCountReadable(state: DnrSampleState): boolean {
  return state === 'fresh' || state === 'stale';
}

/**
 * 把一次采样回答成 UI 能直接用的形态。
 * @param value `GET_DNR_STATS` 的原始响应，类型不可信，故内部先做结构判定
 */
export function describeDnrSample(value: unknown): DnrSampleView {
  if (!isDnrSample(value)) return { state: 'pending', hits: null };

  const hits = value.stats.reduce((sum, stat) => sum + (stat?.hitCount ?? 0), 0);
  if (value.sampledAt === 0) {
    return value.stale ? { state: 'unavailable', hits: null } : { state: 'notApplicable', hits: null };
  }
  return value.stale ? { state: 'stale', hits } : { state: 'fresh', hits };
}
